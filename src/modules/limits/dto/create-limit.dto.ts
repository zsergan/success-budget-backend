import { IsNotEmpty, IsDecimal, IsNumber, IsOptional } from 'class-validator';

export class CreateLimitDto {
  @IsOptional()
  @IsNumber()
  category_id: number;

  @IsNotEmpty()
  @IsDecimal()
  amount: number;
}
