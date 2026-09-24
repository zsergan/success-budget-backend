import { IsOptional, IsArray, IsInt, IsString, MaxLength } from 'class-validator';

import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';

// Not PartialType(CreateLimitDto): its added @IsOptional() would let null
// through for category_ids and amount.
export class UpdateLimitDto {
  // absent keeps the current categories, [] turns the limit into the total limit
  @IsOptionalNonNull()
  @IsArray()
  @IsInt({ each: true })
  category_ids?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string | null;

  @IsOptionalNonNull()
  @IsMoneyAmount()
  amount?: string;
}
