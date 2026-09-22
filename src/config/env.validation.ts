import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().required(),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_DATABASE: Joi.string().required(),
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
}).unknown(true);
