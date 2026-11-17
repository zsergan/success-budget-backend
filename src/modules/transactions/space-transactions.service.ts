import { HttpStatus, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import type { CreateTransactionV2Dto, UpdateTransactionV2Dto } from './dto/transaction-v2.dto';
import type {
  TransactionOperationViewV2,
  TransactionResultV2,
  TransactionViewV2,
} from './dto/transaction-v2-responses';
import { toTransactionViewV2 } from './transaction-view';
import { normalizeDescription } from './transaction-rules';
import { assertNotSystem, assertVersion } from './transaction-checks';
import { assertNewValues, changedFields } from './transaction-changes';
import { assertAssigneeIsMember, assigneeOf, toAssignmentColumns } from './transaction-assignment';
import { TransactionWrites, type WriteOptions, requireVersion } from './transaction-writes';
import { lockCompatibilityWallet } from './compatibility-wallet';
import { ApiException } from '@shared/api.exception';
import { TransactionOperationStatus } from '@shared/enums';
import { recordedAuthor } from '@shared/transaction-ownership';
import { assertFound, lockRows, readSnapshot, toDate } from '@shared/utils';
import {
  TransactionQueriesService,
  type LoadedTransaction,
} from '@modules/transaction-queries/transaction-queries.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';

// The v2 transactions API (docs/transactions-v2-contract.md): records of a
// space with an author and an assignment, no wallet. Shares its write unit,
// rules and operations with the v1 TransactionsService.
@Injectable()
export class SpaceTransactionsService {
  constructor(
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly writes: TransactionWrites,
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

        const wallet = await lockCompatibilityWallet(manager, spaceId);
        const category = await this.writes.lockNewCategory(manager, spaceId, dto.category_id, dto.transaction_type);
        const assignment = toAssignmentColumns(dto.assignment);
        assertAssigneeIsMember(assignment, members);

        const repository = manager.getRepository(Transaction);
        const saved = await repository.save(
          repository.create({
            space_id: spaceId,
            wallet_id: wallet.id,
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

  // The v1 merge rules, with the assignment instead of the wallet. The
  // author never changes; a stored assignment to a former member is kept
  // when the edit does not change it.
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
        // Release A: a v1 create reads its wallet's balance twice under this
        // lock, so an edit of a record of that wallet waits for it
        await lockRows(manager, Wallet, [original.wallet_id], 'exclusive');
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

  // Operations are shared by both versions: one created through v1 is found here.
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
