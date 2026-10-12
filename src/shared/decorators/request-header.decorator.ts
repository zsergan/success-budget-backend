import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

// Unlike @Headers(), a custom decorator takes pipes: @RequestHeader('if-match', SomePipe)
export const RequestHeader = createParamDecorator((name: string, context: ExecutionContext): string | undefined => {
  const value = context.switchToHttp().getRequest<Request>().headers[name.toLowerCase()];

  return Array.isArray(value) ? value.join(', ') : value;
});
