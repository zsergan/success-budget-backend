import { IsInt, IsNotEmpty } from 'class-validator';

export class UpdateSpaceCurrencyDto {
  @IsNotEmpty()
  @IsInt()
  currency_id!: number;
}
