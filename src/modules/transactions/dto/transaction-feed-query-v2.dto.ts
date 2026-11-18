import { ApiPropertyOptional, OmitType, PickType } from '@nestjs/swagger';
import { IsString, ValidateBy } from 'class-validator';

import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { parseAssignmentFilter } from '@modules/transaction-queries/assignment-filter';
import { TransactionFeedQueryDto } from './transaction-feed-query.dto';

const ASSIGNMENT_FILTER = 'assignment must be space, unassigned, deleted_member or member:<user_id>';

// Swagger metadata is explicit: tests build the document without the CLI plugin.
export class TransactionFeedQueryV2Dto extends OmitType(TransactionFeedQueryDto, ['wallet_id'] as const) {
  @ApiPropertyOptional({
    example: 'member:31',
    description:
      'space, unassigned, deleted_member or member:<user_id> (a member, or a former member with records ' +
      'assigned in the space). Absent means every assignment. The key of an assignee or a breakdown item.',
  })
  @IsOptionalNonNull()
  @IsString()
  @ValidateBy({
    name: 'isAssignmentFilter',
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || parseAssignmentFilter(value) !== null,
      defaultMessage: () => ASSIGNMENT_FILTER,
    },
  })
  assignment?: string;
}

// The selection of the feed without paging: from and to are required instants here too.
export class TransactionCountQueryV2Dto extends PickType(TransactionFeedQueryV2Dto, [
  'from',
  'to',
  'q',
  'transaction_type',
  'kind',
  'category_id',
  'assignment',
] as const) {}
