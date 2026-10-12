import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
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

interface StatusError {
  status: number;
  message: string;
  expose?: boolean;
}

// An http-errors error (body-parser: payload too large, unsupported charset,
// ...) carries its own client status, as Nest's default filter honors.
function isStatusError(exception: unknown): exception is StatusError {
  const status = (exception as { status?: unknown } | null)?.status;

  return (
    !(exception instanceof HttpException) &&
    exception instanceof Error &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  );
}

// Every exception leaves the API in one shape, with a code and the request
// id. An unexpected one (a lost DB connection, deadlock retries used up, a
// bug) is a 500 with a fixed message; its details go to the log only.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const base = {
      timestamp: new Date().toISOString(),
      path: request.url,
      // Lets a client (or support, reading a bug report) match this
      // response to the exact server log line - pino-http assigns req.id
      // and logs every request/response pair under it.
      requestId: request.id,
    };

    if (isStatusError(exception)) {
      response.status(exception.status).json({
        ...base,
        statusCode: exception.status,
        code: HttpStatus[exception.status] ?? 'ERROR',
        message: exception.expose ? exception.message : (HttpStatus[exception.status] ?? 'Error'),
      });
      return;
    }

    if (!(exception instanceof HttpException)) {
      if (exception instanceof Error) {
        this.logger.error(exception.message, exception.stack);
      } else {
        this.logger.error(String(exception));
      }

      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        ...base,
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
      });
      return;
    }

    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    const error: { message?: unknown; code?: string } =
      typeof exceptionResponse === 'string' ? { message: exceptionResponse } : exceptionResponse;

    if (exception instanceof RetryAfterException) {
      response.set('Retry-After', String(exception.retryAfterSeconds));
    }

    response.status(status).json({
      ...base,
      statusCode: status,
      ...error,
      code: error.code ?? defaultCode(status, error),
    });
  }
}
