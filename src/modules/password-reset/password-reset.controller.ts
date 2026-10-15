import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';

import { PasswordResetService } from './password-reset.service';
import {
  CompletePasswordResetDto,
  RequestPasswordResetDto,
  VerifyPasswordResetDto,
} from './dto/password-reset-requests.dto';
import { PasswordResetAuthorization, PasswordResetRequested } from './dto/password-reset-responses';
import { Public } from '@shared/decorators/public.decorator';

const RATE_LIMITED =
  'PASSWORD_RESET_RATE_LIMITED: limit for this email address; TOO_MANY_REQUESTS: limit for the network ' +
  'address. Retry after the Retry-After header, in seconds.';

const RETRY_AFTER = {
  'Retry-After': { description: 'Seconds to wait before trying again.', schema: { type: 'integer', minimum: 1 } },
};

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
    description:
      'The same answer for every address; it does not tell whether an account exists or an email was sent. ' +
      'The email goes out after the response, so 202 does not mean it was delivered. A new code replaces the ' +
      'previous one but keeps its expiry and used attempts.',
  })
  @ApiAcceptedResponse({ type: PasswordResetRequested })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED' })
  @ApiTooManyRequestsResponse({
    description: `Within the 60-second cooldown or over 5 requests an hour. ${RATE_LIMITED}`,
    headers: RETRY_AFTER,
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
    description:
      'Repeating the accepted code, e.g. after a lost response, returns the same reset_token. The fifth wrong ' +
      'code ends the code and any reset_token issued for it. reset_token does not sign the user in.',
  })
  @ApiOkResponse({ type: PasswordResetAuthorization })
  @ApiBadRequestResponse({
    description:
      'PASSWORD_RESET_CODE_INVALID: wrong code, attempts remain. PASSWORD_RESET_CODE_UNUSABLE: no active code ' +
      '(none requested, expired, used up or already completed); request a new one. VALIDATION_FAILED.',
  })
  @ApiTooManyRequestsResponse({ description: `Over 10 wrong codes an hour. ${RATE_LIMITED}`, headers: RETRY_AFTER })
  async verify(@Body() dto: VerifyPasswordResetDto): Promise<PasswordResetAuthorization> {
    return this.passwordResetService.verify(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password and end every session of the account',
    description:
      'Returns no access token; the user signs in with the new password. A retry after a lost response gets ' +
      'PASSWORD_RESET_AUTHORIZATION_INVALID if the first call changed the password: a used reset_token never ' +
      'changes it again.',
  })
  @ApiNoContentResponse({ description: 'The password is changed; access tokens issued before are rejected.' })
  @ApiBadRequestResponse({
    description:
      'PASSWORD_RESET_AUTHORIZATION_INVALID: reset_token unknown, expired, already used or replaced; start ' +
      'again. VALIDATION_FAILED: password shorter than 8 characters, without a letter or a digit, or over 72 ' +
      'bytes; the token is not used.',
  })
  @ApiTooManyRequestsResponse({
    description: 'TOO_MANY_REQUESTS: limit for the network address. Retry after the Retry-After header, in seconds.',
    headers: RETRY_AFTER,
  })
  async complete(@Body() dto: CompletePasswordResetDto): Promise<void> {
    await this.passwordResetService.complete(dto);
  }
}
