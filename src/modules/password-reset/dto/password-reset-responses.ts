import { ApiProperty } from '@nestjs/swagger';

export class PasswordResetRequested {
  @ApiProperty({
    example: 'If this email belongs to a verified account, a password reset code has been sent',
    description: 'The same for every address; it does not tell whether an email was sent.',
  })
  message!: string;

  @ApiProperty({
    type: 'integer',
    example: 60,
    description: 'Seconds before another code can be requested for this address.',
  })
  resend_after_seconds!: number;
}

export class PasswordResetAuthorization {
  @ApiProperty({
    example: 'mX3v0b2rQ1kJ8yT6pZ4wN7cL5aH9eF0dS2gU1iO3qRk',
    description: 'Opaque, single use. Send it to POST /users/password-reset/complete; never store or log it.',
  })
  reset_token!: string;

  @ApiProperty({ type: 'integer', example: 600, description: 'Seconds until reset_token expires; at most 600.' })
  expires_in_seconds!: number;
}
