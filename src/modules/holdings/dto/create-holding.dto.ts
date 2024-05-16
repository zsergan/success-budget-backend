import { IsNotEmpty, IsString, IsDecimal, IsNumber } from 'class-validator';

export class CreateHoldingDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsDecimal()
  balance: number;

  @IsNotEmpty()
  @IsNumber()
  currency_id: number;
}
