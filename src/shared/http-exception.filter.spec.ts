import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { ApiException } from './api.exception';
import { HttpExceptionFilter } from './http-exception.filter';
import { RetryAfterException } from './retry-after.exception';

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  const buildHost = (url: string) => {
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const setMock = jest.fn();
    const host = new ExecutionContextHost([{ url }, { status: statusMock, set: setMock }]);

    return { host, statusMock, jsonMock, setMock };
  };

  it('formats a string exception response into a message field', () => {
    const { host, statusMock, jsonMock } = buildHost('/users/login');
    const exception = new HttpException('Invalid credentials', HttpStatus.UNAUTHORIZED);

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/users/login',
        statusCode: 401,
        message: 'Invalid credentials',
      }),
    );
  });

  it('spreads an object exception response as-is', () => {
    const { host, statusMock, jsonMock } = buildHost('/limits');
    const exception = new HttpException(
      { message: 'Limit already exists', code: 'LIMIT_EXISTS' },
      HttpStatus.BAD_REQUEST,
    );

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/limits',
        statusCode: 400,
        message: 'Limit already exists',
        code: 'LIMIT_EXISTS',
      }),
    );
  });

  describe('code', () => {
    const codeOf = (exception: HttpException): unknown => {
      const { host, jsonMock } = buildHost('/x');
      filter.catch(exception, host);

      return jsonMock.mock.calls[0][0].code;
    };

    it('keeps the code of an ApiException next to its message', () => {
      const { host, jsonMock } = buildHost('/x');
      filter.catch(new ApiException('TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND), host);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 404, code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found' }),
      );
    });

    it('marks field errors as VALIDATION_FAILED', () => {
      const exception = new BadRequestException([{ field: 'amount', error: 'amount is invalid' }]);

      expect(codeOf(exception)).toBe('VALIDATION_FAILED');
    });

    it('falls back to the status name', () => {
      expect(codeOf(new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED))).toBe('UNAUTHORIZED');
      expect(codeOf(new BadRequestException('Validation failed (numeric string is expected)'))).toBe('BAD_REQUEST');
      expect(codeOf(new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS))).toBe('TOO_MANY_REQUESTS');
    });
  });

  it('includes an ISO timestamp', () => {
    const { host, jsonMock } = buildHost('/x');

    filter.catch(new HttpException('err', HttpStatus.BAD_REQUEST), host);

    const payload = jsonMock.mock.calls[0][0];
    expect(() => new Date(payload.timestamp).toISOString()).not.toThrow();
    expect(payload.timestamp).toBe(new Date(payload.timestamp).toISOString());
  });

  it('sets a Retry-After header for a RetryAfterException', () => {
    const { host, statusMock, jsonMock, setMock } = buildHost('/users/register');
    const exception = new RetryAfterException('CONFIRMATION_EMAIL_RATE_LIMITED', 42);

    filter.catch(exception, host);

    expect(setMock).toHaveBeenCalledWith('Retry-After', '42');
    expect(statusMock).toHaveBeenCalledWith(429);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CONFIRMATION_EMAIL_RATE_LIMITED',
        message: 'A confirmation email was already requested, please try again shortly',
        retryAfterSeconds: 42,
      }),
    );
  });

  it('does not set a Retry-After header for a plain HttpException', () => {
    const { host, setMock } = buildHost('/x');

    filter.catch(new HttpException('err', HttpStatus.BAD_REQUEST), host);

    expect(setMock).not.toHaveBeenCalled();
  });
});
