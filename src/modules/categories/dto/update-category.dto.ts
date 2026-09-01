import { PartialType } from '@nestjs/swagger';
import { IsInt, IsOptional } from 'class-validator';

import { CreateCategoryDto } from './create-category.dto';

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @IsOptional()
  @IsInt()
  is_active: number;
}
