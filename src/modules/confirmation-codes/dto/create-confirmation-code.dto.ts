import { IsEnum, IsNotEmpty, IsNumber, IsString } from 'class-validator';

import { ConfirmationType } from '../../../shared/enums';

export class CreateConfirmationCodeDto {
  @IsNotEmpty()
  @IsNumber()
  user_id: number;

  @IsNotEmpty()
  @IsString()
  confirmation_code: string;

  @IsNotEmpty()
  @IsEnum(ConfirmationType)
  confirmation_type: ConfirmationType;
}
