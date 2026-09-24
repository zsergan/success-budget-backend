import { IsNotEmpty, IsString, IsDecimal, IsEnum, Matches, MaxLength } from 'class-validator';
import { AppColor } from '@shared/enums';

export class CreateWalletDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  wallet_name: string;

  @IsNotEmpty()
  @IsDecimal()
  @Matches(/^\d+(\.\d+)?$/, { message: 'initial_balance must not be negative' })
  initial_balance: string;

  @IsNotEmpty()
  @IsEnum(AppColor)
  design: AppColor;
}
