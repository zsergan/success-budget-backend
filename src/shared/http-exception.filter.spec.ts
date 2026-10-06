import { BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
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
    const host = new ExecutionContextHost([
      { url, id: 'req-1' },
      { status: statusMock, set: setMock },
    ]);

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

  describe('an unexpected exception', () => {
    let logError: jest.SpyInstance;

    beforeEach(() => {
      logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(() => {
      logError.mockRestore();
    });

    it.each<[string, unknown]>([
      ['an Error', new QueryFailedError('SELECT secret', [], new Error('connect ECONNREFUSED 10.0.0.5:3306'))],
      ['a thrown string', 'boom'],
    ])('answers %s with a 500 in the API error shape, without its details', (_, exception) => {
      const { host, statusMock, jsonMock } = buildHost('/spaces/1/transactions');

      filter.catch(exception, host);

      expect(statusMock).toHaveBeenCalledWith(500);
      const body = jsonMock.mock.calls[0][0];
      expect(body).toEqual({
        timestamp: expect.any(String),
        path: '/spaces/1/transactions',
        requestId: 'req-1',
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(body)).not.toMatch(/secret|ECONNREFUSED|boom/);
    });

    it('keeps the client status of an http-errors error, such as a payload that is too large', () => {
      const { host, statusMock, jsonMock } = buildHost('/x');
      const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, expose: true });

      filter.catch(tooLarge, host);

      expect(statusMock).toHaveBeenCalledWith(413);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'request entity too large' }),
      );
      expect(logError).not.toHaveBeenCalled();
    });

    it('logs the details', () => {
      const { host } = buildHost('/x');
      const error = new Error('deadlock retries used up');

      filter.catch(error, host);

      expect(logError).toHaveBeenCalledWith('deadlock retries used up', error.stack);
    });
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
