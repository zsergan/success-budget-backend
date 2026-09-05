import { ArrayNotEmpty, IsArray, IsInt } from 'class-validator';

export class ReorderCategoriesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  category_ids: number[];
}
