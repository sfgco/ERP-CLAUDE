import { z } from 'zod';
import { objectIdSchema, riyadhDaySchema } from './common';

/**
 * End of service [HR §3.10] — shared enums, verbatim labels and schemas (HR_PLAN §3.7, §4.8; docs/HR_H3B_LEGAL.md E1–E26;
 * DECISIONS §22). Saudi Labor Law article numbers are kept on every rule. Money is integer halalas.
 */

// ---------- E1: the closed list of reasons (art. 74 as amended 1446H + arts. 79, 80, 81, 53) ----------
export const EOS_REASONS = [
  'mutual_agreement', // اتفاق الطرفين كتابةً — م 74(1)
  'contract_expiry', // انتهاء المدة — م 74(2)
  'employer_notice', // إنهاء من صاحب العمل بإشعار (عقد غير محدد المدة) — م 74(3)، م 75
  'employee_notice', // إنهاء من العامل بإشعار (عقد غير محدد المدة) — م 74(3)، م 75
  'resignation', // استقالة — م 74(3 مكرر)، م 79 مكرر (E25)
  'retirement', // بلوغ سن التقاعد وفق نظام التأمينات — م 74(4)
  'force_majeure', // قوة قاهرة — م 74(5)
  'establishment_closure', // إغلاق المنشأة نهائياً — م 74(6)
  'activity_end', // إنهاء النشاط — م 74(7)
  'bankruptcy_ruling', // حكم أو قرار نهائي ضمن إجراءات الإفلاس — م 74 (إضافة 1446هـ)
  'other_law', // حالة ينص عليها نظام آخر — م 74(8)
  'death', // وفاة العامل — م 79
  'incapacity', // عجز العامل عن أداء عمله بشهادة طبية معتمدة — م 79
  'dismissal_art80', // فصل — م 80 (E6)
  'leaving_art81', // ترك العمل — م 81 (E7)
  'probation', // إنهاء خلال فترة التجربة — م 53، م 54 (E10)
  'unlawful_termination', // إنهاء من صاحب العمل لسبب غير مشروع — م 77 (E5)
  'marriage_or_birth_art87', // إنهاء من العاملة خلال 6 أشهر من الزواج أو 3 أشهر من الوضع — م 87 (E14)
] as const;
export type EosReason = (typeof EOS_REASONS)[number];
export const EOS_REASON_AR: Record<EosReason, string> = {
  mutual_agreement: 'اتفاق الطرفين كتابةً (المادة 74/1)',
  contract_expiry: 'انتهاء مدة العقد (المادة 74/2)',
  employer_notice: 'إنهاء من صاحب العمل بإشعار — عقد غير محدد المدة (المادتان 74/3 و75)',
  employee_notice: 'إنهاء من العامل بإشعار — عقد غير محدد المدة (المادتان 74/3 و75)',
  resignation: 'استقالة (المادتان 74/3 مكرر و79 مكرر)',
  retirement: 'بلوغ سن التقاعد وفق نظام التأمينات الاجتماعية (المادة 74/4)',
  force_majeure: 'قوة قاهرة (المادة 74/5)',
  establishment_closure: 'إغلاق المنشأة نهائياً (المادة 74/6)',
  activity_end: 'إنهاء النشاط الذي يعمل فيه العامل (المادة 74/7)',
  bankruptcy_ruling: 'حكم أو قرار نهائي بإنهاء العقد ضمن إجراءات الإفلاس (المادة 74)',
  other_law: 'حالة أخرى ينص عليها نظام آخر (المادة 74/8)',
  death: 'وفاة العامل (المادة 79)',
  incapacity: 'عجز العامل عن أداء عمله بشهادة طبية معتمدة (المادة 79)',
  dismissal_art80: 'فصل — المادة 80',
  leaving_art81: 'ترك العمل — المادة 81',
  probation: 'إنهاء خلال فترة التجربة (المادتان 53 و54)',
  unlawful_termination: 'إنهاء من صاحب العمل لسبب غير مشروع (المادة 77)',
  marriage_or_birth_art87: 'إنهاء من العاملة بعد الزواج أو الوضع (المادة 87)',
};
/** Who starts the ending — decides notice (E2), art. 82 (E8), art. 155 (E26) and the settlement deadline (E15). */
export const EOS_INITIATED_BY_EMPLOYER: readonly EosReason[] = ['employer_notice', 'dismissal_art80', 'unlawful_termination', 'establishment_closure', 'activity_end', 'retirement'];
export const EOS_INITIATED_BY_EMPLOYEE: readonly EosReason[] = ['employee_notice', 'resignation', 'leaving_art81', 'marriage_or_birth_art87'];
/** E12 (art. 85): the resignation fractions apply to these; never to arts. 81 and 87 or to force majeure. */
export const EOS_RESIGNATION_FRACTION_REASONS: readonly EosReason[] = ['resignation', 'employee_notice'];
/** E6 (art. 80): no award, notice or compensation. */
export const EOS_NO_AWARD_REASONS: readonly EosReason[] = ['dismissal_art80'];
/** E8 (art. 82): only these are blocked by an ongoing sick leave; art. 80 warns. */
export const EOS_ART82_BLOCKED_REASONS: readonly EosReason[] = ['employer_notice', 'unlawful_termination', 'probation'];
/** E26 (art. 155): employer-initiated endings blocked during pregnancy or maternity leave. */
export const EOS_ART155_BLOCKED_REASONS: readonly EosReason[] = ['dismissal_art80', 'employer_notice', 'unlawful_termination', 'probation'];

// ---------- E6: the nine exhaustive cases of art. 80 ----------
export const ART80_CASES = [
  { code: 'assault', n: 1, labelAr: 'الاعتداء على صاحب العمل أو المدير المسؤول أو أحد الرؤساء أو زميل أثناء العمل أو بسببه' },
  { code: 'essential_breach', n: 2, labelAr: 'عدم أداء الالتزامات الجوهرية أو عدم إطاعة الأوامر المشروعة أو تعمّد عدم مراعاة تعليمات السلامة المعلنة بعد إنذار كتابي' },
  { code: 'misconduct', n: 3, labelAr: 'ثبوت اتباع سلوك سيء أو ارتكاب عمل مخلّ بالشرف أو الأمانة' },
  { code: 'deliberate_loss', n: 4, labelAr: 'تعمّد إلحاق خسارة مادية بصاحب العمل (مع إبلاغ الجهات المختصة خلال 24 ساعة)' },
  { code: 'fraud_to_obtain_job', n: 5, labelAr: 'التزوير للحصول على العمل' },
  { code: 'probation', n: 6, labelAr: 'الإنهاء خلال فترة التجربة' },
  { code: 'absence', n: 7, labelAr: 'إذا تغيب العامل دون سبب مشروع أكثر من ثلاثين يوماً خلال السنة العقدية الواحدة أو أكثر من خمسة عشر يوماً متتالية، على أن يسبق الفصل إنذار كتابي من صاحب العمل للعامل بعد غيابه عشرين يوماً في الحالة الأولى وانقطاعه عشرة أيام في الحالة الثانية' },
  { code: 'position_abuse', n: 8, labelAr: 'استغلال المركز الوظيفي بطريقة غير مشروعة للحصول على نتائج ومكاسب شخصية' },
  { code: 'secrets', n: 9, labelAr: 'إفشاء الأسرار الصناعية أو التجارية الخاصة بالعمل' },
] as const;
export type Art80Case = (typeof ART80_CASES)[number]['code'];
export const ART80_CASE_CODES = ART80_CASES.map((c) => c.code) as unknown as readonly [Art80Case, ...Art80Case[]];
/** Art. 80(7) as written: the thresholds are the article's own numbers, not settings. */
export const ART80_ABSENCE = { intermittentDays: 30, consecutiveDays: 15, warningAfterIntermittent: 20, warningAfterConsecutive: 10 } as const;

// ---------- E7: art. 81 cases ----------
export const ART81_CASES = [
  { code: 'employer_breach', n: 1, labelAr: 'إخلال صاحب العمل بالتزاماته الجوهرية التعاقدية أو النظامية' },
  { code: 'fraud_at_hiring', n: 2, labelAr: 'الغش عند التعاقد في شروط العمل وظروفه' },
  { code: 'different_work', n: 3, labelAr: 'التكليف دون رضا العامل بعمل يختلف جوهرياً عن المتفق عليه' },
  { code: 'employer_assault', n: 4, labelAr: 'اعتداء صاحب العمل أو من يمثله على العامل' },
  { code: 'cruelty', n: 5, labelAr: 'معاملة قاسية أو جائرة أو مهينة من صاحب العمل أو من يمثله' },
  { code: 'serious_danger', n: 6, labelAr: 'خطر جسيم يهدد سلامة العامل أو صحته مع علم صاحب العمل وعدم إزالته' },
  { code: 'forced_resignation', n: 7, labelAr: 'حمل صاحب العمل العامل ظلماً بتصرفاته على أن يكون هو المنهي للعقد' },
] as const;
export type Art81Case = (typeof ART81_CASES)[number]['code'];
export const ART81_CASE_CODES = ART81_CASES.map((c) => c.code) as unknown as readonly [Art81Case, ...Art81Case[]];

// ---------- workflow states (HR_PLAN §4.8 + E25 resignation sub-states) ----------
export const OFFBOARDING_STATES = [
  'resignation_submitted',
  'resignation_postponed',
  'resignation_withdrawn',
  'requested',
  'under_review',
  'approved',
  'completed',
  'rejected',
  'cancelled',
] as const;
export type OffboardingState = (typeof OFFBOARDING_STATES)[number];
export const OFFBOARDING_STATE_AR: Record<OffboardingState, string> = {
  resignation_submitted: 'استقالة مقدَّمة',
  resignation_postponed: 'استقالة مؤجَّلة',
  resignation_withdrawn: 'استقالة معدول عنها',
  requested: 'طلب إنهاء خدمة',
  under_review: 'قيد المراجعة',
  approved: 'معتمد — الخطوات جارية',
  completed: 'منتهي الخدمة',
  rejected: 'مرفوض',
  cancelled: 'ملغي',
};
export const OFFBOARDING_STEPS = ['settlement', 'custody_return', 'it_closure', 'exit_interview'] as const;
export type OffboardingStep = (typeof OFFBOARDING_STEPS)[number];
export const OFFBOARDING_STEP_AR: Record<OffboardingStep, string> = {
  settlement: 'إعداد المخالصة النهائية',
  custody_return: 'استرداد العهد',
  it_closure: 'إغلاق الصلاحيات والحسابات',
  exit_interview: 'مقابلة الخروج',
};
export const SETTLEMENT_STATES = ['pending', 'computed', 'approved', 'at_finance', 'paid'] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];
export const SETTLEMENT_STATE_AR: Record<SettlementState, string> = {
  pending: 'لم تُحسب',
  computed: 'محسوبة — بانتظار اعتماد الموارد البشرية',
  approved: 'معتمدة',
  at_finance: 'لدى المالية',
  paid: 'مدفوعة',
};
/** Settlement line codes [HR §3.10.4; E3, E5, E11–E18, E20]. */
export const SETTLEMENT_LINE_CODES = [
  'eos_award', // مكافأة نهاية الخدمة — م 84–87
  'unused_leave', // رصيد الإجازة السنوية — م 111
  'overtime_leave', // رصيد إجازة تعويض العمل الإضافي (DECISIONS §21 Q5)
  'pending_salary', // أجر أيام الشهر الأخير — م 2
  'overtime', // عمل إضافي معتمد غير مدفوع — م 107
  'notice_compensation', // تعويض مهلة الإشعار — م 76 (للموظف أو عليه)
  'unlawful_termination', // تعويض الإنهاء غير المشروع — م 77
  'return_ticket', // تذكرة العودة لغير السعودي — م 40
  'advance_outstanding', // سلف متبقية — م 88
  'custody_not_returned', // عهدة غير مُرجعة — م 88
  'absence', // غياب الشهر الأخير
  'fine', // جزاء مثبت لم يُخصم — م 70
  'other_earning',
  'other_deduction',
] as const;
export type SettlementLineCode = (typeof SETTLEMENT_LINE_CODES)[number];
export const SETTLEMENT_LINE_AR: Record<SettlementLineCode, string> = {
  eos_award: 'مكافأة نهاية الخدمة',
  unused_leave: 'رصيد الإجازة السنوية',
  overtime_leave: 'رصيد إجازة تعويض العمل الإضافي',
  pending_salary: 'أجر أيام الشهر الأخير',
  overtime: 'عمل إضافي معتمد',
  notice_compensation: 'تعويض مهلة الإشعار',
  unlawful_termination: 'تعويض الإنهاء لسبب غير مشروع',
  return_ticket: 'تذكرة العودة',
  advance_outstanding: 'سلف متبقية',
  custody_not_returned: 'عهدة غير مُرجعة',
  absence: 'غياب',
  fine: 'جزاء',
  other_earning: 'استحقاق آخر',
  other_deduction: 'خصم آخر',
};

// ---------- settings ----------
/** E1: retirement age from the Social Insurance Law — effective-dated rows by GOSI join date and (if needed) gender; blank until HR fills it. */
export const retirementRuleSchema = z.object({
  /** Applies to employees whose `gosiJoinDate` is on or after this day (null = everyone not matched by a later row). */
  gosiJoinedFrom: riyadhDaySchema.nullable(),
  gender: z.enum(['male', 'female']).nullable(),
  ageYears: z.number().int().min(40).max(80),
  note: z.string().max(300).optional(),
});
export const retirementRulesSchema = z.array(retirementRuleSchema);
export type RetirementRule = z.infer<typeof retirementRuleSchema>;

export const eosPolicySchema = z.object({
  /** Who approves the end-of-service request and the settlement (Q9: HR manager). */
  approverRole: z.string().min(1),
  settlementApproverRole: z.string().min(1),
  /** E25 (art. 79 bis): the article's own days — kept visible in settings but never below the law. */
  resignationDeemedAcceptedDays: z.number().int().min(30).max(30),
  resignationMaxPostponeDays: z.number().int().min(60).max(60),
  resignationWithdrawDays: z.number().int().min(7).max(7),
  /** E2 (art. 75): minimum notice in days. */
  noticeEmployerMonthlyDays: z.number().int().min(60).max(60),
  noticeEmployeeMonthlyDays: z.number().int().min(30).max(30),
  noticeNonMonthlyDays: z.number().int().min(30).max(30),
  /** E15 (art. 88): settlement due within a week (employer ended) or two weeks (employee ended). */
  settlementDueEmployerDays: z.number().int().min(7).max(7),
  settlementDueEmployeeDays: z.number().int().min(14).max(14),
  /** E1 / DECISIONS §22 Q5: alert this many days before the retirement age. */
  retirementAlertDays: z.number().int().min(0).max(365),
  /** E13 / O3: months averaged for the commissions that enter the award wage — «يُؤكَّد من الموارد البشرية». */
  commissionAverageMonths: z.number().int().min(1).max(24),
  /** Allowance types that count as commissions (art. 2 / art. 86). */
  commissionAllowanceTypes: z.array(z.string().min(1)),
  /** E20 (art. 40): default return-ticket amount for a non-Saudi (halalas, null = enter by hand). */
  returnTicketDefaultHalalas: z.number().int().min(0).nullable(),
  /** E23 (Q14): years the file is kept read-only after the last working day. */
  retentionYears: z.number().int().min(1).max(30),
});
export type EosPolicy = z.infer<typeof eosPolicySchema>;
export const DEFAULT_EOS_POLICY: EosPolicy = {
  approverRole: 'hr_manager',
  settlementApproverRole: 'hr_manager',
  resignationDeemedAcceptedDays: 30,
  resignationMaxPostponeDays: 60,
  resignationWithdrawDays: 7,
  noticeEmployerMonthlyDays: 60,
  noticeEmployeeMonthlyDays: 30,
  noticeNonMonthlyDays: 30,
  settlementDueEmployerDays: 7,
  settlementDueEmployeeDays: 14,
  retirementAlertDays: 90,
  commissionAverageMonths: 12,
  commissionAllowanceTypes: ['عمولة', 'عمولات', 'عمولة مبيعات'],
  returnTicketDefaultHalalas: null,
  retentionYears: 10,
};

/** Q13: the exit-interview questions, versioned as data. */
export const exitInterviewTemplateSchema = z.object({
  version: z.number().int().min(1),
  questions: z.array(z.object({ key: z.string().min(1), labelAr: z.string().min(1), kind: z.enum(['text', 'rating', 'yes_no']) })).min(1),
});
export type ExitInterviewTemplate = z.infer<typeof exitInterviewTemplateSchema>;
export const DEFAULT_EXIT_INTERVIEW_TEMPLATE: ExitInterviewTemplate = {
  version: 1,
  questions: [
    { key: 'reason', labelAr: 'سبب ترك العمل', kind: 'text' },
    { key: 'environment', labelAr: 'تقييم بيئة العمل', kind: 'rating' },
    { key: 'manager', labelAr: 'تقييم المدير المباشر', kind: 'rating' },
    { key: 'development', labelAr: 'تقييم فرص التطوير', kind: 'rating' },
    { key: 'improve', labelAr: 'ما الذي يمكن تحسينه', kind: 'text' },
    { key: 'recommend', labelAr: 'هل توصي بالجمعية كمكان عمل', kind: 'yes_no' },
    { key: 'notes', labelAr: 'ملاحظات', kind: 'text' },
  ],
};

// ---------- schemas ----------
export const createOffboardingSchema = z
  .object({
    employeeId: objectIdSchema,
    reason: z.enum(EOS_REASONS),
    /** E6: the art. 80 case, from the fixed list only. */
    art80Case: z.enum(ART80_CASE_CODES).optional(),
    /** E6: the objection hearing — date, what the employee said (or that they declined), attachment. Mandatory for art. 80. */
    hearing: z.object({ heldAt: riyadhDaySchema, summary: z.string().trim().min(5).max(5000), attachmentIds: z.array(objectIdSchema).default([]), employeeDeclined: z.boolean().default(false) }).optional(),
    /** E7: the art. 81 case. */
    art81Case: z.enum(ART81_CASE_CODES).optional(),
    /** E14 (art. 87): the marriage or birth date when it is not on an approved leave request. */
    eventDate: riyadhDaySchema.optional(),
    eventAttachmentId: objectIdSchema.optional(),
    /** E1 (art. 79): the medical certificate for incapacity. */
    medicalCertificateAttachmentId: objectIdSchema.optional(),
    noticeDate: riyadhDaySchema.optional(),
    lastWorkingDay: riyadhDaySchema,
    details: z.string().trim().max(3000).optional(),
    attachmentIds: z.array(objectIdSchema).default([]),
    /** E1: HR confirms the employee's written agreement for `mutual_agreement`. */
    writtenAgreementAttachmentId: objectIdSchema.optional(),
  })
  .refine((d) => d.reason !== 'dismissal_art80' || !!d.art80Case, { message: 'حدّد بند المادة 80 من القائمة', path: ['art80Case'] })
  .refine((d) => d.reason !== 'dismissal_art80' || !!d.hearing, { message: 'محضر إبداء أسباب المعارضة مطلوب قبل الفصل (المادة 80)', path: ['hearing'] })
  .refine((d) => d.reason !== 'leaving_art81' || !!d.art81Case, { message: 'حدّد بند المادة 81 من القائمة', path: ['art81Case'] })
  .refine((d) => d.reason !== 'mutual_agreement' || !!d.writtenAgreementAttachmentId, { message: 'اتفاق الطرفين يكون كتابةً — أرفق الاتفاق (المادة 74/1)', path: ['writtenAgreementAttachmentId'] })
  .refine((d) => d.reason !== 'incapacity' || !!d.medicalCertificateAttachmentId, { message: 'الشهادة الطبية المعتمدة مطلوبة (المادة 79)', path: ['medicalCertificateAttachmentId'] });
export type CreateOffboardingInput = z.infer<typeof createOffboardingSchema>;

/** E25: the employee's own resignation through «رفع طلب». */
export const resignSchema = z.object({
  reason: z.string().trim().min(2).max(3000),
  /** Optional requested last working day; the legal end date is computed by the server (earliest of the three). */
  requestedLastWorkingDay: riyadhDaySchema.optional(),
  /** E14 (art. 87): a female employee resigning after marriage or childbirth asks for the full award. */
  art87Event: z.enum(['marriage', 'birth']).optional(),
  art87EventDate: riyadhDaySchema.optional(),
  art87AttachmentId: objectIdSchema.optional(),
  attachmentIds: z.array(objectIdSchema).default([]),
});
export type ResignInput = z.infer<typeof resignSchema>;

export const offboardingTransitionSchema = z.object({
  transition: z.enum([
    'submit', // requested → under_review
    'approve', // under_review → approved (status, steps start)
    'reject',
    'cancel',
    'complete',
    // E25 resignation
    'accept_resignation',
    'postpone_resignation',
    'withdraw_resignation',
  ]),
  reason: z.string().trim().max(3000).optional(),
  /** `postpone_resignation`: the new end date, ≤ submission + 60 days. */
  postponedUntil: riyadhDaySchema.optional(),
  /** `approve`: HR may fix the last working day (e.g. after the notice computation). */
  lastWorkingDay: riyadhDaySchema.optional(),
});

export const settlementLineEditSchema = z.object({
  code: z.enum(SETTLEMENT_LINE_CODES),
  labelAr: z.string().trim().min(1).max(200).optional(),
  amountHalalas: z.number().int().min(0),
  kind: z.enum(['earning', 'deduction']),
  reason: z.string().trim().min(2).max(1000),
});
export const settlementActionSchema = z.object({
  action: z.enum(['compute', 'edit_line', 'approve', 'record_payment']),
  line: settlementLineEditSchema.optional(),
  /** `record_payment` (Finance). */
  paidAt: riyadhDaySchema.optional(),
  paymentRef: z.string().trim().max(120).optional(),
  proofAttachmentId: objectIdSchema.optional(),
  note: z.string().trim().max(2000).optional(),
});
export const custodyReturnStepSchema = z.object({
  custodyId: objectIdSchema,
  returnedAt: riyadhDaySchema,
  condition: z.string().trim().max(300).optional(),
  /** E15 / E17: an unreturned item may be charged at an approved value (deduction line). */
  notReturned: z.boolean().default(false),
  chargeHalalas: z.number().int().min(0).optional(),
});
export const itClosureSchema = z.object({ note: z.string().trim().max(2000).optional(), assetsReturned: z.boolean().default(true) });
export const exitInterviewSchema = z.object({
  answers: z.array(z.object({ key: z.string().min(1), value: z.union([z.string().max(5000), z.number(), z.boolean()]) })).min(1),
  interviewedAt: riyadhDaySchema,
  /** The employee may decline the interview; the step is then marked done with that note. */
  declined: z.boolean().default(false),
});
export const listOffboardingsQuerySchema = z.object({
  state: z.enum(OFFBOARDING_STATES).optional(),
  open: z.coerce.boolean().optional(),
  employeeId: objectIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

/** E26 (art. 155): a declared pregnancy on the employee file — sensitive, HR-entered, with the medical certificate. */
export const pregnancyRecordSchema = z.object({
  declaredAt: riyadhDaySchema,
  expectedDeliveryDate: riyadhDaySchema,
  certificateAttachmentId: objectIdSchema.optional(),
  /** Set when the protection ends (after the maternity leave and any related sick leave). */
  endedAt: riyadhDaySchema.nullable().optional(),
  note: z.string().trim().max(1000).optional(),
});
export type PregnancyRecordInput = z.infer<typeof pregnancyRecordSchema>;
