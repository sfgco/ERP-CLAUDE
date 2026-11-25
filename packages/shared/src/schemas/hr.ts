import { z } from 'zod';
import { EMPLOYEE_STATUSES } from '../enums';
import { emailSchema, objectIdSchema, phoneSchema } from './common';

/** Employee file [HR §3.3, EP §5–8]. HR owns it; the portal displays it (EP §20.1). */
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor', 'intern', 'other'] as const;
export const EMPLOYMENT_TYPE_AR: Record<(typeof EMPLOYMENT_TYPES)[number], string> = {
  full_time: 'دوام كامل',
  part_time: 'دوام جزئي',
  contractor: 'متعاقد',
  intern: 'متدرب',
  other: 'أخرى',
};
/** `specific_work`: T10 (art. 57) — a contract for a specific job ends when the job is done (H3b). */
export const CONTRACT_TYPES = ['fixed_term', 'open_ended', 'seasonal', 'specific_work', 'other'] as const;
export const CONTRACT_TYPE_AR: Record<(typeof CONTRACT_TYPES)[number], string> = {
  fixed_term: 'محدد المدة',
  open_ended: 'غير محدد المدة',
  seasonal: 'موسمي',
  specific_work: 'عمل معيّن (المادة 57)',
  other: 'أخرى',
};
export const CONTRACT_STATUSES = ['active', 'expired', 'renewing', 'terminated'] as const;
export const CONTRACT_STATUS_AR: Record<(typeof CONTRACT_STATUSES)[number], string> = {
  active: 'ساري',
  expired: 'منتهي',
  renewing: 'قيد التجديد',
  terminated: 'منتهٍ بإنهاء الخدمة',
};
export const IDENTITY_TYPES = ['national_id', 'iqama', 'passport', 'other'] as const;
export const IDENTITY_TYPE_AR: Record<(typeof IDENTITY_TYPES)[number], string> = {
  national_id: 'هوية وطنية',
  iqama: 'إقامة',
  passport: 'جواز سفر',
  other: 'أخرى',
};
export const GENDERS = ['male', 'female'] as const;

/** Fields visible only to the employee and authorized HR/Finance users (EP §5.2, §8, §8.1; CLAUDE.md "Sensitive fields"). */
export const EMPLOYEE_SENSITIVE_FIELDS = [
  'identity.number',
  'religion',
  'birthDate',
  'basicSalaryHalalas',
  'allowances',
  'bank',
  /** E26 (art. 155): the declared pregnancy — HR and the employee only (H3b). */
  'pregnancy',
] as const;
/** Document types with expiry alerts [HR §3.9]. */
export const EMPLOYEE_DOCUMENT_TYPES = [
  'contract',
  'identity',
  'qualification',
  'professional_certificate',
  'job_description',
  'bank_proof',
  'other',
] as const;
export const EMPLOYEE_DOCUMENT_TYPE_AR: Record<(typeof EMPLOYEE_DOCUMENT_TYPES)[number], string> = {
  contract: 'عقد العمل',
  identity: 'الهوية أو الإقامة',
  qualification: 'مؤهل علمي',
  professional_certificate: 'شهادة مهنية',
  job_description: 'الوصف الوظيفي',
  bank_proof: 'إثبات الحساب البنكي',
  other: 'مستند رسمي آخر',
};

const addressSchema = z.object({
  buildingNo: z.string().trim().max(10).optional(),
  street: z.string().trim().max(120).optional(),
  district: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(10).optional(),
});

const allowanceSchema = z.object({ type: z.string().trim().min(1), amountHalalas: z.number().int().min(0) });

export const createEmployeeSchema = z.object({
  /** Blank → generated EMP-YYYY-#####; imported employees keep their number (DECISIONS §10). */
  employeeNumber: z.string().trim().max(30).optional(),
  firstNameAr: z.string().trim().min(2),
  lastNameAr: z.string().trim().min(2),
  fullNameAr: z.string().trim().min(4).optional(),
  fullNameEn: z.string().trim().optional(),
  gender: z.enum(GENDERS),
  birthDate: z.coerce.date().optional(),
  nationality: z.string().trim().min(2),
  religion: z.string().trim().optional(),
  identity: z.object({
    type: z.enum(IDENTITY_TYPES),
    number: z.string().trim().min(5),
    expiryDate: z.coerce.date().optional(),
  }),
  workEmail: emailSchema,
  mobile: phoneSchema.optional(),
  extension: z.string().trim().max(10).optional(),
  address: addressSchema.optional(),
  departmentId: objectIdSchema,
  unitId: objectIdSchema.optional(),
  positionId: objectIdSchema.optional(),
  grade: z.string().trim().optional(),
  branchId: objectIdSchema.optional(),
  siteId: objectIdSchema.optional(),
  directManagerId: objectIdSchema.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  hireDate: z.coerce.date(),
  status: z.enum(EMPLOYEE_STATUSES).default('active'),
  basicSalaryHalalas: z.number().int().min(0).optional(),
  allowances: z.array(allowanceSchema).default([]),
  bank: z
    .object({
      bankName: z.string().trim().min(2),
      iban: z
        .string()
        .trim()
        .regex(/^SA\d{22}$/i, 'آيبان سعودي غير صالح'),
    })
    .optional(),
  medicalInsurance: z.boolean().default(false),
  /** T4 (arts. 33, 38): work permit of a non-Saudi — number, licensed profession, expiry (H3b). */
  workPermit: z.object({ number: z.string().trim().max(40).optional(), professionAr: z.string().trim().max(120).optional(), expiryDate: z.coerce.date().nullable().optional() }).optional(),
  /** T14: cooperative health insurance policy (H3b). */
  medicalInsurancePolicy: z.object({ number: z.string().trim().max(60).optional(), expiryDate: z.coerce.date().nullable().optional() }).optional(),
  /** First GOSI registration date — drives the contribution-rate group (DECISIONS §21 Q8) [HR §3.6.3]. */
  gosiJoinDate: z.coerce.date().nullable().optional(),
  /** Create the portal account now (temporary password returned once). */
  createAccount: z.boolean().default(true),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/** HR edits official data; job moves go through the dedicated actions below so history stays append-only. */
export const updateEmployeeSchema = createEmployeeSchema
  .omit({
    createAccount: true,
    departmentId: true,
    positionId: true,
    directManagerId: true,
    status: true,
    employeeNumber: true,
    hireDate: true,
  })
  .partial();
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

/** A transfer always names the new direct manager (slice 1 review); pending approvals move with it. */
export const transferEmployeeSchema = z.object({
  departmentId: objectIdSchema,
  unitId: objectIdSchema.nullable().optional(),
  branchId: objectIdSchema.nullable().optional(),
  siteId: objectIdSchema.nullable().optional(),
  directManagerId: objectIdSchema,
  effectiveDate: z.coerce.date(),
  reason: z.string().trim().min(2),
});
export const promoteEmployeeSchema = z.object({
  positionId: objectIdSchema,
  grade: z.string().trim().optional(),
  basicSalaryHalalas: z.number().int().min(0).optional(),
  effectiveDate: z.coerce.date(),
  reason: z.string().trim().min(2),
});
export const changeManagerSchema = z.object({
  directManagerId: objectIdSchema.nullable(),
  effectiveDate: z.coerce.date(),
  reason: z.string().trim().min(2),
});
export const changeStatusSchema = z.object({
  status: z.enum(EMPLOYEE_STATUSES),
  effectiveDate: z.coerce.date(),
  reason: z.string().trim().min(2),
  /** Secondment details [EP §5.3]. */
  secondment: z
    .object({ destination: z.string().trim().min(2), startDate: z.coerce.date(), endDate: z.coerce.date() })
    .optional(),
});

export const listEmployeesQuerySchema = z.object({
  q: z.string().trim().optional(),
  departmentId: objectIdSchema.optional(),
  branchId: objectIdSchema.optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  managerId: objectIdSchema.optional(),
  /** Dashboard drill-downs «حسب الجنسية ونوع التوظيف» [HR §5 أولاً]. */
  nationality: z.string().trim().max(60).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  /** Employees whose probation ends within N days (go-live review H5, HR dashboard drill-down). */
  probationWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export const custodySchema = z.object({
  itemName: z.string().trim().min(2),
  assetTag: z.string().trim().optional(),
  serialNumber: z.string().trim().optional(),
  issuedAt: z.coerce.date(),
  notes: z.string().trim().optional(),
  attachmentId: objectIdSchema.optional(),
});
export const custodyReturnSchema = z.object({
  returnedAt: z.coerce.date(),
  condition: z.string().trim().optional(),
});

export const contractSchema = z.object({
  type: z.enum(CONTRACT_TYPES),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  /** Legacy direct entry; when `probationDays` is given the server computes the end with the art. 53 excluded days (T7). */
  probationEndDate: z.coerce.date().nullable().optional(),
  probationDays: z.number().int().min(0).max(180).optional(),
  durationMonths: z.number().int().positive().optional(),
  attachmentId: objectIdSchema.optional(),
  notes: z.string().trim().optional(),
  // H3b legal fields (docs/HR_H3B_LEGAL.md T9, T10, E2, E9, E13)
  wagePeriod: z.enum(['monthly', 'non_monthly']).optional(),
  renewalClause: z.object({ enabled: z.boolean(), periodMonths: z.number().int().min(1).max(60).optional() }).optional(),
  workDescription: z.string().trim().max(2000).optional(),
  awardExcludesVariableWage: z.boolean().optional(),
  awardExclusionClauseRef: z.string().trim().max(300).optional(),
  nonCompete: z.object({ months: z.number().int().min(1).max(24), scopeAr: z.string().trim().min(3).max(1000) }).optional(),
  /** T8: HR declares a different profession when re-hiring (art. 54 exception). */
  differentProfession: z.boolean().optional(),
});
export const contractAddendumSchema = z.object({
  titleAr: z.string().trim().min(2),
  attachmentId: objectIdSchema,
  notes: z.string().trim().optional(),
});
export const contractStatusSchema = z.object({
  status: z.enum(CONTRACT_STATUSES),
  reason: z.string().trim().optional(),
});
