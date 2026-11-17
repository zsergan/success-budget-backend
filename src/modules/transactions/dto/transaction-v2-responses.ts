import { ApiExtraModels, ApiProperty, type ApiPropertyOptions } from '@nestjs/swagger';

import {
  AssignmentKind,
  AuthorSource,
  PersonStatus,
  TransactionKind,
  TransactionOperationStatus,
  TransactionType,
} from '@shared/enums';
import { nullableObject } from '@shared/swagger';
import {
  TransactionCategory,
  TransactionFeedDayTotal,
  TransactionFeedPageInfo,
  TransactionFeedSummary,
} from './transaction-responses';

// Every property is decorated explicitly and the file has no .dto.ts suffix,
// so the CLI plugin adds nothing and the schema is the same in tests.

const INSTANT: ApiPropertyOptions = { type: String, format: 'date-time', example: '2026-09-28T12:00:00.000Z' };

export class TransactionPerson {
  @ApiProperty({ type: 'integer', nullable: true, example: 31, description: 'null only when the account was deleted.' })
  user_id!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'Lena', description: 'Current name; null only when deleted.' })
  name!: string | null;

  @ApiProperty({
    enum: PersonStatus,
    enumName: 'PersonStatus',
    description: 'member: in the space now; former_member: left or was removed; deleted: the account is gone.',
  })
  status!: PersonStatus;
}

export class TransactionAuthor extends TransactionPerson {
  @ApiProperty({
    enum: AuthorSource,
    enumName: 'AuthorSource',
    description: 'recorded: the user who created it; imported: filled in when wallets were retired, not verified.',
  })
  source!: AuthorSource;
}

export class TransactionAssignmentView {
  @ApiProperty({ enum: AssignmentKind, enumName: 'AssignmentKind' })
  kind!: AssignmentKind;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'member: the user, null when the account was deleted; otherwise null.',
  })
  user_id!: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'member: the current name; otherwise null.' })
  name!: string | null;

  @ApiProperty({
    enum: [...Object.values(PersonStatus), null],
    nullable: true,
    description: 'member only; otherwise null.',
  })
  status!: PersonStatus | null;
}

export class TransactionViewV2 {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: TransactionKind,
    enumName: 'TransactionKind',
    description: 'initial_balance is a historical system record: readable, never edited or deleted.',
  })
  kind!: TransactionKind;

  @ApiProperty({ enum: TransactionType, enumName: 'TransactionType' })
  transaction_type!: TransactionType;

  @ApiProperty({ pattern: '^\\d+\\.\\d{2}$', example: '12.30', description: 'Non-negative; type gives the sign.' })
  amount!: string;

  @ApiProperty(INSTANT)
  timestamp!: Date;

  @ApiProperty({ type: String, nullable: true, description: 'null when there is no description, never "".' })
  description!: string | null;

  @ApiProperty({ type: 'integer', minimum: 1, description: 'Bumped on every change of the record.' })
  version!: number;

  @ApiProperty({ type: TransactionCategory })
  category!: TransactionCategory;

  @ApiProperty({ type: TransactionAuthor, description: 'Set by the server on create; no edit changes it.' })
  author!: TransactionAuthor;

  @ApiProperty({ type: TransactionAssignmentView })
  assignment!: TransactionAssignmentView;
}

export class TransactionResultV2 {
  @ApiProperty({ type: TransactionViewV2, description: 'The stored record, as GET /:id reads it.' })
  transaction!: TransactionViewV2;
}

@ApiExtraModels(TransactionViewV2)
export class TransactionOperationViewV2 {
  @ApiProperty({ format: 'uuid', description: 'client_operation_id of the create, through either API version.' })
  operation_id!: string;

  @ApiProperty({
    enum: TransactionOperationStatus,
    enumName: 'TransactionOperationStatus',
    description: 'applied: the transaction exists, maybe edited since; deleted: it was created, then deleted.',
  })
  status!: TransactionOperationStatus;

  @ApiProperty({ format: 'uuid' })
  transaction_id!: string;

  @ApiProperty({ ...INSTANT, description: 'When the create committed.' })
  created_at!: Date;

  @ApiProperty({ ...INSTANT, nullable: true, description: 'When the transaction was deleted; null while it exists.' })
  deleted_at!: Date | null;

  @ApiProperty(nullableObject(TransactionViewV2, 'The current record, as GET /:id reads it; null when deleted.'))
  transaction!: TransactionViewV2 | null;
}

export class TransactionFeedV2 {
  @ApiProperty({ type: TransactionViewV2, isArray: true, description: 'Newest first: timestamp, then id, descending.' })
  items!: TransactionViewV2[];

  @ApiProperty({ type: TransactionFeedPageInfo })
  page_info!: TransactionFeedPageInfo;

  @ApiProperty({
    type: TransactionFeedSummary,
    description: 'The whole selection: period, q and filters, assignment included.',
  })
  summary!: TransactionFeedSummary;

  @ApiProperty({
    type: TransactionFeedDayTotal,
    isArray: true,
    description: 'One entry per local day that has a record in items, in the order of items.',
  })
  day_totals!: TransactionFeedDayTotal[];
}

export class AssigneeOption {
  @ApiProperty({ example: 'member:31', description: 'The feed assignment filter value.' })
  key!: string;

  @ApiProperty({ type: 'integer', example: 31 })
  user_id!: number;

  @ApiProperty({ example: 'Lena' })
  name!: string;

  @ApiProperty({ enum: [PersonStatus.MEMBER, PersonStatus.FORMER_MEMBER], enumName: 'AssigneeStatus' })
  status!: PersonStatus.MEMBER | PersonStatus.FORMER_MEMBER;
}

export class TransactionAssignees {
  @ApiProperty({ type: AssigneeOption, isArray: true, description: 'Current members, in joining order.' })
  members!: AssigneeOption[];

  @ApiProperty({
    type: AssigneeOption,
    isArray: true,
    description: 'Not members now, with records of the space assigned to them; by name, then user_id.',
  })
  former_members!: AssigneeOption[];

  @ApiProperty({ description: 'Some record of the space is assigned to a deleted account.' })
  has_deleted_members!: boolean;
}
