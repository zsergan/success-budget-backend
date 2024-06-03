import { IsNotEmpty, IsString, IsDecimal, IsNumber, IsEnum, IsDateString } from 'class-validator';

import { TransactionType } from '../../../shared/enums';

export class CreateTransactionDto {
  @IsNotEmpty()
  @IsNumber()
  wallet_id: number;

  @IsNotEmpty()
  @IsNumber()
  user_category_id: number;

  @IsNotEmpty()
  @IsEnum(TransactionType)
  transaction_type: TransactionType;

  @IsNotEmpty()
  @IsDecimal()
  amount: number;

  @IsNotEmpty()
  @IsDateString()
  timestamp: Date;

  @IsString()
  description: string;
}
