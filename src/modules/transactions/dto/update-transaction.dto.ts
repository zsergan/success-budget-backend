import { IsNumber, IsEnum } from 'class-validator';

import { TransactionType } from '@shared/enums';
import { IsInTimestampRange, IsIsoInstant } from '@shared/decorators/is-iso-date.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsDescription } from './transaction-field.decorators';

// Only the format is checked here: whether an amount must be positive or a
// timestamp not in the future depends on whether it differs from the stored
// value, so TransactionsService.update() checks that.
export class UpdateTransactionDto {
  @IsOptionalNonNull()
  @IsNumber()
  wallet_id?: number;

  @IsOptionalNonNull()
  @IsNumber()
  category_id?: number;

  @IsOptionalNonNull()
  @IsEnum(TransactionType)
  transaction_type?: TransactionType;

  @IsOptionalNonNull()
  @IsMoneyAmount()
  amount?: string;

  @IsOptionalNonNull()
  @IsIsoInstant()
  @IsInTimestampRange()
  timestamp?: string;

  // null, "" and whitespace clear the description
  @IsDescription()
  description?: string | null;
}
