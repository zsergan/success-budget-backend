import { HttpException, HttpStatus } from '@nestjs/common';

// A 429 that also carries a machine-readable retry delay - HttpExceptionFilter
// turns retryAfterSeconds into a Retry-After response header.
export class RetryAfterException extends HttpException {
  public readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super({ message, retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
