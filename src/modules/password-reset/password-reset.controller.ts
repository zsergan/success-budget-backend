import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';

import { PasswordResetService } from './password-reset.service';
import { RequestPasswordResetDto, VerifyPasswordResetDto } from './dto/password-reset-requests.dto';
import { PasswordResetAuthorization, PasswordResetRequested } from './dto/password-reset-responses';
import { Public } from '@shared/decorators/public.decorator';

const RATE_LIMITED =
  'PASSWORD_RESET_RATE_LIMITED: limit for this email address; TOO_MANY_REQUESTS: limit for the network ' +
  'address. Retry after the Retry-After header, in seconds.';

@ApiTags('users')
@Controller('users/password-reset')
export class PasswordResetController {
  constructor(private readonly passwordResetService: PasswordResetService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send a password reset code, or a new one',
    description: 'The same answer for every address; it does not tell whether an account exists or an email was sent.',
  })
  @ApiAcceptedResponse({ type: PasswordResetRequested })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED' })
  @ApiTooManyRequestsResponse({
    description: `Within the 60-second cooldown or over 5 requests an hour. ${RATE_LIMITED}`,
  })
  async request(@Body() dto: RequestPasswordResetDto): Promise<PasswordResetRequested> {
    return this.passwordResetService.request(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange the code for a password reset authorization',
    description: 'Repeating the accepted code, e.g. after a lost response, returns the same reset_token.',
  })
  @ApiOkResponse({ type: PasswordResetAuthorization })
  @ApiBadRequestResponse({
    description:
      'PASSWORD_RESET_CODE_INVALID: wrong code, attempts remain. PASSWORD_RESET_CODE_UNUSABLE: no active code ' +
      '(none requested, expired, used up or already completed); request a new one. VALIDATION_FAILED.',
  })
  @ApiTooManyRequestsResponse({ description: `Over 10 wrong codes an hour. ${RATE_LIMITED}` })
  async verify(@Body() dto: VerifyPasswordResetDto): Promise<PasswordResetAuthorization> {
    return this.passwordResetService.verify(dto);
  }
}
