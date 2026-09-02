import { ConfigService } from '@nestjs/config';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Options as PinoHttpOptions } from 'pino-http';

import { getLoggerConfig } from './logger.config';

const buildConfigService = (values: Record<string, unknown>) =>
  ({ get: jest.fn((key: string, defaultValue?: unknown) => values[key] ?? defaultValue) }) as unknown as ConfigService;

const getPinoHttpOptions = (values: Record<string, unknown> = {}) =>
  getLoggerConfig(buildConfigService(values)).pinoHttp as PinoHttpOptions;

describe('getLoggerConfig', () => {
  it('defaults the log level to info when LOG_LEVEL is unset', () => {
    expect(getPinoHttpOptions().level).toBe('info');
  });

  it('uses LOG_LEVEL when set', () => {
    expect(getPinoHttpOptions({ LOG_LEVEL: 'debug' }).level).toBe('debug');
  });

  it('omits the pretty-print transport unless NODE_ENV is exactly "development"', () => {
    expect(getPinoHttpOptions().transport).toBeUndefined();
    expect(getPinoHttpOptions({ NODE_ENV: 'production' }).transport).toBeUndefined();
  });

  it('enables the pino-pretty transport when NODE_ENV is "development"', () => {
    expect(getPinoHttpOptions({ NODE_ENV: 'development' }).transport).toMatchObject({ target: 'pino-pretty' });
  });

  it('redacts the authorization and cookie headers', () => {
    expect(getPinoHttpOptions().redact).toMatchObject({
      paths: ['req.headers.authorization', 'req.headers.cookie'],
    });
  });

  describe('genReqId', () => {
    const buildReqRes = (headers: Record<string, string | string[]> = {}) => {
      const req = { headers } as unknown as IncomingMessage;
      const res = { setHeader: jest.fn() } as unknown as ServerResponse;
      return { req, res };
    };

    it('reuses an existing x-request-id header', () => {
      const { req, res } = buildReqRes({ 'x-request-id': 'client-supplied-id' });

      const id = getPinoHttpOptions().genReqId(req, res);

      expect(id).toBe('client-supplied-id');
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-supplied-id');
    });

    it('takes the first value when the header is sent multiple times', () => {
      const { req, res } = buildReqRes({ 'x-request-id': ['first-id', 'second-id'] });

      const id = getPinoHttpOptions().genReqId(req, res);

      expect(id).toBe('first-id');
    });

    it('generates a uuid when no header is present', () => {
      const { req, res } = buildReqRes();

      const id = getPinoHttpOptions().genReqId(req, res) as string;

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', id);
    });
  });

  describe('customLogLevel', () => {
    const level = (statusCode: number, err?: Error) => {
      const res = { statusCode } as unknown as ServerResponse;
      return getPinoHttpOptions().customLogLevel({} as IncomingMessage, res, err);
    };

    it('returns error for a server error status', () => {
      expect(level(500)).toBe('error');
      expect(level(503)).toBe('error');
    });

    it('returns error when an error object is passed, regardless of status', () => {
      expect(level(200, new Error('boom'))).toBe('error');
    });

    it('returns warn for a client error status', () => {
      expect(level(400)).toBe('warn');
      expect(level(404)).toBe('warn');
    });

    it('returns info for a successful status', () => {
      expect(level(200)).toBe('info');
      expect(level(304)).toBe('info');
    });
  });
});
