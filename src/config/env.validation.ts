import * as Joi from 'joi';

type BooleanString = 'true' | 'false';

// The values ConfigService returns after Joi validation and conversion - read
// them through ConfigService<EnvironmentVariables, true> with `infer: true`.
export interface EnvironmentVariables {
  DB_HOST: string;
  DB_PORT: number;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DB_DATABASE: string;
  DB_SSL?: BooleanString;
  DB_SSL_CA?: string;
  DB_SSL_REJECT_UNAUTHORIZED?: BooleanString;
  JWT_SECRET: string;
  LOG_LEVEL?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  NODE_ENV?: 'development' | 'test' | 'staging' | 'production';
  PORT?: number;
  TRUST_PROXY?: string;
  SWAGGER_ENABLED?: BooleanString;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE?: BooleanString;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  MAIL_FROM: string;
  PUBLIC_WEB_ORIGIN: string;
  INVITE_TOKEN_SECRET: string;
  APPLE_APP_ID?: string;
  TESTFLIGHT_URL?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// An origin only (scheme, host, port), so links never take a path, a query
// or the request's Host header. Plain http is for a loopback host outside
// production.
const publicOrigin = Joi.string().custom((value: string, helpers) => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return helpers.error('any.invalid');
  }

  const production = (helpers.state.ancestors[0] as { NODE_ENV?: string }).NODE_ENV === 'production';
  const allowedHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && !production;

  if (url.origin !== value || (url.protocol !== 'https:' && !allowedHttp)) {
    return helpers.error('any.invalid');
  }

  return value;
});

const testFlightUrl = Joi.string().custom((value: string, helpers) => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return helpers.error('any.invalid');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'testflight.apple.com' || url.username || url.password) {
    return helpers.error('any.invalid');
  }

  return value;
});

export const envValidationSchema = Joi.object<EnvironmentVariables>({
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().required(),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_DATABASE: Joi.string().required(),
  // Only meaningful against a managed MySQL instance that requires TLS -
  // local/docker-compose MySQL doesn't need it, so this stays optional.
  DB_SSL: Joi.string().valid('true', 'false').optional(),
  DB_SSL_CA: Joi.string().optional(),
  DB_SSL_REJECT_UNAUTHORIZED: Joi.string().valid('true', 'false').optional(),
  JWT_SECRET: Joi.string().min(16).required(),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').optional(),
  // Left unconstrained on purpose: only "development" ever changes behavior
  // (pino-pretty in logger.config.ts) and defaulting this would undo that
  // file's own safety design - see its comment for why an unset NODE_ENV
  // must fall through to the JSON/production branch, not "development".
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').optional(),
  PORT: Joi.number().port().optional(),
  // Express's `trust proxy` setting (see src/app.config.ts). No default
  // here on purpose - the app itself treats "unset" as "trust nothing".
  TRUST_PROXY: Joi.string().optional(),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').optional(),
  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().port().required(),
  SMTP_SECURE: Joi.string().valid('true', 'false').optional(),
  // Many local mail catchers (e.g. MailDev) need no auth at all.
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASSWORD: Joi.string().allow('').optional(),
  MAIL_FROM: Joi.string().required(),
  // origin of the invitation links and the /invite page, e.g. https://app.example.com
  PUBLIC_WEB_ORIGIN: publicOrigin.required().messages({
    'any.invalid': '"PUBLIC_WEB_ORIGIN" must be an https origin without a path, such as https://app.example.com',
  }),
  // signs invitation links only; never the JWT secret, so neither leaks the other
  INVITE_TOKEN_SECRET: Joi.string()
    .min(32)
    .required()
    .invalid(Joi.ref('JWT_SECRET'))
    .messages({ 'any.invalid': '"INVITE_TOKEN_SECRET" must differ from JWT_SECRET' }),
  // <Team ID>.<bundle ID> of the iOS app the invitation links open
  APPLE_APP_ID: Joi.string()
    .pattern(/^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)
    .when('NODE_ENV', { is: 'production', then: Joi.required(), otherwise: Joi.optional() }),
  TESTFLIGHT_URL: testFlightUrl
    .optional()
    .messages({ 'any.invalid': '"TESTFLIGHT_URL" must be an https://testflight.apple.com link' }),
}).unknown(true);
