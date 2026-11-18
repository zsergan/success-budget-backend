import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';

import { CreateTransactionDto } from './create-transaction.dto';
import { UpdateTransactionDto } from './update-transaction.dto';
import { IsAssignment, TransactionAssignmentDto } from './transaction-assignment.dto';

// The v1 fields and rules without the wallet, plus the assignment.
export class CreateTransactionV2Dto extends OmitType(CreateTransactionDto, ['wallet_id'] as const) {
  @ApiProperty({ type: TransactionAssignmentDto, description: 'Who the transaction is for.' })
  @IsAssignment({ required: true })
  assignment!: TransactionAssignmentDto;
}

export class UpdateTransactionV2Dto extends OmitType(UpdateTransactionDto, ['wallet_id'] as const) {
  @ApiPropertyOptional({
    type: TransactionAssignmentDto,
    description: 'Absent, or equal to the stored assignment, keeps it, also for a former member.',
  })
  @IsAssignment({ required: false })
  assignment?: TransactionAssignmentDto;
}
