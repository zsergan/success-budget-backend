import { IsDecimal, IsNumber, IsOptional } from 'class-validator';

export class UpdateLimitDto {
  @IsOptional()
  @IsNumber()
  category_id: number;

  @IsOptional()
  @IsDecimal()
  amount: number;
}
