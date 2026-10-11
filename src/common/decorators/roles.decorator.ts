import { SetMetadata } from '@nestjs/common';
import { Role } from '../../users/role.enum';

export const ROLES_KEY = 'roles';
/** Coarse-grained role check. Object-level rules live in the domain policies. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
