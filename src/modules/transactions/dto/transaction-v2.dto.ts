import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CreateTransactionDto } from './create-transaction.dto';
import { UpdateTransactionDto } from './update-transaction.dto';
import { IsAssignment, TransactionAssignmentDto } from './transaction-assignment.dto';

// The fields and rules shared with the retired v1 API, plus the assignment.
export class CreateTransactionV2Dto extends CreateTransactionDto {
  @ApiProperty({ type: TransactionAssignmentDto, description: 'Who the transaction is for.' })
  @IsAssignment({ required: true })
  assignment!: TransactionAssignmentDto;
}

export class UpdateTransactionV2Dto extends UpdateTransactionDto {
  @ApiPropertyOptional({
    type: TransactionAssignmentDto,
    description: 'Absent, or equal to the stored assignment, keeps it, also for a former member.',
  })
  @IsAssignment({ required: false })
  assignment?: TransactionAssignmentDto;
}
