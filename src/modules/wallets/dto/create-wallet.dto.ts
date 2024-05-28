import { IsNotEmpty, IsString, IsDecimal, IsNumber, IsEnum } from 'class-validator';
import { WalletDesign } from '../../../shared/enums';

export class CreateWalletDto {
  @IsNotEmpty()
  @IsString()
  wallet_name: string;

  @IsNotEmpty()
  @IsDecimal()
  balance: number;

  @IsNotEmpty()
  @IsNumber()
  currency_id: number;

  @IsNotEmpty()
  @IsEnum(WalletDesign)
  design: WalletDesign;
}
