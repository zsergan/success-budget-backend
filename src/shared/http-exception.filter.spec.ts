import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  const buildHost = (url: string) => {
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusMock }),
        getRequest: () => ({ url }),
      }),
    } as unknown as ArgumentsHost;

    return { host, statusMock, jsonMock };
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

  it('includes an ISO timestamp', () => {
    const { host, jsonMock } = buildHost('/x');

    filter.catch(new HttpException('err', HttpStatus.BAD_REQUEST), host);

    const payload = jsonMock.mock.calls[0][0];
    expect(() => new Date(payload.timestamp).toISOString()).not.toThrow();
    expect(payload.timestamp).toBe(new Date(payload.timestamp).toISOString());
  });
});
