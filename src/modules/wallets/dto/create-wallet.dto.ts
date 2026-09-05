import { IsNotEmpty, IsString, IsDecimal, IsNumber, IsEnum, MaxLength } from 'class-validator';
import { AppColor } from '@shared/enums';

export class CreateWalletDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  wallet_name: string;

  @IsNotEmpty()
  @IsDecimal()
  balance: number;

  @IsNotEmpty()
  @IsNumber()
  currency_id: number;

  @IsNotEmpty()
  @IsEnum(AppColor)
  design: AppColor;
}
