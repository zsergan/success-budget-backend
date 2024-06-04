import { IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { TransactionType } from '../../../shared/enums';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  name: string;

  @IsOptional()
  @IsEnum(TransactionType)
  transaction_type: TransactionType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  icon: string;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  color: string;

  @IsOptional()
  @IsInt()
  is_active: number;
}
