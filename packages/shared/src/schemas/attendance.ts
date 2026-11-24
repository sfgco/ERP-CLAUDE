import { z } from 'zod';
import { objectIdSchema, riyadhDaySchema } from './common';
import { LEAVE_TYPES, type LeaveType } from './hrRequests';

/**
 * Attendance [HR §3.4] and leave balances [HR §3.5.1] — shared schemas and verbatim Arabic labels.
 * Times inside a shift are "HH:MM" in Asia/Riyadh; durations are integer minutes; leave is counted in days.
 */

// ---------- shifts («فترات الدوام») [HR §3.4 أولاً] ----------
export const SHIFT_KINDS = ['fixed', 'rotating', 'field', 'flexible'] as const;
export type ShiftKind = (typeof SHIFT_KINDS)[number];
export const SHIFT_KIND_AR: Record<ShiftKind, string> = {
  fixed: 'دوام ثابت',
  rotating: 'ورديات',
  field: 'عمل ميداني',
  flexible: 'دوام مرن',
};

export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'الوقت بصيغة HH:MM');
export const shiftPeriodSchema = z.object({
  start: timeOfDaySchema,
  end: timeOfDaySchema,
  /** The period ends on the next calendar day (night shifts). */
  crossesMidnight: z.boolean().default(false),
});
export type ShiftPeriod = z.infer<typeof shiftPeriodSchema>;

export const shiftSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(30)
    .regex(/^[a-z0-9_]+$/, 'أحرف إنجليزية صغيرة وأرقام فقط'),
  nameAr: z.string().trim().min(2).max(80),
  kind: z.enum(SHIFT_KINDS).default('fixed'),
  /** «تحديد وقت بداية ونهاية كل فترة»: one period for a plain day, several for split or rotating days. */
  periods: z.array(shiftPeriodSchema).min(1).max(4),
  /** Ramadan variant of the periods (Q1, provisional until HR confirms); empty = same hours all year. */
  ramadanPeriods: z.array(shiftPeriodSchema).max(4).default([]),
  /** «تحديد أيام العمل والإجازات الأسبوعية»: JS weekday numbers (0 = Sunday). Days not listed are the weekly rest. */
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4]),
  /** Per-shift override of the lateness grace (minutes); null = the global `hr.attendance.rules`. */
  graceMinutes: z.number().int().min(0).max(120).nullable().optional(),
  active: z.boolean().default(true),
  notes: z.string().trim().max(500).optional(),
});
export type ShiftInput = z.infer<typeof shiftSchema>;
export const shiftUpdateSchema = shiftSchema.partial();

/** «إسناد الموظفين إلى فترات العمل» and «ربط الموظفين بفروعهم ومواقع تشغيلهم» [HR §3.4 أولاً 4–5]. */
export const shiftAssignmentSchema = z.object({
  employeeId: objectIdSchema,
  shiftId: objectIdSchema,
  /** Sites the employee may punch from (several for field staff, §3.4 ثانياً 8). Empty = the site on the file. */
  siteIds: z.array(objectIdSchema).max(20).default([]),
  branchId: objectIdSchema.nullable().optional(),
  /** First day of the assignment (Riyadh day). The previous assignment closes the day before. */
  from: riyadhDaySchema,
  reason: z.string().trim().max(500).optional(),
});
export type ShiftAssignmentInput = z.infer<typeof shiftAssignmentSchema>;

// ---------- punches («تسجيل الحضور والانصراف») [HR §3.4 ثانياً، ثالثاً] ----------
export const PUNCH_TYPES = ['in', 'out'] as const;
export type PunchType = (typeof PUNCH_TYPES)[number];
export const PUNCH_TYPE_AR: Record<PunchType, string> = { in: 'تسجيل الحضور', out: 'تسجيل الانصراف' };

export const PUNCH_SOURCES = ['web', 'mobile', 'correction', 'manual_hr', 'device'] as const;
export type PunchSource = (typeof PUNCH_SOURCES)[number];
export const PUNCH_SOURCE_AR: Record<PunchSource, string> = {
  web: 'الموقع',
  mobile: 'الجوال',
  correction: 'طلب تعديل بصمة',
  manual_hr: 'إدخال الموارد البشرية',
  device: 'جهاز بصمة',
};

export const LOCATION_ERRORS = ['denied', 'unavailable', 'timeout', 'inaccurate'] as const;
export type LocationError = (typeof LOCATION_ERRORS)[number];

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Browser-reported accuracy radius in metres. */
  accuracyM: z.number().min(0).max(100_000).optional(),
});
export type GeoPoint = z.infer<typeof geoPointSchema>;

/** The employee's own punch. The time is the server's (§3.4 ثانياً 1); the client only says in / out and where it is. */
export const punchSchema = z.object({
  type: z.enum(PUNCH_TYPES),
  location: geoPointSchema.nullable().optional(),
  /** Why the browser gave no location (shown back to the employee and kept on the punch). */
  locationError: z.enum(LOCATION_ERRORS).optional(),
  /** Client-generated key so a retried request never inserts a second punch. */
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
  source: z.enum(['web', 'mobile']).default('web'),
});
export type PunchInput = z.infer<typeof punchSchema>;

/** Pre-check before pressing the button: where am I relative to my sites? Nothing is stored. */
export const locationCheckSchema = z.object({ location: geoPointSchema });

/** HR enters a punch by hand with a reason (Q17: HR only, audited) — e.g. a device outage. */
export const manualPunchSchema = z.object({
  employeeId: objectIdSchema,
  type: z.enum(PUNCH_TYPES),
  at: z.coerce.date(),
  siteId: objectIdSchema.nullable().optional(),
  reason: z.string().trim().min(3).max(500),
});
export type ManualPunchInput = z.infer<typeof manualPunchSchema>;

// ---------- computed day («رصد التأخير والغياب … احتساب ساعات العمل») [HR §3.4 رابعاً] ----------
export const ATTENDANCE_DAY_STATUSES = [
  'present',
  'late',
  'absent',
  'on_leave',
  'remote',
  'weekend',
  'holiday',
  'missing_in',
  'missing_out',
  'not_scheduled',
] as const;
export type AttendanceDayStatus = (typeof ATTENDANCE_DAY_STATUSES)[number];
export const ATTENDANCE_DAY_STATUS_AR: Record<AttendanceDayStatus, string> = {
  present: 'حاضر',
  late: 'متأخر',
  absent: 'غائب',
  on_leave: 'في إجازة',
  remote: 'عمل عن بُعد',
  weekend: 'إجازة أسبوعية',
  holiday: 'عطلة رسمية',
  missing_in: 'لم يُسجَّل الحضور',
  missing_out: 'لم يُسجَّل الانصراف',
  not_scheduled: 'غير مجدول',
};

export const listAttendanceDaysQuerySchema = z.object({
  employeeId: objectIdSchema.optional(),
  departmentId: objectIdSchema.optional(),
  branchId: objectIdSchema.optional(),
  from: riyadhDaySchema.optional(),
  to: riyadhDaySchema.optional(),
  status: z.enum(ATTENDANCE_DAY_STATUSES).optional(),
  /** Only days with a lateness / absence / missing punch / early leave (the dashboard's exceptions). */
  exceptionsOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const listPunchesQuerySchema = z.object({
  employeeId: objectIdSchema.optional(),
  from: riyadhDaySchema.optional(),
  to: riyadhDaySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const recomputeDaysSchema = z.object({
  employeeId: objectIdSchema.optional(),
  from: riyadhDaySchema,
  to: riyadhDaySchema,
});

// ---------- leave balances (ledger) [HR §3.5.1, Q7] ----------
export const LEAVE_ENTRY_TYPES = [
  'opening',
  'accrual',
  'taken',
  'returned',
  'adjustment',
  'carryover',
  'expiry',
  'encashment',
  'overtime_compensation',
] as const;
export type LeaveEntryType = (typeof LEAVE_ENTRY_TYPES)[number];
export const LEAVE_ENTRY_TYPE_AR: Record<LeaveEntryType, string> = {
  opening: 'رصيد افتتاحي',
  accrual: 'استحقاق',
  taken: 'إجازة مأخوذة',
  returned: 'إرجاع',
  adjustment: 'تسوية',
  carryover: 'ترحيل',
  expiry: 'انتهاء صلاحية',
  encashment: 'صرف نقدي',
  overtime_compensation: 'تعويض عمل إضافي',
};

/** HR writes an opening balance or a signed adjustment with a reason; everything else is written by the system. */
export const leaveLedgerEntrySchema = z.object({
  employeeId: objectIdSchema,
  leaveType: z.enum(LEAVE_TYPES),
  entryType: z.enum(['opening', 'adjustment', 'carryover', 'expiry', 'encashment']),
  /** Signed days; may be fractional (monthly accrual), requests take whole days. */
  days: z.number().min(-365).max(365).refine((d) => d !== 0, 'عدد الأيام لا يكون صفراً'),
  year: z.number().int().min(2000).max(2100),
  note: z.string().trim().min(2).max(500),
});
export type LeaveLedgerEntryInput = z.infer<typeof leaveLedgerEntrySchema>;

/** CSV import of opening balances (DECISIONS §3: the ERPNext extraction is done outside). */
export const leaveBalanceImportSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  rows: z
    .array(
      z.object({
        employeeNumber: z.string().trim().min(1),
        leaveType: z.enum(LEAVE_TYPES),
        days: z.number().min(-365).max(365),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

export const listLeaveBalancesQuerySchema = z.object({
  employeeId: objectIdSchema.optional(),
  departmentId: objectIdSchema.optional(),
  leaveType: z.enum(LEAVE_TYPES).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** Per-type leave policy (setting `hr.leave.policies`). `entitlementDays: null` = not decided → the balance is «غير محدد». */
export const leavePolicySchema = z.object({
  /** Days per year; null = no fixed entitlement (by agreement / per event / not decided). */
  entitlementDays: z.number().min(0).max(366).nullable(),
  /** Entitlement after five years of service (annual leave, art. 109); null = same as `entitlementDays`. */
  entitlementAfter5YearsDays: z.number().min(0).max(366).nullable(),
  accrual: z.enum(['monthly', 'yearly', 'none']),
  carryOverCapDays: z.number().min(0).max(366).nullable(),
  paidPercent: z.number().int().min(0).max(100),
  requiresAttachment: z.boolean(),
  /** Longest single request in days; null = no limit beyond the balance. */
  maxDaysPerRequest: z.number().int().min(1).max(366).nullable(),
  /** What happens when a request exceeds the balance: refuse it, flag it for HR, or allow silently. */
  overBalance: z.enum(['refuse', 'flag', 'allow']),
  /** The request must start within N days of the event date (the father's birth leave: 7, 2025 amendment). */
  startWithinDaysOfEvent: z.number().int().min(0).max(365).nullable(),
  /** The leave must cover the event date and at least N days right after it (maternity: 42, 2025 amendment). */
  minDaysAfterEvent: z.number().int().min(0).max(366).nullable(),
  /** Labor-law article the numbers come from, for the admin screen. */
  articleAr: z.string().trim().max(120).optional(),
  /** Marks the cooperative's own values that still await HR confirmation («مؤقت حتى اعتماد الموارد البشرية»). */
  provisional: z.boolean(),
});
export type LeavePolicy = z.infer<typeof leavePolicySchema>;
export type LeavePolicies = Record<LeaveType, LeavePolicy>;
/** One policy per leave type — every type present (an object, not a record, so the admin cannot drop a type). */
export const leavePoliciesSchema = z.object(
  Object.fromEntries(LEAVE_TYPES.map((t) => [t, leavePolicySchema])) as Record<LeaveType, typeof leavePolicySchema>,
) as unknown as z.ZodType<LeavePolicies>;

/**
 * Proposed defaults with the article numbers (HR_PLAN §11 Q7, DECISIONS §21 — accepted 2026-11-24). Figures the
 * cooperative sets itself (اضطرارية، أخرى) are provisional until the HR team confirms them.
 */
export const DEFAULT_LEAVE_POLICIES: LeavePolicies = {
  annual: {
    entitlementDays: 21,
    entitlementAfter5YearsDays: 30,
    accrual: 'monthly',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: null,
    overBalance: 'refuse',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'المادة 109 من نظام العمل',
    provisional: false,
  },
  sick: {
    entitlementDays: 120,
    entitlementAfter5YearsDays: null,
    accrual: 'yearly',
    carryOverCapDays: 0,
    paidPercent: 100,
    requiresAttachment: true,
    maxDaysPerRequest: null,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'المادة 117: 30 يوماً بأجر كامل، 60 بثلاثة أرباع الأجر، 30 بدون أجر',
    provisional: false,
  },
  emergency: {
    entitlementDays: null,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: null,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'إجازة خاصة بالجمعية (لا مادة نظامية)',
    provisional: true,
  },
  unpaid: {
    entitlementDays: null,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 0,
    requiresAttachment: false,
    maxDaysPerRequest: null,
    overBalance: 'allow',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'المادة 116 (باتفاق الطرفين)',
    provisional: false,
  },
  maternity: {
    entitlementDays: 84,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: true,
    maxDaysPerRequest: 84,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: 42,
    articleAr: 'المادة 151 بعد تعديل 2025: 12 أسبوعاً منها 6 بعد الولادة مباشرة',
    provisional: false,
  },
  hajj: {
    entitlementDays: 15,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: 15,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'المادة 114: 10–15 يوماً مرة واحدة بعد سنتين',
    provisional: false,
  },
  marriage: {
    entitlementDays: 5,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: 5,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'المادة 113',
    provisional: false,
  },
  newborn: {
    entitlementDays: 3,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: 3,
    overBalance: 'flag',
    startWithinDaysOfEvent: 7,
    minDaysAfterEvent: null,
    articleAr: 'المادة 113 بعد تعديل 2025: خلال 7 أيام من الولادة',
    provisional: false,
  },
  bereavement: {
    entitlementDays: 5,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: 5,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'المادة 113 (الزوج أو أحد الأصول أو الفروع)',
    provisional: false,
  },
  bereavement_sibling: {
    entitlementDays: 3,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: 3,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'تعديل 2025: وفاة أخ أو أخت',
    provisional: false,
  },
  iddah: {
    entitlementDays: 130,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: true,
    maxDaysPerRequest: 130,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'المادة 160: أربعة أشهر وعشرة أيام',
    provisional: false,
  },
  exam: {
    entitlementDays: null,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: true,
    maxDaysPerRequest: null,
    overBalance: 'allow',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'المادة 115: أيام الاختبارات الفعلية',
    provisional: false,
  },
  overtime_comp: {
    entitlementDays: null,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: null,
    overBalance: 'refuse',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'تعديل 2025: 1.5 ساعة إجازة لكل ساعة عمل إضافي (DECISIONS §21 Q5)',
    provisional: false,
  },
  other: {
    entitlementDays: null,
    entitlementAfter5YearsDays: null,
    accrual: 'none',
    carryOverCapDays: null,
    paidPercent: 100,
    requiresAttachment: false,
    maxDaysPerRequest: null,
    overBalance: 'flag',
    startWithinDaysOfEvent: null,
    minDaysAfterEvent: null,
    articleAr: 'حسب الحالة',
    provisional: true,
  },
};

// ---------- attendance policy settings (Q1–Q6) ----------
export const attendanceRulesSchema = z.object({
  /** Minutes after the shift start before a check-in counts as late (Q4: 10). */
  graceMinutes: z.number().int().min(0).max(120),
  /** Minutes before the shift end a check-out may happen without counting as early leave (Q4: 10). */
  earlyLeaveGraceMinutes: z.number().int().min(0).max(120),
  /** Q4: a scheduled day with no check-in by the shift end (and no leave / permission / remote) is absent. */
  absentWhenNoCheckIn: z.boolean(),
  /** Q4: with a check-in and no check-out the day is flagged and its hours wait for a correction (no auto-close). */
  missingCheckoutPolicy: z.enum(['wait_correction', 'auto_close_at_shift_end_flagged', 'count_absent']),
  /** «إشعار الموظف عند نسيان تسجيل الحضور أو الانصراف»: minutes after start / end before the reminder. */
  missedCheckInAlertMinutes: z.number().int().min(0).max(600),
  missedCheckOutAlertMinutes: z.number().int().min(0).max(600),
  /**
   * How a late check-in is counted once it is beyond the grace (owner request 2026-11-24, provisional until HR confirms):
   * `from_start` = the whole lateness from the shift start (20 min late with 15 min grace counts 20);
   * `beyond_grace` = only the minutes beyond the grace (5). Payroll (H3a) reads `lateMinutes` as stored.
   */
  latenessCounting: z.enum(['from_start', 'beyond_grace']).optional(),
});
export type AttendanceRules = z.infer<typeof attendanceRulesSchema>;
export const LATENESS_COUNTING_AR: Record<'from_start' | 'beyond_grace', string> = {
  from_start: 'كامل التأخير من بداية الدوام',
  beyond_grace: 'الدقائق بعد فترة السماح فقط',
};

export const locationPolicySchema = z.object({
  requireLocation: z.boolean(),
  /** A fix whose accuracy radius exceeds this many times the site radius counts as «تعذر تحديد الموقع». */
  maxAccuracyFactor: z.number().min(1).max(10),
  onUnavailable: z.enum(['refuse', 'allow_flagged']),
});
export type LocationPolicy = z.infer<typeof locationPolicySchema>;

export const overtimePolicySchema = z.object({
  requiresPreApproval: z.boolean(),
  /** Basis points of the basic hourly wage (art. 107: 150 %). */
  rateBp: z.number().int().min(10_000).max(30_000),
  roundingMinutes: z.number().int().min(1).max(60),
  monthlyCapMinutes: z.number().int().min(0).nullable(),
  /** DECISIONS §21 Q5: pay, compensatory leave, or the employee's choice per request. */
  compensation: z.enum(['pay', 'leave', 'employee_choice']),
  /** Leave hours earned per overtime hour (2025 amendment: 1.5). */
  leaveHoursPerOvertimeHour: z.number().min(1).max(3),
  leaveUseWithinDays: z.number().int().min(1).max(365),
  leaveMaxDaysPerYear: z.number().int().min(1).max(365),
});
export type OvertimePolicy = z.infer<typeof overtimePolicySchema>;

export const correctionPolicySchema = z.object({
  /** A correction may be requested up to N days after the day (Q6: 7). */
  deadlineDays: z.number().int().min(1).max(90),
  /** Corrections per employee per month before the request is flagged for HR (Q6: 3); null = no limit. */
  perMonth: z.number().int().min(1).max(31).nullable(),
});
export type CorrectionPolicy = z.infer<typeof correctionPolicySchema>;
