import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, Min, Max, IsEnum } from 'class-validator';

import { TransactionType } from '@shared/enums';
import { IsInTimestampRange, IsIsoInstant } from '@shared/decorators/is-iso-date.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsDescription } from './transaction-field.decorators';

// Only the format is checked here: whether an amount must be positive or a
// timestamp not in the future depends on whether it differs from the stored
// value, so TransactionsService.update() checks that.
export class UpdateTransactionDto {
  @ApiPropertyOptional({
    type: 'integer',
    example: 8,
    description: 'Absent or the current id keeps the wallet, even a deleted one.',
  })
  @IsOptionalNonNull()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  wallet_id?: number;

  @ApiPropertyOptional({
    type: 'integer',
    example: 12,
    description: 'Absent or the current id keeps the category, even an archived one.',
  })
  @IsOptionalNonNull()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  category_id?: number;

  @ApiPropertyOptional({ enum: TransactionType, enumName: 'TransactionType' })
  @IsOptionalNonNull()
  @IsEnum(TransactionType)
  transaction_type?: TransactionType;

  @ApiPropertyOptional({ example: '20.00', description: 'A changed amount must be greater than 0.' })
  @IsOptionalNonNull()
  @IsMoneyAmount()
  amount?: string;

  @ApiPropertyOptional({
    example: '2026-09-15T10:00:00.000Z',
    description: 'With Z or a UTC offset; a changed one must not be in the future.',
  })
  @IsOptionalNonNull()
  @IsIsoInstant()
  @IsInTimestampRange()
  timestamp?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 140,
    example: 'Dinner',
    description: 'null, "" and whitespace clear the description.',
  })
  @IsDescription()
  description?: string | null;
}
