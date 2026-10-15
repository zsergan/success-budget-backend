import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

import { NEW_PASSWORD_MAX_BYTES, NEW_PASSWORD_MIN_LENGTH } from '@shared/constants';
import { IsNewPassword } from '@shared/decorators/is-new-password.decorator';

// Swagger metadata is explicit: tests build the document without the CLI plugin.

export class RequestPasswordResetDto {
  @ApiProperty({
    maxLength: 255,
    example: 'user@example.com',
    description: 'Trimmed and matched case-insensitively; any other difference in spelling is another address.',
  })
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class VerifyPasswordResetDto {
  @ApiProperty({ maxLength: 255, example: 'user@example.com', description: 'The address the code was requested for.' })
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    pattern: '^[0-9]{6}$',
    example: '042917',
    description: 'The six digits from the latest email. Leading zeros are significant.',
  })
  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'code must be six digits' })
  code!: string;
}

export class CompletePasswordResetDto {
  @ApiProperty({ maxLength: 255, description: 'reset_token from POST /users/password-reset/verify, sent as is.' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  reset_token!: string;

  @ApiProperty({
    minLength: NEW_PASSWORD_MIN_LENGTH,
    maxLength: NEW_PASSWORD_MAX_BYTES,
    example: 'new-secret-42',
    description:
      `At least ${NEW_PASSWORD_MIN_LENGTH} characters with a letter (A–Z, a–z) and a digit (0–9); ` +
      `at most ${NEW_PASSWORD_MAX_BYTES} bytes in UTF-8.`,
  })
  @IsNewPassword()
  password!: string;
}
