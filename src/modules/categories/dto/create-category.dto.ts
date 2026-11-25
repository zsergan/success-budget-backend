import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CategoryIcon, TransactionType } from '@shared/enums';
import { CATEGORY_COLOR_PATTERN, type CategoryColor } from '@shared/category-color';
import { IsCategoryColor } from '@shared/decorators/is-category-color.decorator';

export const CATEGORY_COLOR_PROPERTY = {
  type: String,
  pattern: CATEGORY_COLOR_PATTERN,
  example: 'clay',
  description: 'A preset token, or a custom #RRGGBB: any case in, stored and returned upper-case.',
};

export class CreateCategoryDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  name!: string;

  @IsNotEmpty()
  @IsEnum(TransactionType)
  transaction_type!: TransactionType;

  @IsNotEmpty()
  @IsEnum(CategoryIcon)
  icon!: CategoryIcon;

  @ApiProperty(CATEGORY_COLOR_PROPERTY)
  @IsCategoryColor()
  color!: CategoryColor;
}
