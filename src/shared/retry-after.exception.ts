import { HttpException, HttpStatus } from '@nestjs/common';

import { type ErrorCode, ErrorMessages } from './error-messages';

// A 429 that also carries a machine-readable retry delay - HttpExceptionFilter
// turns retryAfterSeconds into a Retry-After response header.
export class RetryAfterException extends HttpException {
  public readonly retryAfterSeconds: number;

  constructor(code: ErrorCode, retryAfterSeconds: number) {
    super({ code, message: ErrorMessages[code], retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
