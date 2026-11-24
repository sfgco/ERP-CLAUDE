import type { WorkflowDefinitionInput } from '@eayni/shared';
import { APPRAISAL_STATE_AR, DISCIPLINARY_STATE_AR, PAYROLL_RUN_STATE_AR } from '@eayni/shared';

/**
 * HR H3a workflow definitions (core engine, editable in /admin/workflows) — HR_PLAN §4.5–4.7. Actor relations are
 * computed by the HR services: preparer · hr_officer · hr_manager · finance_staff · finance_manager · direct_manager ·
 * subject (the appraised / disciplined employee — never the role code `employee`, which everyone holds) · issuer · approver · system. Segregation of duties (FIN §12) is enforced in the service on top of these rules.
 */
export const PAYROLL_RUN_WORKFLOW: WorkflowDefinitionInput = {
  type: 'hr_payroll_run',
  nameAr: 'مسير الرواتب',
  version: 1,
  initialState: 'draft',
  states: {
    draft: { labelAr: PAYROLL_RUN_STATE_AR.draft, category: 'open', owner: 'requester' },
    under_hr_review: { labelAr: PAYROLL_RUN_STATE_AR.under_hr_review, category: 'open', slaBusinessDays: 2, owner: 'approver' },
    returned: { labelAr: PAYROLL_RUN_STATE_AR.returned, category: 'waiting', owner: 'requester' },
    hr_approved: { labelAr: PAYROLL_RUN_STATE_AR.hr_approved, category: 'open', owner: 'approver' },
    at_finance: { labelAr: PAYROLL_RUN_STATE_AR.at_finance, category: 'open', slaBusinessDays: 3, owner: 'approver' },
    finance_returned: { labelAr: PAYROLL_RUN_STATE_AR.finance_returned, category: 'waiting', owner: 'approver' },
    finance_approved: { labelAr: PAYROLL_RUN_STATE_AR.finance_approved, category: 'open', owner: 'approver' },
    paid: { labelAr: PAYROLL_RUN_STATE_AR.paid, category: 'open', owner: 'none' },
    closed: { labelAr: PAYROLL_RUN_STATE_AR.closed, category: 'done' },
    cancelled: { labelAr: PAYROLL_RUN_STATE_AR.cancelled, category: 'cancelled' },
  },
  transitions: [
    { code: 'submit_for_review', labelAr: 'رفع للمراجعة', from: ['draft', 'returned'], to: 'under_hr_review', allow: ['preparer', 'hr_officer', 'hr_manager'] },
    { code: 'return', labelAr: 'إعادة للتعديل', from: ['under_hr_review'], to: 'returned', allow: ['hr_manager'], requireReason: true },
    { code: 'hr_approve', labelAr: 'اعتماد الموارد البشرية', from: ['under_hr_review'], to: 'hr_approved', allow: ['hr_manager'] },
    { code: 'send_to_finance', labelAr: 'رفع إلى المالية', from: ['hr_approved', 'finance_returned'], to: 'at_finance', allow: ['hr_manager', 'system'] },
    { code: 'finance_return', labelAr: 'إعادة من المالية (يحتاج استكمال)', from: ['at_finance'], to: 'finance_returned', allow: ['finance_staff', 'finance_manager'], requireReason: true },
    { code: 'finance_approve', labelAr: 'اعتماد المالية', from: ['at_finance'], to: 'finance_approved', allow: ['finance_manager'] },
    { code: 'record_payment', labelAr: 'تسجيل الصرف', from: ['finance_approved'], to: 'paid', allow: ['finance_staff', 'finance_manager'] },
    { code: 'close', labelAr: 'إغلاق', from: ['paid'], to: 'closed', allow: ['hr_manager', 'hr_officer', 'system'] },
    { code: 'cancel', labelAr: 'إلغاء المسير', from: ['draft', 'returned', 'under_hr_review', 'hr_approved', 'finance_returned'], to: 'cancelled', allow: ['hr_manager'], requireReason: true },
  ],
};

export const APPRAISAL_WORKFLOW: WorkflowDefinitionInput = {
  type: 'hr_appraisal',
  nameAr: 'تقييم الأداء',
  version: 1,
  initialState: 'open',
  states: {
    open: { labelAr: APPRAISAL_STATE_AR.open, category: 'open', owner: 'direct_manager' },
    manager_submitted: { labelAr: APPRAISAL_STATE_AR.manager_submitted, category: 'open', slaBusinessDays: 3, owner: 'approver' },
    returned: { labelAr: APPRAISAL_STATE_AR.returned, category: 'waiting', owner: 'direct_manager' },
    approved: { labelAr: APPRAISAL_STATE_AR.approved, category: 'open', slaBusinessDays: 5, owner: 'requester' },
    acknowledged: { labelAr: APPRAISAL_STATE_AR.acknowledged, category: 'done' },
    cancelled: { labelAr: APPRAISAL_STATE_AR.cancelled, category: 'cancelled' },
  },
  transitions: [
    { code: 'submit', labelAr: 'تسليم التقييم', from: ['open', 'returned'], to: 'manager_submitted', allow: ['direct_manager'] },
    { code: 'return', labelAr: 'إعادة للمدير', from: ['manager_submitted'], to: 'returned', allow: ['hr_officer', 'hr_manager'], requireReason: true },
    { code: 'approve', labelAr: 'اعتماد التقييم', from: ['manager_submitted'], to: 'approved', allow: ['hr_officer', 'hr_manager'] },
    { code: 'acknowledge', labelAr: 'إقرار الموظف بالاطلاع', from: ['approved'], to: 'acknowledged', allow: ['subject'] },
    { code: 'cancel', labelAr: 'إلغاء', from: ['open', 'returned', 'manager_submitted'], to: 'cancelled', allow: ['hr_manager'], requireReason: true },
  ],
};

export const DISCIPLINARY_WORKFLOW: WorkflowDefinitionInput = {
  type: 'hr_disciplinary',
  nameAr: 'إجراء إداري',
  version: 1,
  initialState: 'draft',
  states: {
    draft: { labelAr: DISCIPLINARY_STATE_AR.draft, category: 'open', owner: 'requester' },
    pending_approval: { labelAr: DISCIPLINARY_STATE_AR.pending_approval, category: 'open', slaBusinessDays: 2, owner: 'approver' },
    approved: { labelAr: DISCIPLINARY_STATE_AR.approved, category: 'open', owner: 'department' },
    delivered: { labelAr: DISCIPLINARY_STATE_AR.delivered, category: 'open', owner: 'requester' },
    appealed: { labelAr: DISCIPLINARY_STATE_AR.appealed, category: 'open', slaBusinessDays: 5, owner: 'approver' },
    upheld: { labelAr: DISCIPLINARY_STATE_AR.upheld, category: 'done' },
    withdrawn: { labelAr: DISCIPLINARY_STATE_AR.withdrawn, category: 'cancelled' },
  },
  transitions: [
    { code: 'submit', labelAr: 'رفع للاعتماد', from: ['draft'], to: 'pending_approval', allow: ['issuer', 'hr_officer', 'hr_manager'] },
    { code: 'approve', labelAr: 'اعتماد الإجراء', from: ['pending_approval'], to: 'approved', allow: ['approver'] },
    { code: 'reject', labelAr: 'رفض الإجراء', from: ['pending_approval'], to: 'withdrawn', allow: ['approver'], requireReason: true },
    { code: 'deliver', labelAr: 'إبلاغ الموظف كتابياً', from: ['approved'], to: 'delivered', allow: ['hr_officer', 'hr_manager'] },
    { code: 'acknowledge', labelAr: 'إقرار الموظف بالاستلام', from: ['delivered'], to: 'upheld', allow: ['subject'] },
    { code: 'appeal', labelAr: 'اعتراض الموظف', from: ['delivered'], to: 'appealed', allow: ['subject'], requireReason: true },
    { code: 'uphold', labelAr: 'تثبيت الإجراء', from: ['appealed', 'delivered'], to: 'upheld', allow: ['approver', 'system'] },
    { code: 'withdraw', labelAr: 'سحب الإجراء', from: ['appealed', 'approved', 'delivered', 'draft', 'pending_approval'], to: 'withdrawn', allow: ['approver', 'hr_manager'], requireReason: true },
  ],
};

export const HR_WORKFLOWS: WorkflowDefinitionInput[] = [PAYROLL_RUN_WORKFLOW, APPRAISAL_WORKFLOW, DISCIPLINARY_WORKFLOW];
