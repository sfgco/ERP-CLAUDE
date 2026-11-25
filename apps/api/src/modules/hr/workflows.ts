import type { WorkflowDefinitionInput } from '@eayni/shared';
import { APPRAISAL_STATE_AR, DISCIPLINARY_STATE_AR, OFFBOARDING_STATE_AR, OFFER_STATE_AR, PAYROLL_RUN_STATE_AR, REQUISITION_STATE_AR } from '@eayni/shared';

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
  version: 2, // v2 (owner review 2026-11-25, art. 72): the appeal's rejection opens the court-objection window; «اعتراض أمام المحكمة» holds the penalty until the ruling
  initialState: 'draft',
  states: {
    draft: { labelAr: DISCIPLINARY_STATE_AR.draft, category: 'open', owner: 'requester' },
    pending_approval: { labelAr: DISCIPLINARY_STATE_AR.pending_approval, category: 'open', slaBusinessDays: 2, owner: 'approver' },
    approved: { labelAr: DISCIPLINARY_STATE_AR.approved, category: 'open', owner: 'department' },
    delivered: { labelAr: DISCIPLINARY_STATE_AR.delivered, category: 'open', owner: 'requester' },
    appealed: { labelAr: DISCIPLINARY_STATE_AR.appealed, category: 'open', slaBusinessDays: 5, owner: 'approver' },
    objection_window: { labelAr: DISCIPLINARY_STATE_AR.objection_window, category: 'waiting', owner: 'department' },
    court_objection: { labelAr: DISCIPLINARY_STATE_AR.court_objection, category: 'waiting', owner: 'department' },
    upheld: { labelAr: DISCIPLINARY_STATE_AR.upheld, category: 'done' },
    withdrawn: { labelAr: DISCIPLINARY_STATE_AR.withdrawn, category: 'cancelled' },
  },
  transitions: [
    { code: 'submit', labelAr: 'رفع للاعتماد', from: ['draft'], to: 'pending_approval', allow: ['issuer', 'hr_officer', 'hr_manager'] },
    { code: 'approve', labelAr: 'اعتماد الإجراء', from: ['pending_approval'], to: 'approved', allow: ['approver'] },
    { code: 'reject', labelAr: 'رفض الإجراء', from: ['pending_approval'], to: 'withdrawn', allow: ['approver'], requireReason: true },
    { code: 'deliver', labelAr: 'إبلاغ الموظف كتابياً', from: ['approved'], to: 'delivered', allow: ['hr_officer', 'hr_manager'] },
    { code: 'acknowledge', labelAr: 'إقرار الموظف بالاستلام', from: ['delivered'], to: 'upheld', allow: ['subject'] },
    { code: 'appeal', labelAr: 'تظلم الموظف', from: ['delivered'], to: 'appealed', allow: ['subject'], requireReason: true },
    // No appeal inside the window → final (the daily job, or the approver).
    { code: 'uphold', labelAr: 'تثبيت الإجراء', from: ['delivered'], to: 'upheld', allow: ['approver', 'system'] },
    // Art. 72: the written rejection of the appeal opens the employee's window to object before the labour court; the penalty is not final yet.
    { code: 'reject_appeal', labelAr: 'رفض التظلم كتابياً', from: ['appealed'], to: 'objection_window', allow: ['approver', 'hr_manager'], requireReason: true },
    { code: 'withdraw', labelAr: 'سحب الإجراء', from: ['appealed', 'objection_window', 'approved', 'delivered', 'draft', 'pending_approval'], to: 'withdrawn', allow: ['approver', 'hr_manager'], requireReason: true },
    { code: 'court_objection', labelAr: 'تسجيل اعتراض أمام المحكمة', from: ['objection_window', 'appealed'], to: 'court_objection', allow: ['hr_officer', 'hr_manager'], requireReason: true },
    { code: 'court_uphold', labelAr: 'حكم المحكمة: تأييد الجزاء', from: ['court_objection'], to: 'upheld', allow: ['hr_manager'], requireReason: true },
    { code: 'court_cancel', labelAr: 'حكم المحكمة: إلغاء الجزاء', from: ['court_objection'], to: 'withdrawn', allow: ['hr_manager'], requireReason: true },
    // The court-objection window ended without an objection (system only, checked in the service).
    { code: 'finalize', labelAr: 'انتهاء مهلة الاعتراض — الجزاء نهائي', from: ['objection_window', 'appealed'], to: 'upheld', allow: ['system', 'hr_manager'] },
  ],
};

/**
 * H3b — HR_PLAN §4.3: «طلب احتياج وظيفي». Relations: requester · department_manager · hr_officer · hr_manager · approver
 * (the policy's approver role, or the executive above the thresholds — never the requester, FIN §12 pattern).
 */
export const REQUISITION_WORKFLOW: WorkflowDefinitionInput = {
  type: 'hr_requisition',
  nameAr: 'طلب توظيف',
  version: 1,
  initialState: 'draft',
  states: {
    draft: { labelAr: REQUISITION_STATE_AR.draft, category: 'open', owner: 'requester' },
    submitted: { labelAr: REQUISITION_STATE_AR.submitted, category: 'open', slaBusinessDays: 3, owner: 'approver' },
    needs_completion: { labelAr: REQUISITION_STATE_AR.needs_completion, category: 'waiting', owner: 'requester' },
    approved: { labelAr: REQUISITION_STATE_AR.approved, category: 'open', slaBusinessDays: 2, owner: 'department' },
    posted: { labelAr: REQUISITION_STATE_AR.posted, category: 'open', owner: 'department' },
    closed: { labelAr: REQUISITION_STATE_AR.closed, category: 'done' },
    rejected: { labelAr: REQUISITION_STATE_AR.rejected, category: 'done' },
    cancelled: { labelAr: REQUISITION_STATE_AR.cancelled, category: 'cancelled' },
  },
  transitions: [
    { code: 'submit', labelAr: 'رفع للاعتماد', from: ['draft', 'needs_completion'], to: 'submitted', allow: ['requester', 'hr_officer', 'hr_manager'] },
    { code: 'return', labelAr: 'إعادة للاستكمال', from: ['submitted'], to: 'needs_completion', allow: ['approver'], requireReason: true },
    { code: 'approve', labelAr: 'اعتماد', from: ['submitted'], to: 'approved', allow: ['approver'] },
    { code: 'reject', labelAr: 'رفض', from: ['submitted'], to: 'rejected', allow: ['approver'], requireReason: true },
    { code: 'post', labelAr: 'الإعلان عن الوظيفة', from: ['approved'], to: 'posted', allow: ['hr_officer', 'hr_manager'] },
    { code: 'close', labelAr: 'إغلاق', from: ['approved', 'posted'], to: 'closed', allow: ['hr_officer', 'hr_manager', 'system'] },
    { code: 'cancel', labelAr: 'إلغاء', from: ['draft', 'needs_completion', 'submitted', 'approved', 'posted'], to: 'cancelled', allow: ['requester', 'hr_manager'], requireReason: true },
  ],
};

/** H3b — HR_PLAN §4.4: «العرض الوظيفي». Relations: creator · hr_officer · hr_manager · approver · executive · system. */
export const OFFER_WORKFLOW: WorkflowDefinitionInput = {
  type: 'hr_offer',
  nameAr: 'عرض وظيفي',
  version: 1,
  initialState: 'draft',
  states: {
    draft: { labelAr: OFFER_STATE_AR.draft, category: 'open', owner: 'requester' },
    pending_approval: { labelAr: OFFER_STATE_AR.pending_approval, category: 'open', slaBusinessDays: 2, owner: 'approver' },
    approved: { labelAr: OFFER_STATE_AR.approved, category: 'open', owner: 'requester' },
    sent: { labelAr: OFFER_STATE_AR.sent, category: 'waiting', owner: 'none' },
    accepted: { labelAr: OFFER_STATE_AR.accepted, category: 'open', slaBusinessDays: 5, owner: 'requester' },
    declined: { labelAr: OFFER_STATE_AR.declined, category: 'done' },
    expired: { labelAr: OFFER_STATE_AR.expired, category: 'done' },
    withdrawn: { labelAr: OFFER_STATE_AR.withdrawn, category: 'cancelled' },
    contracted: { labelAr: OFFER_STATE_AR.contracted, category: 'open', owner: 'requester' },
    onboarded: { labelAr: OFFER_STATE_AR.onboarded, category: 'done' },
  },
  transitions: [
    { code: 'submit', labelAr: 'رفع للاعتماد', from: ['draft'], to: 'pending_approval', allow: ['creator', 'hr_officer', 'hr_manager'] },
    { code: 'approve', labelAr: 'اعتماد العرض', from: ['pending_approval'], to: 'approved', allow: ['approver'] },
    { code: 'reject', labelAr: 'رفض العرض', from: ['pending_approval'], to: 'draft', allow: ['approver'], requireReason: true },
    { code: 'send', labelAr: 'إرسال للمرشح', from: ['approved'], to: 'sent', allow: ['hr_officer', 'hr_manager'] },
    { code: 'accept', labelAr: 'تسجيل قبول المرشح', from: ['sent'], to: 'accepted', allow: ['hr_officer', 'hr_manager'] },
    { code: 'decline', labelAr: 'تسجيل رفض المرشح', from: ['sent'], to: 'declined', allow: ['hr_officer', 'hr_manager'], requireReason: true },
    { code: 'expire', labelAr: 'انتهاء الصلاحية', from: ['sent'], to: 'expired', allow: ['system', 'hr_manager'] },
    { code: 'withdraw', labelAr: 'سحب العرض', from: ['draft', 'pending_approval', 'approved', 'sent'], to: 'withdrawn', allow: ['hr_manager', 'creator'], requireReason: true },
    { code: 'contract', labelAr: 'استكمال إجراءات التعاقد', from: ['accepted'], to: 'contracted', allow: ['hr_officer', 'hr_manager'] },
    { code: 'onboard', labelAr: 'المباشرة', from: ['contracted'], to: 'onboarded', allow: ['system', 'hr_officer', 'hr_manager'] },
  ],
};

/**
 * H3b — HR_PLAN §4.8 + docs/HR_H3B_LEGAL.md E25: «إنهاء الخدمة». Relations: requester · subject (the leaving employee) ·
 * direct_manager · hr_officer · hr_manager · approver · system. The art. 79 bis clock is kept by the service.
 */
export const OFFBOARDING_WORKFLOW: WorkflowDefinitionInput = {
  type: 'hr_offboarding',
  nameAr: 'إنهاء الخدمة',
  version: 1,
  initialState: 'requested',
  states: {
    resignation_submitted: { labelAr: OFFBOARDING_STATE_AR.resignation_submitted, category: 'open', slaBusinessDays: 10, owner: 'approver' },
    resignation_postponed: { labelAr: OFFBOARDING_STATE_AR.resignation_postponed, category: 'waiting', owner: 'approver' },
    resignation_withdrawn: { labelAr: OFFBOARDING_STATE_AR.resignation_withdrawn, category: 'cancelled' },
    requested: { labelAr: OFFBOARDING_STATE_AR.requested, category: 'open', owner: 'requester' },
    under_review: { labelAr: OFFBOARDING_STATE_AR.under_review, category: 'open', slaBusinessDays: 3, owner: 'approver' },
    approved: { labelAr: OFFBOARDING_STATE_AR.approved, category: 'open', owner: 'department' },
    completed: { labelAr: OFFBOARDING_STATE_AR.completed, category: 'done' },
    rejected: { labelAr: OFFBOARDING_STATE_AR.rejected, category: 'done' },
    cancelled: { labelAr: OFFBOARDING_STATE_AR.cancelled, category: 'cancelled' },
  },
  transitions: [
    { code: 'submit', labelAr: 'رفع للمراجعة', from: ['requested'], to: 'under_review', allow: ['requester', 'hr_officer', 'hr_manager', 'system'] },
    { code: 'approve', labelAr: 'مراجعة واعتماد الإجراء', from: ['under_review'], to: 'approved', allow: ['approver'] },
    { code: 'reject', labelAr: 'رفض', from: ['under_review'], to: 'rejected', allow: ['approver'], requireReason: true },
    { code: 'complete', labelAr: 'إقفال — منتهي الخدمة', from: ['approved'], to: 'completed', allow: ['hr_officer', 'hr_manager', 'system'] },
    { code: 'cancel', labelAr: 'إلغاء', from: ['requested', 'under_review', 'approved'], to: 'cancelled', allow: ['hr_manager'], requireReason: true },
    // E25 — art. 79 bis
    { code: 'accept_resignation', labelAr: 'قبول الاستقالة', from: ['resignation_submitted', 'resignation_postponed'], to: 'approved', allow: ['approver', 'system'] },
    { code: 'postpone_resignation', labelAr: 'تأجيل قبول الاستقالة (حتى 60 يوماً، بسبب)', from: ['resignation_submitted'], to: 'resignation_postponed', allow: ['approver'], requireReason: true, requiredFields: ['resignation.postponedUntil'] },
    { code: 'withdraw_resignation', labelAr: 'العدول عن الاستقالة (خلال 7 أيام)', from: ['resignation_submitted', 'resignation_postponed'], to: 'resignation_withdrawn', allow: ['subject'] },
  ],
};

export const HR_WORKFLOWS: WorkflowDefinitionInput[] = [PAYROLL_RUN_WORKFLOW, APPRAISAL_WORKFLOW, DISCIPLINARY_WORKFLOW, REQUISITION_WORKFLOW, OFFER_WORKFLOW, OFFBOARDING_WORKFLOW];
