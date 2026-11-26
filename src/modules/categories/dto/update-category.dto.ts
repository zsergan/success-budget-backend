import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { CategoryIcon } from '@shared/enums';
import type { CategoryColor } from '@shared/category-color';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsCategoryColor } from '@shared/decorators/is-category-color.decorator';
import { CATEGORY_COLOR_PROPERTY } from './create-category.dto';

// transaction_type is intentionally not a field here - immutable after creation.
export class UpdateCategoryDto {
  @IsOptionalNonNull()
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  name?: string;

  @IsOptionalNonNull()
  @IsEnum(CategoryIcon)
  icon?: CategoryIcon;

  @ApiPropertyOptional(CATEGORY_COLOR_PROPERTY)
  @IsOptionalNonNull()
  @IsCategoryColor()
  color?: CategoryColor;

  @IsOptionalNonNull()
  @IsIn([0, 1])
  is_active?: number;
}
