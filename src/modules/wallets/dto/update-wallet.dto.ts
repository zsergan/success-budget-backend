import { IsNotEmpty, IsString, IsDecimal, IsEnum, IsOptional, MaxLength } from 'class-validator';
import { WalletDesign } from '../../../shared/enums';

export class UpdateWalletDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  wallet_name: string;

  @IsOptional()
  @IsDecimal()
  balance: number;

  @IsNotEmpty()
  @IsEnum(WalletDesign)
  design: WalletDesign;
}
