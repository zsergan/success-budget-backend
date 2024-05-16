import { IsNotEmpty, IsString, IsDecimal } from 'class-validator';

export class UpdateHoldingDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsDecimal()
  balance: number;
}
