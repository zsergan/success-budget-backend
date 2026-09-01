import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

describe('JwtAuthGuard', () => {
  const createContext = () =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  // super.canActivate() runs real Passport strategy lookup, so spy on the
  // actual parent prototype (not a fresh AuthGuard('jwt') call, which would
  // be a different class) to isolate the @Public() short-circuit from it.
  const parentGuard = Object.getPrototypeOf(JwtAuthGuard.prototype);

  it('allows the request through without checking the token when the route is public', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);
    const superCanActivate = jest.spyOn(parentGuard, 'canActivate');

    const result = guard.canActivate(createContext());

    expect(result).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
    expect(superCanActivate).not.toHaveBeenCalled();

    superCanActivate.mockRestore();
  });

  it('delegates to the JWT strategy when the route is not public', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);
    const superCanActivate = jest.spyOn(parentGuard, 'canActivate').mockReturnValue(true as never);

    const result = guard.canActivate(createContext());

    expect(result).toBe(true);
    expect(superCanActivate).toHaveBeenCalledTimes(1);

    superCanActivate.mockRestore();
  });
});
