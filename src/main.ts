import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.config';

async function bootstrap() {
  // bufferLogs holds Nest's own bootstrap-time log lines until useLogger()
  // below wires up pino, so they go through it too instead of the default
  // console logger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // Surfaces the real stack trace/error class on the pino `err` property for
  // caught exceptions - without it pino-http logs a generic HttpException
  // wrapper instead of the actual error that was thrown.
  app.useGlobalInterceptors(new LoggerErrorInterceptor());
  app.enableShutdownHooks();
  configureApp(app);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Success Budget API')
    .setDescription('Personal budget tracking API - wallets, transactions, categories, and spending limits.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  await app.listen(3000);
}
bootstrap();
