import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, Min, Max, IsEnum } from 'class-validator';

import { TransactionType } from '@shared/enums';
import { IsCalendarDate } from '@shared/decorators/is-calendar-date.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsDescription, IsTimeZoneWithDate } from './transaction-field.decorators';

// Only the format is checked here: whether an amount must be positive or a
// date not after today depends on whether it differs from the stored value,
// so SpaceTransactionsService.update() checks that.
export class UpdateTransactionDto {
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
    format: 'date',
    example: '2026-09-15',
    description: 'YYYY-MM-DD; a changed one must not be after today in time_zone.',
  })
  @IsOptionalNonNull()
  @IsCalendarDate()
  date?: string;

  @ApiPropertyOptional({
    example: 'Europe/Moscow',
    description: "Required with date: the device's IANA zone, telling which day is today. Not stored.",
  })
  @IsTimeZoneWithDate()
  time_zone?: string;

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
