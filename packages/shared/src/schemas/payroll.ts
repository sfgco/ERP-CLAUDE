import { z } from 'zod';
import { objectIdSchema, riyadhDaySchema } from './common';

/**
 * Payroll [HR §3.6] — shared schemas and verbatim labels. Money is integer halalas, rates are basis points
 * (10 000 = 100 %). Policies are settings (Q8, DECISIONS §21): the lists and dates are provisional until HR confirms.
 */
export const payrollPeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'الفترة بصيغة YYYY-MM');

export const PAYROLL_RUN_STATES = [
  'draft',
  'under_hr_review',
  'returned',
  'hr_approved',
  'at_finance',
  'finance_returned',
  'finance_approved',
  'paid',
  'closed',
  'cancelled',
] as const;
export type PayrollRunState = (typeof PAYROLL_RUN_STATES)[number];
/** Labels: HR §3.6.6–3.6.7 words where the spec has them, FIN §5 words for the Finance stage, the rest proposed (HR_PLAN §4.5). */
export const PAYROLL_RUN_STATE_AR: Record<PayrollRunState, string> = {
  draft: 'مسودة',
  under_hr_review: 'قيد مراجعة الموارد البشرية',
  returned: 'أُعيد للتعديل',
  hr_approved: 'معتمد من الموارد البشرية',
  at_finance: 'بانتظار اعتماد المالية',
  finance_returned: 'يحتاج استكمال',
  finance_approved: 'معتمد',
  paid: 'مدفوع',
  closed: 'مغلق',
  cancelled: 'ملغي',
};

/** Payslip line codes [HR §3.6.1, §3.6.3, §3.6.5]. Allowances carry their type from the file as `allowance:<type>`. */
export const PAYSLIP_EARNING_CODES = ['basic', 'allowance', 'overtime', 'adjustment'] as const;
export const PAYSLIP_DEDUCTION_CODES = [
  'absence',
  'lateness',
  'unpaid_leave',
  'advance_instalment',
  'gosi_employee',
  'fine',
  'adjustment',
  'other',
] as const;
export type PayslipEarningCode = (typeof PAYSLIP_EARNING_CODES)[number];
export type PayslipDeductionCode = (typeof PAYSLIP_DEDUCTION_CODES)[number];
export const PAYSLIP_LINE_AR: Record<PayslipEarningCode | PayslipDeductionCode, string> = {
  basic: 'الراتب الأساسي',
  allowance: 'بدل',
  overtime: 'عمل إضافي',
  adjustment: 'تسوية',
  absence: 'غياب',
  lateness: 'تأخير',
  unpaid_leave: 'إجازة بدون راتب',
  advance_instalment: 'قسط سلفة',
  gosi_employee: 'التأمينات الاجتماعية (حصة الموظف)',
  fine: 'جزاء',
  other: 'أخرى',
};

export const createPayrollRunSchema = z.object({
  period: payrollPeriodSchema,
  notes: z.string().trim().max(1000).optional(),
});
export const payrollRunTransitionSchema = z.object({
  transition: z.enum([
    'submit_for_review',
    'return',
    'hr_approve',
    'send_to_finance',
    'finance_approve',
    'finance_return',
    'record_payment',
    'close',
    'cancel',
  ]),
  reason: z.string().trim().max(1000).optional(),
  /** `record_payment` [HR §3.6.7, FIN §6]: what Finance did outside the system (WPS / bank) until the integration exists. */
  paidAt: z.coerce.date().optional(),
  paymentRef: z.string().trim().max(120).optional(),
  proofAttachmentId: objectIdSchema.optional(),
});
export const listPayrollRunsQuerySchema = z.object({
  state: z.enum(PAYROLL_RUN_STATES).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

/** «التعديل يدخل في المسير التالي»: a correction never edits a frozen payslip (HR_PLAN §3.3). */
export const payrollAdjustmentSchema = z.object({
  employeeId: objectIdSchema,
  kind: z.enum(['earning', 'deduction']),
  amountHalalas: z.number().int().positive().max(100_000_000),
  reason: z.string().trim().min(3).max(500),
  /** The run the correction belongs to (information only; the adjustment is consumed by the next prepared run). */
  sourceRunId: objectIdSchema.optional(),
});
export type PayrollAdjustmentInput = z.infer<typeof payrollAdjustmentSchema>;

/** GOSI contribution groups (DECISIONS §21 Q8): Saudi by first-registration date, non-Saudi. */
export const GOSI_GROUPS = ['saudi_before_2024_07_03', 'saudi_from_2024_07_03', 'non_saudi'] as const;
export type GosiGroup = (typeof GOSI_GROUPS)[number];
export const GOSI_GROUP_AR: Record<GosiGroup, string> = {
  saudi_before_2024_07_03: 'سعودي مسجّل في التأمينات قبل 3 يوليو 2024',
  saudi_from_2024_07_03: 'سعودي مسجّل في التأمينات من 3 يوليو 2024',
  non_saudi: 'غير سعودي',
};
export const gosiRateRowSchema = z.object({
  group: z.enum(GOSI_GROUPS),
  /** The rate applies to pay periods on or after this Riyadh day. */
  effectiveFrom: riyadhDaySchema,
  employeeBp: z.number().int().min(0).max(5000),
  employerBp: z.number().int().min(0).max(5000),
  note: z.string().trim().max(200).optional(),
});
export const gosiRatesSchema = z.array(gosiRateRowSchema).min(1).max(100);
export type GosiRateRow = z.infer<typeof gosiRateRowSchema>;
/**
 * Effective-dated table (DECISIONS §21 Q8). Saudi joined before 3 Jul 2024: 9.75 % / 11.75 %. Saudi joined on or after:
 * the annuity share rises 0.5 points every July until 11 % in Jul 2028 (2024-07: 9.75/11.75 → 2025-07: 10.25/12.25 →
 * 2026-07: 10.75/12.75 → 2027-07: 11.25/13.25 → 2028-07: 11.75/13.75 incl. the 2 % hazards share on the employer).
 * Non-Saudi: employer 2 % (occupational hazards), employee 0.
 */
export const DEFAULT_GOSI_RATES: GosiRateRow[] = [
  { group: 'saudi_before_2024_07_03', effectiveFrom: '2000-01-01', employeeBp: 975, employerBp: 1175 },
  { group: 'saudi_from_2024_07_03', effectiveFrom: '2024-07-03', employeeBp: 975, employerBp: 1175 },
  { group: 'saudi_from_2024_07_03', effectiveFrom: '2025-07-01', employeeBp: 1025, employerBp: 1225 },
  { group: 'saudi_from_2024_07_03', effectiveFrom: '2026-07-01', employeeBp: 1075, employerBp: 1275 },
  { group: 'saudi_from_2024_07_03', effectiveFrom: '2027-07-01', employeeBp: 1125, employerBp: 1325 },
  { group: 'saudi_from_2024_07_03', effectiveFrom: '2028-07-01', employeeBp: 1175, employerBp: 1375 },
  { group: 'non_saudi', effectiveFrom: '2000-01-01', employeeBp: 0, employerBp: 200 },
];

export const payrollPolicySchema = z.object({
  /** «البدلات» catalogue (provisional, Q8): the types the file may carry. */
  allowanceTypes: z.array(z.string().trim().min(1).max(60)).max(30),
  /** The allowance types inside the GOSI contribution wage (basic + housing by the GOSI rules). */
  gosiWageAllowanceTypes: z.array(z.string().trim().min(1).max(60)).max(30),
  /** Nationality value on the employee file that means Saudi (the file stores free text). */
  saudiNationalityValues: z.array(z.string().trim().min(1).max(60)).min(1),
  /** Absence day = monthly wage ÷ 30 (Q8) or ÷ the month's working days. */
  absenceDayFormula: z.enum(['monthly_over_30', 'monthly_over_working_days']),
  /** Wage base of the absence / unpaid-leave day: basic only or basic + allowances. */
  absenceBase: z.enum(['basic', 'total']),
  /** Lateness deduction (Q8: none until HR decides); `per_minute` prices each counted minute at the hourly wage. */
  latenessDeduction: z.enum(['none', 'per_minute']),
  /** Overtime hourly base: basic ÷ 30 ÷ daily hours; rate from `hr.overtime.rateBp` (art. 107). */
  dailyHours: z.number().min(4).max(12),
  /** Total deductions (excluding GOSI) ≤ this share of the wage (art. 92: 50 %); the excess rolls into the next run. */
  deductionCapBp: z.number().int().min(0).max(10_000),
  /** Attendance window of a period: from the day after last month's cut-off to this month's cut-off (Q8: 25). */
  cutoffDay: z.number().int().min(1).max(28),
  payDay: z.number().int().min(1).max(31),
  /** When employees may open their payslips (HR_PLAN §10.6: at `paid`). */
  payslipVisibleAt: z.enum(['paid', 'finance_approved']),
  /** Employment types outside the payroll run (Q18: contractors). */
  excludeEmploymentTypes: z.array(z.string()).max(10),
});
export type PayrollPolicy = z.infer<typeof payrollPolicySchema>;
export const DEFAULT_PAYROLL_POLICY: PayrollPolicy = {
  allowanceTypes: ['سكن', 'نقل', 'أخرى'],
  gosiWageAllowanceTypes: ['سكن'],
  saudiNationalityValues: ['سعودي', 'سعودية', 'السعودية', 'Saudi'],
  absenceDayFormula: 'monthly_over_30',
  absenceBase: 'total',
  latenessDeduction: 'none',
  dailyHours: 8,
  deductionCapBp: 5000,
  cutoffDay: 25,
  payDay: 27,
  payslipVisibleAt: 'paid',
  excludeEmploymentTypes: ['contractor'],
};

export const listPayslipsQuerySchema = z.object({
  runId: objectIdSchema.optional(),
  employeeId: objectIdSchema.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
