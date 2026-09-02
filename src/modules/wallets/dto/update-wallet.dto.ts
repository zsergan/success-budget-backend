import { IsOptional, IsString, IsEnum, MaxLength } from 'class-validator';
import { WalletDesign } from '@shared/enums';

export class UpdateWalletDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  wallet_name: string;

  @IsOptional()
  @IsEnum(WalletDesign)
  design: WalletDesign;
}
