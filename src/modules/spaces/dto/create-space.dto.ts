import { IsNotEmpty, IsString, IsInt, IsEnum, IsArray, ArrayUnique, IsEmail, MaxLength } from 'class-validator';

import { SpaceType } from '@shared/enums';
import { IsOptionalNonNull } from '@shared/decorators/is-optional-non-null.decorator';

export class CreateSpaceDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name: string;

  @IsNotEmpty()
  @IsInt()
  currency_id: number;

  @IsNotEmpty()
  @IsEnum(SpaceType)
  type: SpaceType;

  @IsOptionalNonNull()
  @IsArray()
  @ArrayUnique()
  @IsEmail({}, { each: true })
  @MaxLength(255, { each: true })
  invites?: string[];
}
