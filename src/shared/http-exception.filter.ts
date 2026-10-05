import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import 'pino-http';

import { RetryAfterException } from './retry-after.exception';

// Exceptions without their own code: field errors from validation, otherwise
// the status name (UNAUTHORIZED, TOO_MANY_REQUESTS, ...).
function defaultCode(status: number, error: { message?: unknown }): string {
  if (status === HttpStatus.BAD_REQUEST && Array.isArray(error.message)) {
    return 'VALIDATION_FAILED';
  }

  return HttpStatus[status] ?? 'ERROR';
}

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    const error: { message?: unknown; code?: string } =
      typeof exceptionResponse === 'string' ? { message: exceptionResponse } : exceptionResponse;

    if (exception instanceof RetryAfterException) {
      response.set('Retry-After', String(exception.retryAfterSeconds));
    }

    response.status(status).json({
      timestamp: new Date().toISOString(),
      path: request.url,
      statusCode: status,
      // Lets a client (or support, reading a bug report) match this
      // response to the exact server log line - pino-http assigns req.id
      // and logs every request/response pair under it.
      requestId: request.id,
      ...error,
      code: error.code ?? defaultCode(status, error),
    });
  }
}
