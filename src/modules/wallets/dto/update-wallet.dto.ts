import { IsNotEmpty, IsString, IsDecimal, IsEnum, IsOptional } from 'class-validator';
import { WalletDesign } from '../../../shared/enums';

export class UpdateWalletDto {
  @IsNotEmpty()
  @IsString()
  wallet_name: string;

  @IsOptional()
  @IsDecimal()
  balance: number;

  @IsNotEmpty()
  @IsEnum(WalletDesign)
  design: WalletDesign;
}
