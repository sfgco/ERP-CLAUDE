import { z } from 'zod';
import { objectIdSchema, riyadhDaySchema } from './common';
import { CONTRACT_TYPES, EMPLOYMENT_TYPES } from './hr';

/**
 * Recruitment [HR §3.2] — shared enums, verbatim labels and schemas (HR_PLAN §3.6, §4.3–4.4; docs/HR_H3B_LEGAL.md T1–T14).
 * Money is integer halalas. Salary data on requisitions and offers is sensitive (default deny).
 */
export const REQUISITION_STATES = ['draft', 'submitted', 'needs_completion', 'approved', 'posted', 'closed', 'rejected', 'cancelled'] as const;
export type RequisitionState = (typeof REQUISITION_STATES)[number];
export const REQUISITION_STATE_AR: Record<RequisitionState, string> = {
  draft: 'مسودة',
  submitted: 'بانتظار الاعتماد',
  needs_completion: 'يحتاج استكمال',
  approved: 'معتمد',
  posted: 'معلن عنها',
  closed: 'مغلق',
  rejected: 'مرفوض',
  cancelled: 'ملغي',
};

export const APPLICANT_STAGES = ['new', 'screened', 'shortlisted', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn'] as const;
export type ApplicantStage = (typeof APPLICANT_STAGES)[number];
export const APPLICANT_STAGE_AR: Record<ApplicantStage, string> = {
  new: 'جديد',
  screened: 'تم الفرز',
  shortlisted: 'قائمة مختصرة',
  interviewing: 'في المقابلات',
  offered: 'عرض مُرسل',
  hired: 'تم التعيين',
  rejected: 'مرفوض',
  withdrawn: 'انسحب',
};
/** Where a stage may move next (the Kanban drag rules — hired happens only through an offer's `contract`). */
export const APPLICANT_STAGE_NEXT: Record<ApplicantStage, readonly ApplicantStage[]> = {
  new: ['screened', 'rejected', 'withdrawn'],
  screened: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['interviewing', 'rejected', 'withdrawn'],
  interviewing: ['shortlisted', 'rejected', 'withdrawn'],
  offered: ['withdrawn'],
  hired: [],
  rejected: ['screened'],
  withdrawn: [],
};

/**
 * T1 (art. 3): rejection reasons are a professional list — never gender, disability, age, nationality or any other
 * protected ground. The list is a setting (`hr.recruitment.rejectionReasons`); these are the defaults.
 */
export const DEFAULT_REJECTION_REASONS = [
  { code: 'qualification', labelAr: 'المؤهل لا يطابق متطلبات الوظيفة' },
  { code: 'experience', labelAr: 'الخبرة أقل من المطلوب' },
  { code: 'skills', labelAr: 'المهارات المطلوبة غير متوافرة' },
  { code: 'interview', labelAr: 'نتيجة المقابلة دون الحد المطلوب' },
  { code: 'salary_expectation', labelAr: 'توقعات الراتب خارج النطاق المعتمد' },
  { code: 'availability', labelAr: 'تاريخ المباشرة غير مناسب' },
  { code: 'position_filled', labelAr: 'تم شغل الوظيفة' },
  { code: 'other_professional', labelAr: 'سبب مهني آخر (يُذكر)' },
] as const;

export const INTERVIEW_STATES = ['scheduled', 'done', 'no_show', 'cancelled'] as const;
export type InterviewState = (typeof INTERVIEW_STATES)[number];
export const INTERVIEW_STATE_AR: Record<InterviewState, string> = { scheduled: 'مجدولة', done: 'تمت', no_show: 'لم يحضر', cancelled: 'ملغاة' };
export const INTERVIEW_MODES = ['in_person', 'remote', 'phone'] as const;
export const INTERVIEW_MODE_AR: Record<(typeof INTERVIEW_MODES)[number], string> = { in_person: 'حضورية', remote: 'عن بُعد', phone: 'هاتفية' };
export const INTERVIEW_RECOMMENDATIONS = ['proceed', 'reject', 'hold'] as const;
export const INTERVIEW_RECOMMENDATION_AR: Record<(typeof INTERVIEW_RECOMMENDATIONS)[number], string> = { proceed: 'المتابعة', reject: 'عدم المتابعة', hold: 'تعليق' };

export const OFFER_STATES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired', 'withdrawn', 'contracted', 'onboarded'] as const;
export type OfferState = (typeof OFFER_STATES)[number];
export const OFFER_STATE_AR: Record<OfferState, string> = {
  draft: 'مسودة',
  pending_approval: 'بانتظار الاعتماد',
  approved: 'معتمد',
  sent: 'أُرسل للمرشح',
  accepted: 'قبل المرشح العرض',
  declined: 'رفض المرشح',
  expired: 'منتهي الصلاحية',
  withdrawn: 'مسحوب',
  contracted: 'تم التعاقد',
  onboarded: 'تمت المباشرة',
};

export const WAGE_PERIODS = ['monthly', 'non_monthly'] as const;
export type WagePeriod = (typeof WAGE_PERIODS)[number];
export const WAGE_PERIOD_AR: Record<WagePeriod, string> = { monthly: 'شهري', non_monthly: 'غير شهري (أسبوعي / يومي / بالقطعة)' };

// ---------- recruitment policy (Q10, DECISIONS §21) ----------
export const recruitmentPolicySchema = z.object({
  /** Roles that may raise a requisition besides department managers (relation). */
  requisitionRaisers: z.array(z.string()).min(1),
  requisitionApproverRole: z.string().min(1),
  /** A requisition above this monthly salary (halalas) or headcount needs the executive too (null = never). */
  executiveSalaryThresholdHalalas: z.number().int().min(0).nullable(),
  executiveHeadcountThreshold: z.number().int().min(1).nullable(),
  postingChannels: z.array(z.object({ code: z.string().min(1), labelAr: z.string().min(1) })),
  interviewCriteria: z.array(z.object({ code: z.string().min(1), labelAr: z.string().min(1) })),
  scoreMin: z.number().int().min(0),
  scoreMax: z.number().int().min(1),
  offerApproverRole: z.string().min(1),
  /** Rejected applicants' CVs are purged after N months (PDPL, Q10: 12). */
  cvRetentionMonths: z.number().int().min(1).max(60),
  rejectionReasons: z.array(z.object({ code: z.string().min(1), labelAr: z.string().min(1) })).min(1),
  /** T2 (arts. 162–163): minimum age to hire and the age below which a warning is shown. */
  minimumHireAge: z.number().int().min(15).max(21),
  juvenileWarningBelowAge: z.number().int().min(15).max(21),
  /** T7 (art. 53): the longest probation the contract may state, in days. */
  maxProbationDays: z.number().int().min(1).max(180),
  /** T8 (art. 54): months after a previous employment before a second probation is allowed (same profession). */
  reProbationAfterMonths: z.number().int().min(1).max(24),
});
export type RecruitmentPolicy = z.infer<typeof recruitmentPolicySchema>;
export const DEFAULT_RECRUITMENT_POLICY: RecruitmentPolicy = {
  requisitionRaisers: ['department_manager', 'hr_officer', 'hr_manager'],
  requisitionApproverRole: 'hr_manager',
  executiveSalaryThresholdHalalas: null,
  executiveHeadcountThreshold: null,
  postingChannels: [
    { code: 'internal', labelAr: 'داخلي' },
    { code: 'jadarat', labelAr: 'جدارات' },
    { code: 'linkedin', labelAr: 'لينكدإن' },
    { code: 'other', labelAr: 'أخرى' },
  ],
  interviewCriteria: [
    { code: 'qualification', labelAr: 'المؤهل' },
    { code: 'experience', labelAr: 'الخبرة' },
    { code: 'skills', labelAr: 'المهارات' },
    { code: 'fit', labelAr: 'الملاءمة' },
  ],
  scoreMin: 1,
  scoreMax: 5,
  offerApproverRole: 'hr_manager',
  cvRetentionMonths: 12,
  rejectionReasons: [...DEFAULT_REJECTION_REASONS],
  minimumHireAge: 15,
  juvenileWarningBelowAge: 18,
  maxProbationDays: 180,
  reProbationAfterMonths: 6,
};

/** T3 (arts. 26, 28 + Nitaqat): the required rate comes from Qiwa; blank until HR enters it (DECISIONS §22). */
export const saudizationSettingSchema = z.object({
  requiredRatePct: z.number().min(0).max(100).nullable(),
  /** Nitaqat band and the Qiwa reading date, kept as the reference of the number. */
  nitaqatBandAr: z.string().max(60).nullable(),
  recordedAt: riyadhDaySchema.nullable(),
  /** Art. 28: 4 % of the workforce with disabilities once the establishment has 25 workers or more. */
  disabilityRatePct: z.number().min(0).max(100),
  disabilityThresholdHeadcount: z.number().int().min(1),
});
export type SaudizationSetting = z.infer<typeof saudizationSettingSchema>;
export const DEFAULT_SAUDIZATION_SETTING: SaudizationSetting = { requiredRatePct: null, nitaqatBandAr: null, recordedAt: null, disabilityRatePct: 4, disabilityThresholdHeadcount: 25 };

/** T13 / E22: government deadlines, blank until HR confirms them (DECISIONS §22 Q3). Days are calendar days. */
export const govDeadlinesSchema = z.object({
  qiwaContractDays: z.number().int().min(1).max(365).nullable(),
  gosiRegisterDays: z.number().int().min(1).max(365).nullable(),
  gosiExitDays: z.number().int().min(1).max(365).nullable(),
  qiwaExitDays: z.number().int().min(1).max(365).nullable(),
});
export type GovDeadlines = z.infer<typeof govDeadlinesSchema>;
export const DEFAULT_GOV_DEADLINES: GovDeadlines = { qiwaContractDays: null, gosiRegisterDays: null, gosiExitDays: null, qiwaExitDays: null };

// ---------- schemas ----------
const salaryRangeSchema = z.object({ minHalalas: z.number().int().min(0), maxHalalas: z.number().int().min(0) }).refine((r) => r.maxHalalas >= r.minHalalas, { message: 'الحد الأعلى أقل من الحد الأدنى', path: ['maxHalalas'] });

export const createRequisitionSchema = z.object({
  departmentId: objectIdSchema,
  positionId: objectIdSchema.optional(),
  titleAr: z.string().trim().min(2).max(160),
  headcount: z.number().int().min(1).max(500),
  justification: z.string().trim().min(5).max(3000),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  contractType: z.enum(CONTRACT_TYPES),
  durationMonths: z.number().int().min(1).max(120).optional(),
  salaryRange: salaryRangeSchema.optional(),
  /** Qualifications and skills asked of the applicants (never a protected ground — T1). */
  requirements: z.string().trim().max(3000).optional(),
  neededBy: riyadhDaySchema.optional(),
  /** T12 (art. 40): recruitment cost items for a non-Saudi hire, read-only for Finance. */
  recruitmentCosts: z.array(z.object({ labelAr: z.string().trim().min(1).max(120), amountHalalas: z.number().int().min(0) })).default([]),
  /** «حفظ طلب التوظيف كمسودة»: true keeps it in draft; false submits at once. */
  draft: z.boolean().default(true),
});
export type CreateRequisitionInput = z.infer<typeof createRequisitionSchema>;
export const updateRequisitionSchema = createRequisitionSchema.omit({ draft: true }).partial();

export const requisitionTransitionSchema = z.object({
  transition: z.enum(['submit', 'return', 'approve', 'reject', 'post', 'close', 'cancel']),
  reason: z.string().trim().max(2000).optional(),
  posting: z
    .object({
      channels: z.array(z.string().min(1)).min(1),
      closesAt: riyadhDaySchema.optional(),
      externalRefs: z.array(z.object({ channel: z.string().min(1), reference: z.string().trim().min(1).max(300) })).default([]),
    })
    .optional(),
});
export const listRequisitionsQuerySchema = z.object({
  view: z.enum(['mine', 'department', 'all']).default('all'),
  state: z.enum(REQUISITION_STATES).optional(),
  departmentId: objectIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export const createApplicantSchema = z.object({
  fullNameAr: z.string().trim().min(2).max(160),
  phone: z.string().trim().regex(/^\+?\d{9,15}$/, 'رقم جوال غير صالح'),
  email: z.string().trim().toLowerCase().email().optional(),
  nationality: z.string().trim().min(2).max(60),
  /** Kept encrypted; only the last 4 digits are stored in clear (HR_PLAN §3.6). */
  identityNumber: z.string().trim().regex(/^\d{10}$/, 'رقم الهوية أو الإقامة 10 أرقام').optional(),
  birthDate: riyadhDaySchema.optional(),
  source: z.string().trim().max(60).optional(),
  cvAttachmentId: objectIdSchema.optional(),
  qualificationAr: z.string().trim().max(200).optional(),
  experienceYears: z.number().min(0).max(60).optional(),
  currentEmployer: z.string().trim().max(160).optional(),
  expectedSalaryHalalas: z.number().int().min(0).optional(),
  notes: z.string().trim().max(3000).optional(),
});
export type CreateApplicantInput = z.infer<typeof createApplicantSchema>;
/** CSV import (DECISIONS §22 Q6): rows of the same fields; the server validates each row and reports the rejected ones. */
export const importApplicantsSchema = z.object({ rows: z.array(createApplicantSchema).min(1).max(1000) });
export const applicantStageSchema = z.object({
  stage: z.enum(APPLICANT_STAGES),
  /** From `hr.recruitment.rejectionReasons` — required for `rejected` (T1). */
  rejectionReason: z.string().trim().max(60).optional(),
  note: z.string().trim().max(2000).optional(),
});
export const applicantNoteSchema = z.object({ note: z.string().trim().min(1).max(3000) });

export const scheduleInterviewSchema = z.object({
  round: z.number().int().min(1).max(5),
  scheduledAt: z.coerce.date(),
  durationMinutes: z.number().int().min(15).max(480).default(60),
  mode: z.enum(INTERVIEW_MODES),
  location: z.string().trim().max(300).optional(),
  panelUserIds: z.array(objectIdSchema).min(1),
  notes: z.string().trim().max(2000).optional(),
});
export const interviewResultSchema = z.object({
  state: z.enum(['done', 'no_show', 'cancelled']),
  scores: z.array(z.object({ criterion: z.string().min(1), value: z.number().int().min(0).max(10) })).default([]),
  recommendation: z.enum(INTERVIEW_RECOMMENDATIONS).optional(),
  notes: z.string().trim().max(3000).optional(),
});

const allowanceSchema = z.object({ type: z.string().trim().min(1), amountHalalas: z.number().int().min(0) });
export const createOfferSchema = z.object({
  applicantId: objectIdSchema,
  positionId: objectIdSchema.optional(),
  directManagerId: objectIdSchema.optional(),
  branchId: objectIdSchema.optional(),
  siteId: objectIdSchema.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  contractType: z.enum(CONTRACT_TYPES),
  /** For a fixed-term contract (T6: mandatory for non-Saudis; defaults to the work-permit period when known). */
  durationMonths: z.number().int().min(1).max(120).optional(),
  /** T10 (art. 57): a contract for a specific job describes the job instead of an end date. */
  workDescription: z.string().trim().max(2000).optional(),
  /** T7 (art. 53): ≤ `maxProbationDays`; 0 = no probation. */
  probationDays: z.number().int().min(0).max(180).default(90),
  wagePeriod: z.enum(WAGE_PERIODS).default('monthly'),
  basicSalaryHalalas: z.number().int().min(0),
  allowances: z.array(allowanceSchema).default([]),
  /** T9 (art. 55): renewal clause of a fixed-term contract. */
  renewalClause: z.object({ enabled: z.boolean(), periodMonths: z.number().int().min(1).max(60).optional() }).default({ enabled: false }),
  /** E13 (art. 86): commissions excluded from the award only with the clause reference (DECISIONS §22 Q1). */
  awardExcludesVariableWage: z.boolean().default(false),
  awardExclusionClauseRef: z.string().trim().max(300).optional(),
  /** E9 (art. 83): ≤ 24 months, place and kind of work defined. */
  nonCompete: z.object({ months: z.number().int().min(1).max(24), scopeAr: z.string().trim().min(3).max(1000) }).optional(),
  startDate: riyadhDaySchema,
  validUntil: riyadhDaySchema,
  /** T4 (arts. 33, 38): work permit of a non-Saudi hire — number, licensed profession, expiry. */
  workPermit: z.object({ number: z.string().trim().max(40).optional(), professionAr: z.string().trim().max(120).optional(), expiryDate: riyadhDaySchema.optional() }).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateOfferInput = z.infer<typeof createOfferSchema>;
export const updateOfferSchema = createOfferSchema.omit({ applicantId: true }).partial();
export const offerTransitionSchema = z.object({
  transition: z.enum(['submit', 'approve', 'reject', 'send', 'accept', 'decline', 'withdraw', 'contract', 'record_gov_registration', 'onboard']),
  reason: z.string().trim().max(2000).optional(),
  /** `accept`: when and the signed file. */
  acceptedAt: riyadhDaySchema.optional(),
  signedAttachmentId: objectIdSchema.optional(),
  /** `contract`: what the employee file needs beyond the offer and the applicant (T5: identity, work e-mail). */
  hire: z
    .object({
      workEmail: z.string().trim().toLowerCase().email(),
      identity: z.object({ type: z.enum(['national_id', 'iqama', 'passport', 'other']), number: z.string().trim().regex(/^\d{10}$/, 'رقم الهوية أو الإقامة 10 أرقام'), expiryDate: riyadhDaySchema.optional() }),
      gender: z.enum(['male', 'female']),
      birthDate: riyadhDaySchema.optional(),
      mobile: z.string().trim().regex(/^\+?\d{9,15}$/).optional(),
      bank: z.object({ bankName: z.string().trim().min(2), iban: z.string().trim().regex(/^SA\d{22}$/i, 'IBAN سعودي غير صالح') }).optional(),
      /** T14: cooperative health insurance policy of a non-Saudi (and family). */
      medicalInsurancePolicy: z.object({ number: z.string().trim().max(60).optional(), expiryDate: riyadhDaySchema.optional() }).optional(),
      createAccount: z.boolean().default(true),
      contractAttachmentId: objectIdSchema.optional(),
      /** T8: when re-hiring, HR declares the profession is different (art. 54 exception b). */
      differentProfession: z.boolean().optional(),
    })
    .optional(),
  /** `record_gov_registration` (T13, by hand until the integrations — phase 7). */
  gov: z.object({ qiwaRef: z.string().trim().max(60).optional(), qiwaAt: riyadhDaySchema.optional(), gosiRef: z.string().trim().max(60).optional(), gosiAt: riyadhDaySchema.optional() }).optional(),
});
export const listOffersQuerySchema = z.object({
  state: z.enum(OFFER_STATES).optional(),
  requisitionId: objectIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
