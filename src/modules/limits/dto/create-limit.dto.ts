import { IsNotEmpty, IsOptional, IsArray, IsInt, IsString, MaxLength } from 'class-validator';

import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';

export class CreateLimitDto {
  @IsOptionalNonNull()
  @IsArray()
  @IsInt({ each: true })
  category_ids?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string | null;

  @IsNotEmpty()
  @IsMoneyAmount()
  amount!: string;
}
