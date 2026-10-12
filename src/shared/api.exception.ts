import { HttpException, HttpStatus } from '@nestjs/common';

import { type ErrorCode, ErrorMessages } from './error-messages';

export class ApiException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    status: HttpStatus,
  ) {
    super({ code, message: ErrorMessages[code] }, status);
  }
}
