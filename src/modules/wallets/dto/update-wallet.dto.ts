import { IsNotEmpty, IsString, IsDecimal } from 'class-validator';

export class UpdateWalletDto {
  @IsNotEmpty()
  @IsString()
  wallet_name: string;

  @IsNotEmpty()
  @IsDecimal()
  balance: number;
}
