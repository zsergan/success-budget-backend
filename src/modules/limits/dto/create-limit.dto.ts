import { IsNotEmpty, IsDecimal, IsOptional, IsArray, IsInt, IsString, MaxLength } from 'class-validator';

export class CreateLimitDto {
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  category_ids?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsNotEmpty()
  @IsDecimal()
  amount: number;
}
