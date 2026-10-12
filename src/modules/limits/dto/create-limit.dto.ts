import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsArray, ArrayUnique, IsInt, Min, Max, IsString, MaxLength } from 'class-validator';

import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';
import { IsMoneyAmount } from '@shared/decorators/is-money-amount.decorator';

export class CreateLimitDto {
  @ApiPropertyOptional({
    type: 'integer',
    isArray: true,
    description:
      'Absent or []: the monthly total limit, one per space, counting every expense of the month, also ' +
      'of categories with their own limit. One id: a category limit; several: a named group.',
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

  @ApiProperty({ example: '1000.00', description: 'Decimal string, 0 to 99999999.99, at most 2 decimals.' })
  @IsNotEmpty()
  @IsMoneyAmount()
  amount!: string;
}
