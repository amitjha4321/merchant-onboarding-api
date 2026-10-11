import { AuthenticatedUser } from '../../auth/authenticated-user.interface';
import { Role } from '../../users/role.enum';
import { MerchantApplication } from '../application.entity';

/** Column filters that restrict which applications a principal can see at all. */
export type ApplicationScope = { createdById?: string; assignedReviewerId?: string };

/**
 * Object-level authorization rules for merchant applications, kept pure so they can be
 * unit-tested exhaustively and reused by every query/command.
 *
 * Visibility is enforced *in the query* (see `scopeFor`) so an out-of-scope record is
 * indistinguishable from a non-existent one (404), which prevents ID enumeration.
 */
export class ApplicationPolicy {
  /** ADMIN: everything. SALES: only what they created. REVIEWER: only what is assigned to them. */
  static scopeFor(user: AuthenticatedUser): ApplicationScope {
    // TypeORM treats `undefined` in a where-clause as "no filter". Never let a missing id
    // silently widen a scope to every row.
    if (!user?.id) throw new Error('Cannot build application scope without a principal id');
    switch (user.role) {
      case Role.ADMIN:
        return {};
      case Role.SALES:
        return { createdById: user.id };
      case Role.REVIEWER:
        return { assignedReviewerId: user.id };
      default:
        // Unknown role: deny by matching nothing.
        throw new Error(`No application scope defined for role ${String(user.role)}`);
    }
  }

  static canView(user: AuthenticatedUser, app: MerchantApplication): boolean {
    const scope = this.scopeFor(user);
    return Object.entries(scope).every(
      ([key, value]) => app[key as keyof ApplicationScope] === value,
    );
  }

  /** Edit and submit share the same rule: the SALES owner, or an ADMIN. */
  static canEdit(user: AuthenticatedUser, app: MerchantApplication): boolean {
    if (user.role === Role.ADMIN) return true;
    return user.role === Role.SALES && app.createdById === user.id;
  }

  static canAssign(user: AuthenticatedUser): boolean {
    return user.role === Role.ADMIN;
  }

  /** Only the currently assigned REVIEWER may record a decision — not even an ADMIN. */
  static canDecide(user: AuthenticatedUser, app: MerchantApplication): boolean {
    return (
      user.role === Role.REVIEWER &&
      app.assignedReviewerId !== null &&
      app.assignedReviewerId === user.id
    );
  }
}
