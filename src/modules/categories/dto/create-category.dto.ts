import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AppColor, CategoryIcon, TransactionType } from '@shared/enums';

export class CreateCategoryDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  name: string;

  @IsNotEmpty()
  @IsEnum(TransactionType)
  transaction_type: TransactionType;

  @IsNotEmpty()
  @IsEnum(CategoryIcon)
  icon: CategoryIcon;

  @IsNotEmpty()
  @IsEnum(AppColor)
  color: AppColor;
}
