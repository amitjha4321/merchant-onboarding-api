import { Role } from '../users/role.enum';

/** The principal attached to `request.user` after JWT validation. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}
