import { IsNotEmpty, IsNumber, IsEnum } from 'class-validator';

import { TransactionType } from '@shared/enums';
import { IsInTimestampRange, IsIsoInstant } from '@shared/decorators/is-iso-date.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';
import { IsDescription, IsNotInFuture, IsPositiveAmount } from './transaction-field.decorators';

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
  @IsPositiveAmount()
  amount!: string;

  @IsNotEmpty()
  @IsIsoInstant()
  @IsInTimestampRange()
  @IsNotInFuture()
  timestamp!: string;

  @IsDescription()
  description?: string | null;
}
