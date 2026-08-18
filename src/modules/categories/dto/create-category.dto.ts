import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TransactionType } from '../../../shared/enums';

export class CreateCategoryDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  name: string;

  @IsNotEmpty()
  @IsEnum(TransactionType)
  transaction_type: TransactionType;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  icon: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(7)
  color: string;
}
