import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import 'pino-http';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    const error = typeof exceptionResponse === 'string' ? { message: exceptionResponse } : exceptionResponse;

    response.status(status).json({
      timestamp: new Date().toISOString(),
      path: request.url,
      statusCode: status,
      // Lets a client (or support, reading a bug report) match this
      // response to the exact server log line - pino-http assigns req.id
      // and logs every request/response pair under it.
      requestId: request.id,
      ...error,
    });
  }
}
