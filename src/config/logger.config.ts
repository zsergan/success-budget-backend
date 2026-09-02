import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ConfigService } from '@nestjs/config';
import type { Params } from 'nestjs-pino';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * JSON logs by default; pretty-printed only when NODE_ENV is explicitly
 * "development". Defaulting the other way (pretty unless told otherwise)
 * would mean a deployment that forgets to set NODE_ENV falls back to trying
 * to load `pino-pretty` - a devDependency not present in a production
 * install - and crashes on the first log line instead of just logging JSON.
 */
export const getLoggerConfig = (configService: ConfigService): Params => {
  const isDevelopment = configService.get<string>('NODE_ENV') === 'development';

  return {
    pinoHttp: {
      level: configService.get<string>('LOG_LEVEL', 'info'),
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const existingId = req.headers[REQUEST_ID_HEADER];
        const requestId = (Array.isArray(existingId) ? existingId[0] : existingId) ?? randomUUID();
        res.setHeader('X-Request-Id', requestId);
        return requestId;
      },
      // Without this, pino-http logs every request (including 4xx/5xx) at
      // the same 'info' level, making failures indistinguishable from
      // normal traffic in the log stream.
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // pino-http's default request serializer never includes the body, so
      // only headers need redacting here - password/confirmation-code
      // fields are never at risk of being logged in the first place.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[Redacted]',
      },
      transport: isDevelopment
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
        : undefined,
    },
  };
};
