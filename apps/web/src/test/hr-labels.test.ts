import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_DAY_STATUS_AR,
  CORRECTION_KIND_AR,
  EXCEPTION_SCOPE_AR,
  LEAVE_ENTRY_TYPE_AR,
  PUNCH_TYPE_AR,
  SHIFT_KIND_AR,
  LATENESS_COUNTING_AR,
  PAYROLL_RUN_STATE_AR,
  APPRAISAL_STATE_AR,
  APPRAISAL_CYCLE_KIND_AR,
  GOAL_STATE_AR,
  IMPROVEMENT_PLAN_STATE_AR,
  DISCIPLINARY_STATE_AR,
  INVESTIGATION_MODE_AR,
  TRAINING_STATE_AR,
  TRAINING_PLAN_STATE_AR,
  TRAINING_NEED_STATE_AR,
  TRAINING_KIND_AR,
  PARTICIPANT_STATUS_AR,
  GOSI_GROUP_AR,
  CONTRACT_STATUS_AR,
  CONTRACT_TYPE_AR,
  EMPLOYEE_STATUS_AR,
  EMPLOYMENT_TYPE_AR,
  HR_REQUEST_STATE_AR,
  HR_REQUEST_TYPE_AR,
  IDENTITY_TYPE_AR,
  LEAVE_TYPE_AR,
  REQUISITION_STATE_AR,
  APPLICANT_STAGE_AR,
  INTERVIEW_STATE_AR,
  INTERVIEW_MODE_AR,
  INTERVIEW_RECOMMENDATION_AR,
  OFFER_STATE_AR,
  WAGE_PERIOD_AR,
  OFFBOARDING_STATE_AR,
  SETTLEMENT_STATE_AR,
  EOS_REASON_AR,
  SETTLEMENT_LINE_AR,
  OFFBOARDING_STEP_AR,
  HOLIDAY_KIND_AR,
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
  // H2 [HR §3.4, §3.5.1]
  ['requests.correctionKinds', CORRECTION_KIND_AR, ar.requests.correctionKinds],
  ['requests.exceptionScopes', EXCEPTION_SCOPE_AR, ar.requests.exceptionScopes],
  ['attendance.statuses', ATTENDANCE_DAY_STATUS_AR, ar.attendance.statuses],
  ['attendance.punchTypes', PUNCH_TYPE_AR, ar.attendance.punchTypes],
  ['shifts.kinds', SHIFT_KIND_AR, ar.shifts.kinds],
  ['leave.entryTypes', LEAVE_ENTRY_TYPE_AR, ar.leave.entryTypes],
  ['attendance.latenessCounting', LATENESS_COUNTING_AR, ar.attendance.latenessCounting],
  // H3a [HR §3.6–3.8]
  ['payroll.states', PAYROLL_RUN_STATE_AR, ar.payroll.states],
  ['payroll.gosiGroups', GOSI_GROUP_AR, ar.payroll.gosiGroups],
  ['performance.states', APPRAISAL_STATE_AR, ar.performance.states],
  ['performance.kinds', APPRAISAL_CYCLE_KIND_AR, ar.performance.kinds],
  ['performance.goalStates', GOAL_STATE_AR, ar.performance.goalStates],
  ['performance.planStates', IMPROVEMENT_PLAN_STATE_AR, ar.performance.planStates],
  ['discipline.states', DISCIPLINARY_STATE_AR, ar.discipline.states],
  ['discipline.investigationModes', INVESTIGATION_MODE_AR, ar.discipline.investigationModes],
  ['training.states', TRAINING_STATE_AR, ar.training.states],
  ['training.planStates', TRAINING_PLAN_STATE_AR, ar.training.planStates],
  ['training.needStates', TRAINING_NEED_STATE_AR, ar.training.needStates],
  ['training.kinds', TRAINING_KIND_AR, ar.training.kinds],
  ['training.participantStatuses', PARTICIPANT_STATUS_AR, ar.training.participantStatuses],
  // H3b [HR §3.2, §3.10; docs/HR_H3B_LEGAL.md]
  ['recruitment.states', REQUISITION_STATE_AR, ar.recruitment.states],
  ['recruitment.stages', APPLICANT_STAGE_AR, ar.recruitment.stages],
  ['recruitment.interviewStates', INTERVIEW_STATE_AR, ar.recruitment.interviewStates],
  ['recruitment.modes', INTERVIEW_MODE_AR, ar.recruitment.modes],
  ['recruitment.recommendations', INTERVIEW_RECOMMENDATION_AR, ar.recruitment.recommendations],
  ['recruitment.offerStates', OFFER_STATE_AR, ar.recruitment.offerStates],
  ['recruitment.wagePeriods', WAGE_PERIOD_AR, ar.recruitment.wagePeriods],
  ['offboarding.states', OFFBOARDING_STATE_AR, ar.offboarding.states],
  ['offboarding.settlementStates', SETTLEMENT_STATE_AR, ar.offboarding.settlementStates],
  ['offboarding.reasons', EOS_REASON_AR, ar.offboarding.reasons],
  ['offboarding.lines', SETTLEMENT_LINE_AR, ar.offboarding.lines],
  ['offboarding.step', OFFBOARDING_STEP_AR, ar.offboarding.step],
  ['holidays.kinds', HOLIDAY_KIND_AR, ar.holidays.kinds],
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
