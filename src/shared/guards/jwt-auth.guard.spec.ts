import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from '@shared/decorators/public.decorator';

describe('JwtAuthGuard', () => {
  const handler = () => undefined;
  const createContext = () => new ExecutionContextHost([], JwtAuthGuard, handler);

  // super.canActivate() runs real Passport strategy lookup, so spy on the
  // actual parent prototype (not a fresh AuthGuard('jwt') call, which would
  // be a different class) to isolate the @Public() short-circuit from it.
  const parentGuard = Object.getPrototypeOf(JwtAuthGuard.prototype);

  it('allows the request through without checking the token when the route is public', () => {
    const reflector = new Reflector();
    const getAllAndOverride = jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const guard = new JwtAuthGuard(reflector);
    const superCanActivate = jest.spyOn(parentGuard, 'canActivate');

    const result = guard.canActivate(createContext());

    expect(result).toBe(true);
    expect(getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [handler, JwtAuthGuard]);
    expect(superCanActivate).not.toHaveBeenCalled();

    superCanActivate.mockRestore();
  });

  it('delegates to the JWT strategy when the route is not public', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const guard = new JwtAuthGuard(reflector);
    const superCanActivate = jest.spyOn(parentGuard, 'canActivate').mockReturnValue(true);

    const result = guard.canActivate(createContext());

    expect(result).toBe(true);
    expect(superCanActivate).toHaveBeenCalledTimes(1);

    superCanActivate.mockRestore();
  });
});
