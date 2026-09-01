import { IsNotEmpty, IsString, IsEnum, MaxLength } from 'class-validator';
import { WalletDesign } from '../../../shared/enums';

export class UpdateWalletDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  wallet_name: string;

  @IsNotEmpty()
  @IsEnum(WalletDesign)
  design: WalletDesign;
}
