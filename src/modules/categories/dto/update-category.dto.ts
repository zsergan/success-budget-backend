import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { AppColor, CategoryIcon } from '@shared/enums';

// transaction_type is intentionally not a field here - immutable after creation.
export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  name?: string;

  @IsOptional()
  @IsEnum(CategoryIcon)
  icon?: CategoryIcon;

  @IsOptional()
  @IsEnum(AppColor)
  color?: AppColor;

  @IsOptional()
  @IsIn([0, 1])
  is_active?: number;
}
