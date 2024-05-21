import { IsNotEmpty, IsString, IsDecimal, IsNumber } from 'class-validator';

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
}
