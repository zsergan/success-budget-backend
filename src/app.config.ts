import { BadRequestException, INestApplication, ValidationError, ValidationPipe, VersioningType } from '@nestjs/common';
import helmet from 'helmet';

import { HttpExceptionFilter } from '@shared/http-exception.filter';

export function configureApp(app: INestApplication): void {
  app.use(helmet());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (validationErrors: ValidationError[] = []) => {
        return new BadRequestException(
          validationErrors.map((error) => ({
            field: error.property,
            error: Object.values(error.constraints).join(', '),
          })),
        );
      },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
}
