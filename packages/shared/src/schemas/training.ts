import { z } from 'zod';
import { objectIdSchema } from './common';

/** Training and development [HR §3.8]: the annual plan, needs per department, courses, participation and certificates. */

export const TRAINING_PLAN_STATES = ['draft', 'submitted', 'approved', 'closed'] as const;
export type TrainingPlanState = (typeof TRAINING_PLAN_STATES)[number];
export const TRAINING_PLAN_STATE_AR: Record<TrainingPlanState, string> = {
  draft: 'مسودة',
  submitted: 'بانتظار الاعتماد',
  approved: 'معتمدة',
  closed: 'مغلقة',
};
export const trainingPlanItemSchema = z.object({
  title: z.string().trim().min(2).max(200),
  departmentIds: z.array(objectIdSchema).default([]),
  quarter: z.number().int().min(1).max(4),
  estimatedCostHalalas: z.number().int().min(0).default(0),
  needIds: z.array(objectIdSchema).default([]),
});
export const trainingPlanSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  items: z.array(trainingPlanItemSchema).max(200).default([]),
  notes: z.string().trim().max(2000).optional(),
});
export const trainingPlanTransitionSchema = z.object({
  transition: z.enum(['submit', 'approve', 'return', 'close']),
  reason: z.string().trim().max(1000).optional(),
});

export const TRAINING_NEED_STATES = ['new', 'accepted', 'planned', 'done', 'rejected'] as const;
export type TrainingNeedState = (typeof TRAINING_NEED_STATES)[number];
export const TRAINING_NEED_STATE_AR: Record<TrainingNeedState, string> = {
  new: 'جديد',
  accepted: 'مقبول',
  planned: 'مخطط',
  done: 'منفَّذ',
  rejected: 'مرفوض',
};
export const TRAINING_NEED_SOURCES = ['department', 'appraisal', 'plan'] as const;
export const TRAINING_NEED_SOURCE_AR: Record<(typeof TRAINING_NEED_SOURCES)[number], string> = {
  department: 'القسم',
  appraisal: 'نتائج تقييم الأداء',
  plan: 'خطة التدريب',
};
export const createTrainingNeedSchema = z.object({
  departmentId: objectIdSchema,
  year: z.number().int().min(2000).max(2100),
  title: z.string().trim().min(2).max(200),
  justification: z.string().trim().max(2000).optional(),
  source: z.enum(TRAINING_NEED_SOURCES).default('department'),
  /** «ربط التدريب بنتائج تقييم الأداء» [HR §3.8.3] */
  appraisalId: objectIdSchema.optional(),
  employeeIds: z.array(objectIdSchema).default([]),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
});
export const trainingNeedStateSchema = z.object({ state: z.enum(TRAINING_NEED_STATES), note: z.string().trim().max(1000).optional() });

export const TRAINING_KINDS = ['internal', 'external', 'online'] as const;
export const TRAINING_KIND_AR: Record<(typeof TRAINING_KINDS)[number], string> = { internal: 'داخلي', external: 'خارجي', online: 'عن بُعد' };
export const TRAINING_STATES = ['planned', 'open', 'running', 'completed', 'cancelled'] as const;
export type TrainingState = (typeof TRAINING_STATES)[number];
export const TRAINING_STATE_AR: Record<TrainingState, string> = {
  planned: 'مخططة',
  open: 'مفتوحة للتسجيل',
  running: 'جارية',
  completed: 'منفَّذة',
  cancelled: 'ملغاة',
};
export const createTrainingSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    /** «الجهة المقدمة» [HR §3.8.4]: a party with the supplier role, or free text (Q12). */
    providerPartyId: objectIdSchema.optional(),
    providerName: z.string().trim().max(200).optional(),
    kind: z.enum(TRAINING_KINDS).default('internal'),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    location: z.string().trim().max(200).optional(),
    description: z.string().trim().max(3000).optional(),
    planId: objectIdSchema.optional(),
    planItemIndex: z.number().int().min(0).optional(),
    needIds: z.array(objectIdSchema).default([]),
    departmentIds: z.array(objectIdSchema).default([]),
    costHalalas: z.number().int().min(0).optional(),
  })
  .refine((t) => t.endAt >= t.startAt, { message: 'تاريخ النهاية قبل البداية', path: ['endAt'] })
  .refine((t) => !!t.providerPartyId || !!t.providerName, { message: 'حدّد الجهة المقدمة', path: ['providerName'] });
export type CreateTrainingInput = z.infer<typeof createTrainingSchema>;
export const updateTrainingSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  providerName: z.string().trim().max(200).optional(),
  kind: z.enum(TRAINING_KINDS).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  location: z.string().trim().max(200).optional(),
  description: z.string().trim().max(3000).optional(),
  costHalalas: z.number().int().min(0).optional(),
  state: z.enum(TRAINING_STATES).optional(),
});

export const PARTICIPANT_STATUSES = ['nominated', 'registered', 'attended', 'completed', 'not_completed', 'withdrawn'] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];
export const PARTICIPANT_STATUS_AR: Record<ParticipantStatus, string> = {
  nominated: 'مرشَّح',
  registered: 'مسجَّل',
  attended: 'حضر',
  completed: 'أكمل',
  not_completed: 'لم يُكمل',
  withdrawn: 'انسحب',
};
export const nominateParticipantsSchema = z.object({ employeeIds: z.array(objectIdSchema).min(1).max(200) });
export const updateParticipantSchema = z.object({
  status: z.enum(PARTICIPANT_STATUSES).optional(),
  result: z.string().trim().max(500).optional(),
  /** «رفع الشهادات التدريبية» [HR §3.8.7] */
  certificateAttachmentId: objectIdSchema.optional(),
});

export const trainingPolicySchema = z.object({
  /** Who submits «الاحتياجات التدريبية لكل قسم» (Q12: department managers; HR always may). */
  needsSubmitters: z.array(z.string()).min(1),
  planApproverRole: z.string().min(1),
  /** Days before a course starts that participants are reminded. */
  reminderDaysBefore: z.number().int().min(0).max(30),
});
export type TrainingPolicy = z.infer<typeof trainingPolicySchema>;
export const DEFAULT_TRAINING_POLICY: TrainingPolicy = { needsSubmitters: ['department_manager'], planApproverRole: 'hr_manager', reminderDaysBefore: 1 };
