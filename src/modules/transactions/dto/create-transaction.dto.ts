import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsEnum } from 'class-validator';

import { TransactionType } from '@shared/enums';
import { IsInTimestampRange, IsIsoInstant } from '@shared/decorators/is-iso-date.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';
import { IsDescription, IsNotInFuture, IsPositiveAmount } from './transaction-field.decorators';

// Swagger metadata is explicit: tests build the document without the CLI plugin.
export class CreateTransactionDto {
  @ApiProperty({ type: 'integer', example: 7, description: 'An active wallet of the space.' })
  @IsNotEmpty()
  @IsNumber()
  wallet_id!: number;

  @ApiProperty({
    type: 'integer',
    example: 12,
    description: 'An active, non-system category of the space whose type is transaction_type.',
  })
  @IsNotEmpty()
  @IsNumber()
  category_id!: number;

  @ApiProperty({ enum: TransactionType, enumName: 'TransactionType' })
  @IsNotEmpty()
  @IsEnum(TransactionType)
  transaction_type!: TransactionType;

  @ApiProperty({ example: '12.30', description: 'Decimal string, 0.01 to 99999999.99, at most 2 decimals.' })
  @IsNotEmpty()
  @IsMoneyAmount()
  @IsPositiveAmount()
  amount!: string;

  @ApiProperty({
    example: '2026-09-15T10:00:00.000Z',
    description: 'An instant with Z or a UTC offset, at most 60 s ahead of the server.',
  })
  @IsNotEmpty()
  @IsIsoInstant()
  @IsInTimestampRange()
  @IsNotInFuture()
  timestamp!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 140,
    example: 'Lunch',
    description: 'Trimmed; blank or null means none.',
  })
  @IsDescription()
  description?: string | null;
}
