import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../users/role.enum';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

const ctx = (user?: { role: Role }) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const reflectorWith = (meta: Record<string, unknown>) =>
  ({ getAllAndOverride: (key: string) => meta[key] }) as unknown as Reflector;

describe('RolesGuard', () => {
  it('allows when no roles are required', () => {
    expect(new RolesGuard(reflectorWith({})).canActivate(ctx({ role: Role.SALES }))).toBe(true);
  });

  it('allows public routes without a user', () => {
    expect(new RolesGuard(reflectorWith({ [IS_PUBLIC_KEY]: true })).canActivate(ctx())).toBe(true);
  });

  it('allows a matching role', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [Role.ADMIN, Role.SALES] }));
    expect(guard.canActivate(ctx({ role: Role.SALES }))).toBe(true);
  });

  it('forbids a non-matching role or a missing user', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [Role.ADMIN] }));
    expect(() => guard.canActivate(ctx({ role: Role.REVIEWER }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx())).toThrow(ForbiddenException);
  });
});
