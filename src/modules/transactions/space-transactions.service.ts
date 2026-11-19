import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import type { CreateTransactionV2Dto, UpdateTransactionV2Dto } from './dto/transaction-v2.dto';
import type { TransactionCountQueryV2Dto, TransactionFeedQueryV2Dto } from './dto/transaction-feed-query-v2.dto';
import type { TransactionCount } from './dto/transaction-responses';
import type {
  AssigneeOption,
  TransactionAssignees,
  TransactionFeedV2,
  TransactionOperationViewV2,
  TransactionResultV2,
  TransactionViewV2,
} from './dto/transaction-v2-responses';
import { toTransactionViewV2 } from './transaction-view';
import { normalizeDescription } from './transaction-rules';
import { assertNotSystem, assertUserCategory, assertVersion } from './transaction-checks';
import { assertNewValues, changedFields } from './transaction-changes';
import { assertAssigneeIsMember, assigneeOf, toAssignmentColumns } from './transaction-assignment';
import { TransactionWrites, type WriteOptions, requireVersion } from './transaction-writes';
import { TransactionFeedReader } from './transaction-feed-reader';
import { ApiException } from '@shared/api.exception';
import { AssignmentKind, PersonStatus, TransactionOperationStatus } from '@shared/enums';
import { recordedAuthor } from '@shared/transaction-ownership';
import { assertFound, readSnapshot, resolveTimeZone, toDate } from '@shared/utils';
import {
  TransactionQueriesService,
  type LoadedTransaction,
  type SpacePerson,
  type TransactionSelection,
} from '@modules/transaction-queries/transaction-queries.service';
import { memberKey, parseAssignmentFilter } from '@modules/transaction-queries/assignment-filter';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { CategoriesService } from '@modules/categories/categories.service';

function toSelection(spaceId: number, query: TransactionCountQueryV2Dto): TransactionSelection {
  return {
    spaceId,
    from: toDate(query.from),
    to: toDate(query.to),
    filters: {
      transactionType: query.transaction_type,
      kind: query.kind,
      categoryId: query.category_id,
      assignment: query.assignment === undefined ? undefined : parseAssignmentFilter(query.assignment)!,
      search: query.q,
    },
  };
}

const toOption =
  (status: PersonStatus.MEMBER | PersonStatus.FORMER_MEMBER) =>
  (person: SpacePerson): AssigneeOption => ({
    key: memberKey(person.userId),
    user_id: person.userId,
    name: person.name,
    status,
  });

// The transactions API (docs/transactions-v2-contract.md): records of a space
// with an author and an assignment.
@Injectable()
export class SpaceTransactionsService {
  constructor(
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly categoriesService: CategoriesService,
    private readonly writes: TransactionWrites,
    private readonly feedReader: TransactionFeedReader,
    private readonly dataSource: DataSource,
  ) {}

  // The author is the caller. A member assignment needs a member at commit:
  // their row stays locked until then, so they cannot leave in between.
  async create(
    userId: number,
    spaceId: number,
    dto: CreateTransactionV2Dto,
    options: WriteOptions = {},
  ): Promise<TransactionResultV2> {
    const idempotency = { operation: 'transactions.v2.create', key: options.idempotencyKey, payload: dto };
    const operationId = dto.client_operation_id?.toLowerCase();

    return this.writes.run(
      userId,
      spaceId,
      idempotency,
      async (manager, { members }) => {
        if (operationId !== undefined) {
          await this.writes.assertOperationUnused(manager, spaceId, operationId);
        }

        const category = await this.writes.lockNewCategory(manager, spaceId, dto.category_id, dto.transaction_type);
        const assignment = toAssignmentColumns(dto.assignment);
        assertAssigneeIsMember(assignment, members);

        const repository = manager.getRepository(Transaction);
        const saved = await repository.save(
          repository.create({
            space_id: spaceId,
            ...recordedAuthor(userId),
            ...assignment,
            category_id: category.id,
            transaction_type: dto.transaction_type,
            amount: dto.amount,
            timestamp: toDate(dto.timestamp),
            description: normalizeDescription(dto.description),
          }),
        );

        if (operationId !== undefined) {
          await this.writes.recordOperation(manager, spaceId, operationId, saved.id);
        }

        return { transaction: await this.readView(manager, spaceId, saved.id) };
      },
      assigneeOf(dto.assignment),
    );
  }

  // Merges the request into the stored record; only changed values are
  // checked against the rules for new values. The author never changes; a
  // stored assignment to a former member is kept when the edit does not
  // change it. An edit that changes nothing writes nothing and keeps the
  // version.
  async update(
    userId: number,
    spaceId: number,
    transactionId: string,
    dto: UpdateTransactionV2Dto,
    options: WriteOptions = {},
  ): Promise<TransactionResultV2> {
    const expectedVersion = requireVersion(options);
    const idempotency = {
      operation: 'transactions.v2.update',
      key: options.idempotencyKey,
      payload: { transactionId, expectedVersion, body: dto },
    };

    return this.writes.run(
      userId,
      spaceId,
      idempotency,
      async (manager, { members }) => {
        const original = await this.writes.lockTransaction(manager, spaceId, transactionId);
        assertNotSystem(original);
        assertVersion(original, expectedVersion);

        const changes = changedFields(original, dto);
        assertNewValues(changes);
        await this.writes.checkChangedCategory(manager, spaceId, original, changes);

        if (changes.assignment_kind !== undefined) {
          assertAssigneeIsMember(
            { assignment_kind: changes.assignment_kind, assigned_user_id: changes.assigned_user_id! },
            members,
          );
        }

        await this.writes.applyChanges(manager, original.id, changes);

        return { transaction: await this.readView(manager, spaceId, original.id) };
      },
      assigneeOf(dto.assignment),
    );
  }

  async remove(userId: number, spaceId: number, transactionId: string, options: WriteOptions = {}): Promise<void> {
    const expectedVersion = requireVersion(options);
    const idempotency = {
      operation: 'transactions.v2.delete',
      key: options.idempotencyKey,
      payload: { transactionId, expectedVersion },
    };

    await this.writes.run(userId, spaceId, idempotency, async (manager) => {
      await this.writes.deleteRecord(manager, spaceId, transactionId, expectedVersion);

      return true;
    });
  }

  // Summary and day totals cover exactly the filtered records, the
  // assignment included, and a cursor carries it.
  async getFeed(userId: number, spaceId: number, query: TransactionFeedQueryV2Dto): Promise<TransactionFeedV2> {
    const selection = toSelection(spaceId, query);

    return this.feedReader.read(
      {
        selection,
        timeZone: resolveTimeZone(query.time_zone)!,
        limit: query.limit,
        cursor: query.cursor,
        aroundId: query.around_id,
      },
      () => this.checkHistoryQuery(userId, selection),
      (items, manager) => this.toViews(manager, spaceId, items),
    );
  }

  // the summary.count of the feed for the same query, initial balances included
  async count(userId: number, spaceId: number, query: TransactionCountQueryV2Dto): Promise<TransactionCount> {
    const selection = toSelection(spaceId, query);
    await this.checkHistoryQuery(userId, selection);

    return { count: await this.transactionQueriesService.countSelection(selection) };
  }

  // The options of the History "Assigned to" filter, from one snapshot.
  async getAssignees(userId: number, spaceId: number): Promise<TransactionAssignees> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    return readSnapshot(this.dataSource, async (manager) => {
      const members = await this.transactionQueriesService.getMembers(spaceId, manager);
      const memberIds = new Set(members.map((member) => member.userId));
      const assigned = await this.transactionQueriesService.getAssignedUsers(spaceId, manager);
      const former = assigned
        .filter((person) => !memberIds.has(person.userId))
        .sort((a, b) => a.name.localeCompare(b.name) || a.userId - b.userId);

      return {
        members: members.map(toOption(PersonStatus.MEMBER)),
        former_members: former.map(toOption(PersonStatus.FORMER_MEMBER)),
        has_deleted_members: await this.transactionQueriesService.hasDeletedAssignees(spaceId, manager),
      };
    });
  }

  async getById(userId: number, spaceId: number, transactionId: string): Promise<TransactionViewV2> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    if (!isUUID(transactionId)) {
      throw new ApiException('TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND);
    }

    return readSnapshot(this.dataSource, (manager) => this.readView(manager, spaceId, transactionId));
  }

  async getLatest(userId: number, spaceId: number): Promise<TransactionViewV2 | null> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    return readSnapshot(this.dataSource, async (manager) => {
      const transaction = await this.transactionQueriesService.getLatest(spaceId, manager);

      return transaction && this.toViews(manager, spaceId, [transaction]).then(([view]) => view);
    });
  }

  // Also finds the creates of the retired v1 API: operations outlive it.
  async getOperation(userId: number, spaceId: number, operationId: string): Promise<TransactionOperationViewV2> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    if (!isUUID(operationId)) {
      throw new ApiException('TRANSACTION_OPERATION_NOT_FOUND', HttpStatus.NOT_FOUND);
    }

    return readSnapshot(this.dataSource, async (manager) => {
      const found = await this.writes.readOperation(manager, spaceId, operationId);

      if (!found) {
        throw new ApiException('TRANSACTION_OPERATION_NOT_FOUND', HttpStatus.NOT_FOUND);
      }

      const { operation, transaction } = found;
      const [view] = transaction ? await this.toViews(manager, spaceId, [transaction]) : [null];

      return {
        operation_id: operation.operation_id,
        status: transaction ? TransactionOperationStatus.APPLIED : TransactionOperationStatus.DELETED,
        transaction_id: operation.transaction_id,
        created_at: operation.created_at,
        deleted_at: transaction ? null : operation.deleted_at,
        transaction: view,
      };
    });
  }

  // An archived category is a valid filter: its history is kept. A member
  // filter takes anyone the space knows as an assignee, so former members
  // stay filterable.
  private async checkHistoryQuery(userId: number, { spaceId, from, to, filters = {} }: TransactionSelection) {
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException([{ field: 'from', error: 'from must not be after to' }]);
    }

    await this.spaceAccessService.assertMembership(spaceId, userId);

    if (filters.categoryId !== undefined) {
      assertUserCategory(await this.categoriesService.getOne(filters.categoryId), spaceId);
    }

    const assignment = filters.assignment;

    if (
      assignment?.kind === AssignmentKind.MEMBER &&
      !(await this.transactionQueriesService.isKnownAssignee(spaceId, assignment.userId))
    ) {
      throw new ApiException('FORBIDDEN_MEMBER', HttpStatus.FORBIDDEN);
    }
  }

  private async readView(manager: EntityManager, spaceId: number, transactionId: string): Promise<TransactionViewV2> {
    const transaction = await this.transactionQueriesService.getOneInSpace(spaceId, transactionId, manager);
    assertFound(transaction, 'TRANSACTION_NOT_FOUND');
    const [view] = await this.toViews(manager, spaceId, [transaction]);

    return view;
  }

  // in the caller's snapshot, so a status agrees with the records it is read with
  private async toViews(
    manager: EntityManager,
    spaceId: number,
    transactions: LoadedTransaction[],
  ): Promise<TransactionViewV2[]> {
    const members = await this.transactionQueriesService.getMemberUserIds(spaceId, manager);

    return transactions.map((transaction) => toTransactionViewV2(transaction, members));
  }
}
