import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ar from '../locales/ar/common.json';

/**
 * Department smoke test, web side (docs/WORKTREES.md §4): every department keeps its routes in the router, its entries
 * in the navigation, their Arabic labels, its API routers mounted and its module registered. A branch that drops any of
 * them — however the drop happened (a bad merge, a rename, a deleted page) — fails CI before it reaches main.
 */
const webSrc = fileURLToPath(new URL('..', import.meta.url));
const repo = join(webSrc, '..', '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const router = read('apps/web/src/router.tsx');
const nav = read('apps/web/src/shared/layout/AppShell.tsx');
const app = read('apps/api/src/app.ts');
const bootstrap = read('apps/api/src/bootstrap.ts');

const DEPARTMENTS: { code: string; routes: string[]; nav: string[]; apiMounts: string[]; modules: string[] }[] = [
  {
    code: 'sales',
    routes: ['/sales', '/sales/customers', '/sales/pipeline', '/sales/leads', '/sales/requests', '/sales/quotes', '/sales/pricelist', '/sales/discount-matrix', '/sales/contracts', '/sales/invoices', '/sales/kpi', '/sales/targets', '/incoming'],
    nav: ['/sales', '/sales/customers', '/sales/pipeline', '/sales/leads', '/sales/requests', '/sales/quotes', '/sales/pricelist', '/sales/contracts', '/sales/invoices', '/sales/kpi'],
    apiMounts: ['/crm', '/sales/requests', '/sales/pricelist', '/sales/quotes', '/sales/contracts', '/sales/management', '/sales'],
    modules: ['registerSalesModule', 'registerCrmModule'],
  },
  {
    code: 'hr',
    routes: ['/hr', '/hr/employees', '/hr/dashboard', '/hr/org-chart', '/hr/requests', '/hr/attendance', '/hr/shifts', '/hr/leave', '/hr/payroll', '/hr/performance', '/hr/discipline', '/hr/training', '/hr/recruitment', '/hr/offboarding', '/hr/export'],
    nav: ['/hr', '/hr/employees', '/hr/dashboard', '/hr/requests', '/hr/attendance', '/hr/shifts', '/hr/leave', '/hr/payroll', '/hr/performance', '/hr/discipline', '/hr/training', '/hr/recruitment', '/hr/offboarding'],
    apiMounts: ['/hr', '/hr/requests', '/hr/attendance', '/hr/shifts', '/hr/leave', '/hr/payroll', '/hr/performance', '/hr/discipline', '/hr/training', '/hr/recruitment', '/hr/offboarding', '/hr/dashboard'],
    modules: ['registerHrModule'],
  },
  {
    code: 'finance',
    routes: ['/finance/payroll', '/finance/settlements', '/sales/invoices'],
    nav: ['/finance/payroll', '/finance/settlements', '/sales/invoices'],
    apiMounts: ['/finance/payroll', '/finance/settlements', '/finance/invoices'],
    modules: ['registerFinanceModule'],
  },
  {
    code: 'portal',
    routes: ['/', '/me/profile', '/me/requests', '/me/attendance', '/me/payslips', '/me/performance', '/me/training', '/me/tickets', '/tickets', '/news', '/tasks', '/tasks/board', '/calendar', '/notifications'],
    nav: ['/', '/me/profile', '/me/requests', '/me/attendance', '/me/payslips', '/me/tickets', '/tasks', '/calendar', '/news', '/notifications'],
    apiMounts: ['/tickets', '/news', '/tasks', '/calendar', '/notifications'],
    modules: ['registerTicketsModule', 'registerNewsModule'],
  },
];

const routePaths = new Set([...router.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]));
const navEntries = [...nav.matchAll(/to:\s*'([^']+)'[^}]*?label:\s*t\('([^']+)'\)/gs)].map((m) => ({ to: m[1], label: m[2] }));
const navPaths = new Set(navEntries.map((e) => e.to));
const mounts = new Set([...app.matchAll(/v1\.use\('([^']+)'/g)].map((m) => m[1]));
const label = (key: string) => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ar);

describe('department smoke — routes, navigation, labels, API mounts and module registration never disappear', () => {
  for (const d of DEPARTMENTS) {
    it(`${d.code} is present everywhere`, () => {
      expect(d.routes.filter((r) => !routePaths.has(r)), `${d.code} routes missing from router.tsx`).toEqual([]);
      expect(d.nav.filter((r) => !navPaths.has(r)), `${d.code} navigation entries missing from AppShell.tsx`).toEqual([]);
      const unlabeled = navEntries.filter((e) => d.nav.includes(e.to) && typeof label(e.label) !== 'string').map((e) => `${e.to} → ${e.label}`);
      expect(unlabeled, `${d.code} navigation labels missing from the Arabic locale`).toEqual([]);
      expect(d.apiMounts.filter((m) => !mounts.has(m)), `${d.code} API routers not mounted in app.ts`).toEqual([]);
      expect(d.modules.filter((m) => !bootstrap.includes(`${m}(`)), `${d.code} modules not registered in bootstrap.ts`).toEqual([]);
    });
  }
  it('the departments table of scripts/wt.mjs names every module that exists in the API', () => {
    const wt = read('scripts/wt.mjs');
    for (const m of ['sales', 'hr', 'finance']) expect(wt).toContain(`apps/api/src/modules/${m}/`);
  });
});
