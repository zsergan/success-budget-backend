import { BadRequestException, INestApplication, ValidationError, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

import { HttpExceptionFilter } from '@shared/http-exception.filter';

/**
 * Express's `trust proxy` setting, driven by TRUST_PROXY:
 *  - unset/empty -> false (trust nothing; req.ip is the direct socket peer,
 *    so a client can't spoof its rate-limit identity via X-Forwarded-For)
 *  - "true"/"false" -> Express's own boolean semantics
 *  - an integer -> that many reverse-proxy hops are trusted (e.g. "1" for
 *    a typical single-reverse-proxy PaaS host)
 *  - anything else -> passed through as-is (Express also accepts a
 *    CIDR/hostname list, e.g. "loopback, 10.0.0.0/8")
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;

  const asNumber = Number(value);
  return Number.isInteger(asNumber) ? asNumber : value;
}

/**
 * Explicit SWAGGER_ENABLED always wins; otherwise Swagger is on everywhere
 * except production, so a hosted production deployment doesn't expose its
 * API schema by default.
 */
export function isSwaggerEnabled(configService: ConfigService): boolean {
  const explicit = configService.get<string>('SWAGGER_ENABLED');

  if (explicit !== undefined) {
    return explicit === 'true';
  }

  return configService.get<string>('NODE_ENV') !== 'production';
}

export interface FieldError {
  field: string;
  error: string;
}

// Nested errors (e.g. from @ValidateNested) carry their messages on
// `children`, not `constraints`.
export function formatValidationErrors(errors: ValidationError[], parentPath = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    const messages = Object.values(error.constraints ?? {});
    const own = messages.length ? [{ field, error: messages.join(', ') }] : [];
    const nested = formatValidationErrors(error.children ?? [], field);

    return own.length || nested.length ? [...own, ...nested] : [{ field, error: `${field} is invalid` }];
  });
}

export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService);

  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', parseTrustProxy(configService.get<string>('TRUST_PROXY')));

  app.use(helmet());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (validationErrors: ValidationError[] = []) =>
        new BadRequestException(formatValidationErrors(validationErrors)),
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
}
