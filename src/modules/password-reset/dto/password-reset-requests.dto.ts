import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Swagger metadata is explicit: tests build the document without the CLI plugin.

export class RequestPasswordResetDto {
  @ApiProperty({ maxLength: 255, example: 'user@example.com', description: 'Matched case-insensitively.' })
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

  @ApiProperty({ minLength: 6, description: 'The new password; same rules as at registration.' })
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  password!: string;
}
