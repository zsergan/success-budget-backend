import { IsNotEmpty, IsString, IsEnum, MaxLength } from 'class-validator';

import { AppColor } from '@shared/enums';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';

export class CreateWalletDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  wallet_name!: string;

  @IsNotEmpty()
  @IsMoneyAmount()
  initial_balance!: string;

  @IsNotEmpty()
  @IsEnum(AppColor)
  design!: AppColor;
}
