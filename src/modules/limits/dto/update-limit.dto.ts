import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsArray, ArrayUnique, IsInt, Min, Max, IsString, MaxLength } from 'class-validator';

import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';

// Not PartialType(CreateLimitDto): its added @IsOptional() would let null
// through for category_ids and amount.
export class UpdateLimitDto {
  @ApiPropertyOptional({
    type: 'integer',
    isArray: true,
    description: 'Absent keeps the current categories; [] turns the limit into the monthly total limit.',
  })
  @IsOptionalNonNull()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  category_ids?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string | null;

  @ApiPropertyOptional({ example: '1000.00', description: 'Decimal string, 0 to 99999999.99, at most 2 decimals.' })
  @IsOptionalNonNull()
  @IsMoneyAmount()
  amount?: string;
}
