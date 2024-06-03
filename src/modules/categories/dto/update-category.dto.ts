import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { TransactionType } from '../../../shared/enums';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  name: string;

  @IsOptional()
  @IsEnum(TransactionType)
  transaction_type: TransactionType;

  @IsOptional()
  @IsString()
  icon: string;

  @IsOptional()
  @IsString()
  color: string;

  @IsOptional()
  @IsInt()
  is_active: number;
}
