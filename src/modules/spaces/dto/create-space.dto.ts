import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsArray,
  ArrayUnique,
  IsEmail,
  MaxLength,
} from 'class-validator';

import { SpaceType } from '@shared/enums';

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

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEmail({}, { each: true })
  @MaxLength(255, { each: true })
  invites?: string[];
}
