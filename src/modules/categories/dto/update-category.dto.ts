import { IsEnum, IsIn, IsString, MaxLength } from 'class-validator';

import { AppColor, CategoryIcon } from '@shared/enums';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';

// transaction_type is intentionally not a field here - immutable after creation.
export class UpdateCategoryDto {
  @IsOptionalNonNull()
  @IsString()
  @MaxLength(20)
  name?: string;

  @IsOptionalNonNull()
  @IsEnum(CategoryIcon)
  icon?: CategoryIcon;

  @IsOptionalNonNull()
  @IsEnum(AppColor)
  color?: AppColor;

  @IsOptionalNonNull()
  @IsIn([0, 1])
  is_active?: number;
}
