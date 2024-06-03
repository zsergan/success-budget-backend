import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { TransactionType } from '../../../shared/enums';

export class CreateCategoryDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsEnum(TransactionType)
  transaction_type: TransactionType;

  @IsNotEmpty()
  @IsString()
  icon: string;

  @IsNotEmpty()
  @IsString()
  color: string;
}
