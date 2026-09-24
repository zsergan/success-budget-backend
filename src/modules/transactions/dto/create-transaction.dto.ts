import { IsNotEmpty, IsOptional, IsString, IsNumber, IsEnum, MaxLength } from 'class-validator';

import { TransactionType } from '@shared/enums';
import { IsInTimestampRange, IsIsoDate } from '@shared/decorators/is-iso-date.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';

export class CreateTransactionDto {
  @IsNotEmpty()
  @IsNumber()
  wallet_id!: number;

  @IsNotEmpty()
  @IsNumber()
  category_id!: number;

  @IsNotEmpty()
  @IsEnum(TransactionType)
  transaction_type!: TransactionType;

  @IsNotEmpty()
  @IsMoneyAmount()
  amount!: string;

  @IsNotEmpty()
  @IsIsoDate()
  @IsInTimestampRange()
  timestamp!: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string | null;
}
