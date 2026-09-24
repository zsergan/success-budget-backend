import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';

import type { EnvironmentVariables } from './env.validation';
import { getLoggerConfig } from './logger.config';
import { buildConfigService } from '@testing';

const getPinoHttpOptions = (values: Partial<EnvironmentVariables> = {}) =>
  getLoggerConfig(buildConfigService(values)).pinoHttp;

const buildRequest = (headers: IncomingMessage['headers'] = {}): IncomingMessage =>
  Object.assign(new IncomingMessage(new Socket()), { headers });

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
    const buildReqRes = (headers: IncomingMessage['headers'] = {}) => {
      const req = buildRequest(headers);
      const res = new ServerResponse(req);
      jest.spyOn(res, 'setHeader');
      return { req, res };
    };

    it('reuses an existing x-request-id header', () => {
      const { req, res } = buildReqRes({ 'x-request-id': 'client-supplied-id' });

      const id = getPinoHttpOptions().genReqId?.(req, res);

      expect(id).toBe('client-supplied-id');
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-supplied-id');
    });

    it('takes the first value when the header is sent multiple times', () => {
      const { req, res } = buildReqRes({ 'x-request-id': ['first-id', 'second-id'] });

      const id = getPinoHttpOptions().genReqId?.(req, res);

      expect(id).toBe('first-id');
    });

    it('generates a uuid when no header is present', () => {
      const { req, res } = buildReqRes();

      const id = getPinoHttpOptions().genReqId?.(req, res);

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', id);
    });
  });

  describe('customLogLevel', () => {
    const level = (statusCode: number, err?: Error) => {
      const req = buildRequest();
      const res = Object.assign(new ServerResponse(req), { statusCode });
      return getPinoHttpOptions().customLogLevel?.(req, res, err);
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
