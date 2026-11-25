import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { auth, loginAs, makeDepartment, makeUser, testApp } from './test/helpers';
import { setSetting } from './core/settings/service';
import { SYSTEM_ACTOR } from './core/http/context';

/**
 * Department smoke test (docs/WORKTREES.md §4): every department's API is mounted and answers a user who holds that
 * department's roles. Work on one department's worktree must never make another department disappear — a 404 on any
 * of these routes, or a missing permission, fails CI for every branch.
 *
 * Add a row when a department module lands (Finance phase 1, CS, Operations, …): its roles, its list endpoints and the
 * permission resources its navigation relies on.
 */
const DEPARTMENTS: { code: string; roles: string[]; endpoints: string[]; permissions: string[] }[] = [
  {
    code: 'sales',
    roles: ['employee', 'sales_manager'],
    endpoints: ['/crm/meta', '/crm/customers', '/crm/leads', '/sales/home', '/sales/opportunities', '/sales/requests', '/sales/requests/meta', '/sales/quotes', '/sales/pricelist', '/sales/contracts', '/sales/management/kpi', '/sales/management/dashboard', '/sales/management/library'],
    permissions: ['crm.customers', 'crm.leads', 'sales.opportunities', 'sales.requests', 'sales.quotes', 'sales.pricelist', 'sales.contracts', 'sales.dashboard', 'sales.kpi'],
  },
  {
    code: 'hr',
    roles: ['employee', 'hr_manager'],
    endpoints: ['/hr/employees', '/hr/org-chart', '/hr/requests', '/hr/requests/types', '/hr/attendance/policy', '/hr/attendance/days', '/hr/shifts', '/hr/leave/policies', '/hr/leave/balances', '/hr/payroll', '/hr/performance/cycles', '/hr/performance/kpis', '/hr/discipline/policy', '/hr/discipline', '/hr/training/trainings', '/hr/recruitment/policy', '/hr/recruitment/requisitions', '/hr/recruitment/offers', '/hr/offboarding/policy', '/hr/offboarding', '/hr/dashboard/hr', '/hr/dashboard/expiring'],
    permissions: ['hr.employees', 'hr.requests', 'hr.attendance', 'hr.shifts', 'hr.leave', 'hr.payroll', 'hr.appraisals', 'hr.discipline', 'hr.training', 'hr.recruitment', 'hr.offers', 'hr.offboarding'],
  },
  {
    code: 'finance',
    roles: ['employee', 'finance_manager'],
    endpoints: ['/finance/payroll', '/finance/invoices'],
    permissions: ['finance.payroll', 'finance.invoices'],
  },
  {
    code: 'portal',
    roles: ['employee'],
    endpoints: ['/hr/requests/types', '/hr/requests', '/hr/attendance/policy', '/tickets/targets', '/tickets', '/news', '/tasks', '/calendar/events?from=2026-01-01&to=2026-01-31', '/notifications'],
    permissions: ['hr.requests', 'tickets', 'news', 'tasks', 'calendar', 'notifications'],
  },
];

describe('department smoke — every department answers for its own roles (docs/WORKTREES.md §4)', () => {
  for (const d of DEPARTMENTS) {
    it(`${d.code}: ${d.endpoints.length} routes mounted and ${d.permissions.length} permissions granted`, async () => {
      await setSetting('auth.mfaRequiredRoles', [], SYSTEM_ACTOR);
      const dep = await makeDepartment(d.code, d.code);
      const email = `${d.code}.smoke@eayni.local`;
      await makeUser(email, d.roles.map((role) => ({ role, ...(role === 'department_manager' ? { departmentId: String(dep._id) } : {}) })), { departmentId: dep._id });
      const token = await loginAs(email);
      const me = await request(testApp()).get('/api/v1/auth/me').set(auth(token));
      expect(me.status).toBe(200);
      const granted = new Set((me.body.permissions ?? me.body.user?.permissions ?? []).map((p: { resource: string }) => p.resource));
      const missingPermissions = d.permissions.filter((p) => !granted.has(p));
      expect(missingPermissions, `permissions missing for ${d.roles.join('+')}`).toEqual([]);
      const results = await Promise.all(d.endpoints.map(async (path) => ({ path, status: (await request(testApp()).get(`/api/v1${path}`).set(auth(token))).status })));
      // 200 = answered; anything else (404 route gone, 403 permission gone, 500 module broken) names the department that disappeared.
      expect(results.filter((r) => r.status !== 200), `${d.code} routes that stopped answering`).toEqual([]);
    });
  }
});
