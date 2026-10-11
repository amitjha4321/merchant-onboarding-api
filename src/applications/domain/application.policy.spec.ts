import { AuthenticatedUser } from '../../auth/authenticated-user.interface';
import { Role } from '../../users/role.enum';
import { MerchantApplication } from '../application.entity';
import { ApplicationPolicy } from './application.policy';

const user = (id: string, role: Role): AuthenticatedUser => ({
  id,
  role,
  email: `${id}@example.com`,
});
const app = (createdById: string, assignedReviewerId: string | null = null) =>
  ({ id: 'app-1', createdById, assignedReviewerId }) as MerchantApplication;

describe('ApplicationPolicy', () => {
  const admin = user('admin', Role.ADMIN);
  const sales = user('sales-1', Role.SALES);
  const otherSales = user('sales-2', Role.SALES);
  const reviewer = user('rev-1', Role.REVIEWER);
  const otherReviewer = user('rev-2', Role.REVIEWER);

  describe('scopeFor', () => {
    it('ADMIN sees everything', () => expect(ApplicationPolicy.scopeFor(admin)).toEqual({}));
    it('SALES is scoped to their own applications', () =>
      expect(ApplicationPolicy.scopeFor(sales)).toEqual({ createdById: 'sales-1' }));
    it('REVIEWER is scoped to applications assigned to them', () =>
      expect(ApplicationPolicy.scopeFor(reviewer)).toEqual({ assignedReviewerId: 'rev-1' }));
    it('never produces a scope with an undefined id (would match all rows)', () => {
      expect(() => ApplicationPolicy.scopeFor({ role: Role.SALES } as AuthenticatedUser)).toThrow();
    });
  });

  describe('canView', () => {
    it('SALES can view only their own', () => {
      expect(ApplicationPolicy.canView(sales, app('sales-1'))).toBe(true);
      expect(ApplicationPolicy.canView(otherSales, app('sales-1'))).toBe(false);
    });
    it('REVIEWER can view only assigned', () => {
      expect(ApplicationPolicy.canView(reviewer, app('sales-1', 'rev-1'))).toBe(true);
      expect(ApplicationPolicy.canView(otherReviewer, app('sales-1', 'rev-1'))).toBe(false);
      expect(ApplicationPolicy.canView(reviewer, app('sales-1', null))).toBe(false);
    });
  });

  describe('canEdit', () => {
    it('allows the creating SALES user and ADMIN', () => {
      expect(ApplicationPolicy.canEdit(sales, app('sales-1'))).toBe(true);
      expect(ApplicationPolicy.canEdit(admin, app('sales-1'))).toBe(true);
    });
    it('denies another SALES user and reviewers (even the assigned one)', () => {
      expect(ApplicationPolicy.canEdit(otherSales, app('sales-1'))).toBe(false);
      expect(ApplicationPolicy.canEdit(reviewer, app('sales-1', 'rev-1'))).toBe(false);
    });
  });

  describe('canDecide', () => {
    it('allows only the assigned reviewer', () => {
      expect(ApplicationPolicy.canDecide(reviewer, app('sales-1', 'rev-1'))).toBe(true);
    });
    it('denies other reviewers, ADMIN and SALES, and unassigned applications', () => {
      expect(ApplicationPolicy.canDecide(otherReviewer, app('sales-1', 'rev-1'))).toBe(false);
      expect(ApplicationPolicy.canDecide(admin, app('sales-1', 'rev-1'))).toBe(false);
      expect(ApplicationPolicy.canDecide(sales, app('sales-1', 'sales-1'))).toBe(false);
      expect(ApplicationPolicy.canDecide(reviewer, app('sales-1', null))).toBe(false);
    });
  });

  it('only ADMIN can assign', () => {
    expect(ApplicationPolicy.canAssign(admin)).toBe(true);
    expect(ApplicationPolicy.canAssign(reviewer)).toBe(false);
    expect(ApplicationPolicy.canAssign(sales)).toBe(false);
  });
});
