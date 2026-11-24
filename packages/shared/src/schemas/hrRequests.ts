import { z } from 'zod';
import { objectIdSchema, riyadhDaySchema } from './common';

/** Self-service request types [HR §3.5]. */
export const HR_REQUEST_TYPES = [
  'leave',
  'permission',
  'remote_work',
  'salary_certificate',
  'experience_certificate',
  'advance',
  'data_update',
  'official_letter',
  // H2 [HR §3.4 ثالثاً، ثانياً 6; DECISIONS §21 Q16]: the attendance requests travel on the same HRQ- series.
  'attendance_correction',
  'geofence_exception',
  'overtime',
] as const;
export type HrRequestType = (typeof HR_REQUEST_TYPES)[number];
export const HR_REQUEST_TYPE_AR: Record<HrRequestType, string> = {
  leave: 'طلب إجازة',
  permission: 'طلب استئذان',
  remote_work: 'طلب عمل عن بُعد',
  salary_certificate: 'طلب تعريف بالراتب',
  experience_certificate: 'طلب شهادة خبرة',
  advance: 'طلب سلفة',
  data_update: 'طلب تحديث بيانات',
  official_letter: 'طلب خطاب رسمي',
  attendance_correction: 'طلب تعديل بصمة أو معالجة تسجيل مفقود',
  geofence_exception: 'طلب استثناء من النطاق الجغرافي',
  overtime: 'طلب عمل إضافي',
};

/** Request states [HR §3.5 "حالات الطلب المقترحة"] — the workflow definition `hr_request` uses these codes. */
export const HR_REQUEST_STATE_AR: Record<string, string> = {
  new: 'جديد',
  under_review: 'قيد المراجعة',
  awaiting_manager: 'بانتظار موافقة المدير',
  awaiting_hr: 'بانتظار الموارد البشرية',
  awaiting_final: 'بانتظار الاعتماد النهائي',
  needs_completion: 'يحتاج استكمال',
  approved: 'معتمد',
  rejected: 'مرفوض',
  closed: 'مغلق',
};

/** Leave types [HR §3.5.1] — the Labor Law list with the 2025 amendments (DECISIONS §21 Q7); «اضطرارية» is the cooperative's own. */
export const LEAVE_TYPES = [
  'annual',
  'sick',
  'emergency',
  'unpaid',
  'maternity',
  'hajj',
  'marriage',
  'newborn',
  'bereavement',
  'bereavement_sibling',
  'iddah',
  'exam',
  'overtime_comp',
  'other',
] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_TYPE_AR: Record<LeaveType, string> = {
  annual: 'سنوية',
  sick: 'مرضية',
  emergency: 'اضطرارية',
  unpaid: 'بدون راتب',
  maternity: 'وضع',
  hajj: 'حج',
  marriage: 'زواج',
  newborn: 'مولود',
  bereavement: 'وفاة',
  bereavement_sibling: 'وفاة أخ أو أخت',
  iddah: 'عدة',
  exam: 'اختبارات',
  overtime_comp: 'تعويض عمل إضافي',
  other: 'أخرى',
};
/** Leave types whose request needs the date of the event (birth, death, marriage…) for the Q7 validations. */
export const LEAVE_TYPES_WITH_EVENT: readonly LeaveType[] = ['newborn', 'maternity'];

export const CORRECTION_KINDS = ['missing_in', 'missing_out', 'wrong_time'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export const CORRECTION_KIND_AR: Record<CorrectionKind, string> = {
  missing_in: 'تسجيل حضور مفقود',
  missing_out: 'تسجيل انصراف مفقود',
  wrong_time: 'تعديل وقت بصمة',
};
export const EXCEPTION_SCOPES = ['any_location', 'site', 'remote'] as const;
export type ExceptionScope = (typeof EXCEPTION_SCOPES)[number];
export const EXCEPTION_SCOPE_AR: Record<ExceptionScope, string> = {
  any_location: 'من أي موقع',
  site: 'من موقع محدد',
  remote: 'عمل عن بُعد',
};

const dateStr = z.coerce.date();
const timeStr = z.string().regex(/^\d{2}:\d{2}$/, 'الوقت بصيغة HH:MM');
const dayStr = riyadhDaySchema;
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'معرّف غير صالح');

/** Per-type fields exactly as HR §3.5 lists them. */
export const HR_REQUEST_DETAIL_SCHEMAS = {
  leave: z
    .object({
      leaveType: z.enum(LEAVE_TYPES),
      startDate: dateStr,
      endDate: dateStr,
      reason: z.string().trim().min(2).max(1000),
      /** Birth / death / marriage date for the types that are counted from an event (DECISIONS §21 Q7). */
      eventDate: dateStr.optional(),
    })
    .refine((d) => d.endDate >= d.startDate, { message: 'تاريخ النهاية قبل البداية', path: ['endDate'] })
    .refine((d) => !LEAVE_TYPES_WITH_EVENT.includes(d.leaveType) || !!d.eventDate, {
      message: 'تاريخ الواقعة مطلوب لهذا النوع من الإجازة',
      path: ['eventDate'],
    }),
  permission: z
    .object({
      date: dateStr,
      startTime: timeStr,
      endTime: timeStr,
      reason: z.string().trim().min(2).max(1000),
    })
    .refine((d) => d.endTime > d.startTime, { message: 'وقت النهاية قبل البداية', path: ['endTime'] }),
  remote_work: z.object({
    startDate: dateStr,
    days: z.number().int().min(1).max(60),
    reason: z.string().trim().min(2).max(1000),
  }),
  salary_certificate: z.object({
    addressedTo: z.string().trim().min(2).max(200),
    purpose: z.string().trim().min(2).max(500),
    detailed: z.boolean().default(false),
    chamberAttestation: z.boolean().default(false),
  }),
  experience_certificate: z.object({ purpose: z.string().trim().min(2).max(500) }),
  advance: z.object({
    amountHalalas: z.number().int().positive(),
    reason: z.string().trim().min(2).max(1000),
    notes: z.string().trim().max(1000).optional(),
  }),
  data_update: z.object({
    changes: z
      .array(
        z.object({
          field: z.string().trim().min(1).max(60),
          currentValue: z.string().trim().max(500).optional(),
          newValue: z.string().trim().min(1).max(500),
        }),
      )
      .min(1),
    reason: z.string().trim().max(1000).optional(),
  }),
  official_letter: z.object({
    letterType: z.string().trim().min(2).max(100),
    addressedTo: z.string().trim().min(2).max(200),
    purpose: z.string().trim().min(2).max(500),
  }),
  /** «رفع طلب تعديل بصمة أو معالجة تسجيل مفقود» [HR §3.4 ثالثاً]: approval inserts the punch, the original is never edited. */
  attendance_correction: z
    .object({
      day: dayStr,
      kind: z.enum(CORRECTION_KINDS),
      /** The time the employee says they actually arrived / left (HH:MM, Riyadh). */
      requestedTime: timeStr,
      /** For `wrong_time`: which punch is wrong (its id), so the correction is traceable. */
      punchId: objectId.optional(),
      reason: z.string().trim().min(2).max(1000),
    })
    .refine((d) => d.kind !== 'wrong_time' || !!d.punchId, {
      message: 'حدّد البصمة المطلوب تعديلها',
      path: ['punchId'],
    }),
  /** «إلا وفق صلاحية أو استثناء معتمد» [HR §3.4 ثانياً 6]: approval writes an attendanceExceptions row. */
  geofence_exception: z
    .object({
      from: dayStr,
      to: dayStr,
      scope: z.enum(EXCEPTION_SCOPES),
      siteId: objectId.optional(),
      reason: z.string().trim().min(2).max(1000),
    })
    .refine((d) => d.to >= d.from, { message: 'تاريخ النهاية قبل البداية', path: ['to'] })
    .refine((d) => d.scope !== 'site' || !!d.siteId, { message: 'حدّد الموقع', path: ['siteId'] }),
  /** «طلب عمل إضافي» (Q16): pre-approval by the direct manager of N minutes beyond the shift on one day. */
  overtime: z
    .object({
      day: dayStr,
      startTime: timeStr,
      endTime: timeStr,
      reason: z.string().trim().min(2).max(1000),
      /** DECISIONS §21 Q5: the employee's choice when the policy is `employee_choice`. */
      compensation: z.enum(['pay', 'leave']).optional(),
    })
    .refine((d) => d.endTime > d.startTime, { message: 'وقت النهاية قبل البداية', path: ['endTime'] }),
} as const;

export const createHrRequestSchema = z.object({
  type: z.enum(HR_REQUEST_TYPES),
  details: z.record(z.unknown()),
  attachmentIds: z.array(objectIdSchema).default([]),
  notes: z.string().trim().max(1000).optional(),
});
export type CreateHrRequestInput = z.infer<typeof createHrRequestSchema>;

export const hrRequestTransitionSchema = z.object({
  transition: z.string().min(1),
  reason: z.string().trim().max(1000).optional(),
  /** Requester edits when resubmitting after "يحتاج استكمال". */
  details: z.record(z.unknown()).optional(),
  attachmentIds: z.array(objectIdSchema).optional(),
});

export const listHrRequestsQuerySchema = z.object({
  /** mine = my own; inbox = waiting for my action as direct manager; queue = HR/Finance work queue; all = everything I may see. */
  view: z.enum(['mine', 'inbox', 'queue', 'all']).default('mine'),
  type: z.enum(HR_REQUEST_TYPES).optional(),
  state: z.string().optional(),
  open: z.coerce.boolean().optional(),
  /** Only requests still awaiting a decision (not returned for completion) — the dashboard's «الطلبات المعلقة» [HR §5]. */
  pending: z.coerce.boolean().optional(),
  /** Decided approved / rejected, whether or not closed since — the dashboard's «المعتمدة» / «المرفوضة» [HR §5]. */
  outcome: z.enum(['approved', 'rejected']).optional(),
  /** Submission date window (Riyadh days, inclusive) — the dashboard's «الطلبات الجديدة» [HR §5]. */
  from: riyadhDaySchema.optional(),
  to: riyadhDaySchema.optional(),
  employeeId: objectIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

/** Routing matrix (DECISIONS §5) — stored as the setting `hr.requestRoutes` so HR can change it. */
export interface HrRequestRoute {
  viaManager: boolean;
  /** `manager`: the direct manager's approval is final (overtime, DECISIONS §21 Q16) — HR is not in the route. */
  finalApprover: 'hr' | 'hr_then_finance' | 'manager';
}
export const hrRequestRoutesSchema = z.record(
  z.enum(HR_REQUEST_TYPES),
  z.object({ viaManager: z.boolean(), finalApprover: z.enum(['hr', 'hr_then_finance', 'manager']) }),
);
export const DEFAULT_HR_REQUEST_ROUTES: Record<HrRequestType, HrRequestRoute> = {
  leave: { viaManager: true, finalApprover: 'hr' },
  permission: { viaManager: true, finalApprover: 'hr' },
  remote_work: { viaManager: true, finalApprover: 'hr' },
  salary_certificate: { viaManager: false, finalApprover: 'hr' },
  experience_certificate: { viaManager: false, finalApprover: 'hr' },
  official_letter: { viaManager: false, finalApprover: 'hr' },
  data_update: { viaManager: false, finalApprover: 'hr' },
  advance: { viaManager: true, finalApprover: 'hr_then_finance' },
  // H2 defaults (HR_PLAN §4.1–4.2, §11 Q3 / Q6 / Q16 — accepted 2026-11-24)
  attendance_correction: { viaManager: true, finalApprover: 'hr' },
  geofence_exception: { viaManager: true, finalApprover: 'hr' },
  overtime: { viaManager: true, finalApprover: 'manager' },
};
