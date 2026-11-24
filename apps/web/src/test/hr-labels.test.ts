import { describe, expect, it } from 'vitest';
import {
  CONTRACT_STATUS_AR,
  CONTRACT_TYPE_AR,
  EMPLOYEE_STATUS_AR,
  EMPLOYMENT_TYPE_AR,
  HR_REQUEST_STATE_AR,
  HR_REQUEST_TYPE_AR,
  IDENTITY_TYPE_AR,
  LEAVE_TYPE_AR,
} from '@eayni/shared';
import ar from '../locales/ar/common.json';

/**
 * H1 audit item 12: the Arabic labels of the HR enums live twice — in `packages/shared` (used by the API, exports and
 * certificates) and in the web locale. The spec's words are verbatim in both, so the two must never drift apart
 * [HR §3.1.6–3.1.7, §3.5, §3.9; prompt §0 "labels are verbatim"].
 */
const pairs: [string, Record<string, string>, Record<string, string>][] = [
  ['hr.status', EMPLOYEE_STATUS_AR, ar.hr.status],
  ['hr.employmentTypes', EMPLOYMENT_TYPE_AR, ar.hr.employmentTypes],
  ['hr.contractTypes', CONTRACT_TYPE_AR, ar.hr.contractTypes],
  ['hr.contractStatuses', CONTRACT_STATUS_AR, ar.hr.contractStatuses],
  ['hr.identityTypes', IDENTITY_TYPE_AR, ar.hr.identityTypes],
  ['requests.types', HR_REQUEST_TYPE_AR, ar.requests.types],
  ['requests.states', HR_REQUEST_STATE_AR, ar.requests.states],
  ['requests.leaveTypes', LEAVE_TYPE_AR, ar.requests.leaveTypes],
];

describe('HR enum labels: shared package and Arabic locale agree', () => {
  for (const [key, shared, locale] of pairs) {
    it(`${key} has the same codes and the same Arabic words in both places`, () => {
      expect(Object.keys(locale).sort()).toEqual(Object.keys(shared).sort());
      const diff = Object.entries(shared).filter(([k, v]) => locale[k] !== v);
      expect(diff).toEqual([]);
    });
  }
  it('the spec statuses of HR §3.1.7 are all present in the merged list (DECISIONS §6)', () => {
    const values = Object.values(EMPLOYEE_STATUS_AR);
    for (const w of ['على رأس العمل', 'إجازة', 'موقوف', 'منتهي الخدمة']) expect(values).toContain(w);
  });
  it('the request states of HR §3.5 are verbatim', () => {
    expect(Object.values(HR_REQUEST_STATE_AR)).toEqual([
      'جديد',
      'قيد المراجعة',
      'بانتظار موافقة المدير',
      'بانتظار الموارد البشرية',
      'بانتظار الاعتماد النهائي',
      'يحتاج استكمال',
      'معتمد',
      'مرفوض',
      'مغلق',
    ]);
  });
});
