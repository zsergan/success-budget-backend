import { HttpException, HttpStatus } from '@nestjs/common';

import { type ErrorCode, ErrorMessages } from './error-messages';

export class ApiException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    status: HttpStatus,
    // extra body fields documented with the code, e.g. spaceId of SPACE_ALREADY_MEMBER
    details: Record<string, unknown> = {},
  ) {
    super({ ...details, code, message: ErrorMessages[code] }, status);
  }
}
