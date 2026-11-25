import { z } from 'zod';
import { objectIdSchema, riyadhDaySchema } from './common';

/**
 * Performance [HR §3.7]: goals linked to department KPIs, semi-annual and annual appraisals on a configurable form,
 * improvement plans, warnings and administrative actions. Weights and scores are basis points (10 000 = 100 %).
 */

// ---------- goals («الأهداف الوظيفية لكل موظف») ----------
export const GOAL_STATES = ['draft', 'active', 'achieved', 'not_achieved', 'cancelled'] as const;
export type GoalState = (typeof GOAL_STATES)[number];
export const GOAL_STATE_AR: Record<GoalState, string> = {
  draft: 'مسودة',
  active: 'قائم',
  achieved: 'محقَّق',
  not_achieved: 'غير محقَّق',
  cancelled: 'ملغي',
};
export const createGoalSchema = z.object({
  employeeId: objectIdSchema,
  cycleId: objectIdSchema.optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
  /** Share of the employee's goals (the weights of one cycle should sum to 100 %). */
  weightBp: z.number().int().min(1).max(10_000),
  /** «ربط الأهداف بمؤشرات أداء القسم»: a code from the KPI registry (validated by the server). */
  kpiCode: z.string().trim().max(80).optional(),
  targetValue: z.number().optional(),
  unit: z.string().trim().max(40).optional(),
  dueDate: riyadhDaySchema.optional(),
});
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export const updateGoalSchema = createGoalSchema.omit({ employeeId: true }).partial().extend({
  state: z.enum(GOAL_STATES).optional(),
});
export const goalProgressSchema = z.object({
  percent: z.number().int().min(0).max(100),
  note: z.string().trim().max(1000).optional(),
});

// ---------- appraisal templates and cycles («تقييم الأداء نصف سنوي وسنوي») ----------
export const APPRAISAL_CYCLE_KINDS = ['semi_annual_1', 'semi_annual_2', 'annual'] as const;
export type AppraisalCycleKind = (typeof APPRAISAL_CYCLE_KINDS)[number];
export const APPRAISAL_CYCLE_KIND_AR: Record<AppraisalCycleKind, string> = {
  semi_annual_1: 'نصف سنوي (النصف الأول)',
  semi_annual_2: 'نصف سنوي (النصف الثاني)',
  annual: 'سنوي',
};
export const APPRAISAL_CYCLE_STATES = ['planned', 'open', 'closed'] as const;
export const APPRAISAL_CYCLE_STATE_AR: Record<(typeof APPRAISAL_CYCLE_STATES)[number], string> = {
  planned: 'مخطط',
  open: 'مفتوح',
  closed: 'مغلق',
};

export const appraisalCriterionSchema = z.object({
  key: z.string().trim().min(1).max(40),
  labelAr: z.string().trim().min(1).max(200),
  weightBp: z.number().int().min(0).max(10_000),
  /** `goals` and `tasks` criteria are pre-filled from the goals snapshot / tasks completion; `manual` is scored. */
  source: z.enum(['manual', 'goals', 'tasks']).default('manual'),
});
export const appraisalTemplateSchema = z.object({
  nameAr: z.string().trim().min(2).max(120),
  sections: z
    .array(
      z.object({
        titleAr: z.string().trim().min(1).max(120),
        weightBp: z.number().int().min(0).max(10_000),
        criteria: z.array(appraisalCriterionSchema).min(1).max(20),
      }),
    )
    .min(1)
    .max(10),
  /** Rating scale, e.g. 1–5 with labels. */
  scale: z.array(z.object({ value: z.number().int().min(0).max(10), labelAr: z.string().trim().min(1).max(60) })).min(2).max(11),
  /** Overall score (bp) under which an improvement plan is offered (Q11; not automatic). */
  improvementThresholdBp: z.number().int().min(0).max(10_000),
  active: z.boolean().default(true),
});
export type AppraisalTemplateInput = z.infer<typeof appraisalTemplateSchema>;

export const createAppraisalCycleSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  kind: z.enum(APPRAISAL_CYCLE_KINDS),
  from: riyadhDaySchema,
  to: riyadhDaySchema,
  opensAt: riyadhDaySchema,
  dueAt: riyadhDaySchema,
  templateId: objectIdSchema,
});
export type CreateAppraisalCycleInput = z.infer<typeof createAppraisalCycleSchema>;

export const APPRAISAL_STATES = ['open', 'manager_submitted', 'returned', 'approved', 'acknowledged', 'cancelled'] as const;
export type AppraisalState = (typeof APPRAISAL_STATES)[number];
export const APPRAISAL_STATE_AR: Record<AppraisalState, string> = {
  open: 'مفتوح',
  manager_submitted: 'بانتظار مراجعة الموارد البشرية',
  returned: 'أُعيد للمدير',
  approved: 'معتمد',
  acknowledged: 'تم إشعار الموظف',
  cancelled: 'ملغي',
};
export const scoreAppraisalSchema = z.object({
  scores: z
    .array(z.object({ key: z.string().trim().min(1).max(40), value: z.number().int().min(0).max(10), note: z.string().trim().max(500).optional() }))
    .min(1),
  /** «ملاحظات المدير المباشر» */
  managerNotes: z.string().trim().max(3000).optional(),
});
export const appraisalTransitionSchema = z.object({
  transition: z.enum(['submit', 'return', 'approve', 'acknowledge', 'cancel']),
  reason: z.string().trim().max(1000).optional(),
  hrNotes: z.string().trim().max(2000).optional(),
  employeeComment: z.string().trim().max(2000).optional(),
});
export const listAppraisalsQuerySchema = z.object({
  cycleId: objectIdSchema.optional(),
  employeeId: objectIdSchema.optional(),
  state: z.enum(APPRAISAL_STATES).optional(),
  /** mine = my own; team = the ones I score as direct manager; all = everything I may see. */
  view: z.enum(['mine', 'team', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// ---------- improvement plans («خطط تحسين الأداء») ----------
export const IMPROVEMENT_PLAN_STATES = ['active', 'completed', 'not_completed', 'cancelled'] as const;
export type ImprovementPlanState = (typeof IMPROVEMENT_PLAN_STATES)[number];
export const IMPROVEMENT_PLAN_STATE_AR: Record<ImprovementPlanState, string> = {
  active: 'قائمة',
  completed: 'مكتملة',
  not_completed: 'لم تُستكمل',
  cancelled: 'ملغاة',
};
export const createImprovementPlanSchema = z.object({
  employeeId: objectIdSchema,
  appraisalId: objectIdSchema.optional(),
  from: riyadhDaySchema,
  to: riyadhDaySchema,
  objectives: z
    .array(z.object({ text: z.string().trim().min(3).max(500), measure: z.string().trim().max(300).optional(), dueDate: riyadhDaySchema.optional() }))
    .min(1)
    .max(20),
});
export const improvementReviewSchema = z.object({
  note: z.string().trim().min(2).max(2000),
  rating: z.number().int().min(1).max(5).optional(),
  /** Mark objectives done by index. */
  objectivesDone: z.array(z.number().int().min(0)).optional(),
});
export const improvementCloseSchema = z.object({
  state: z.enum(['completed', 'not_completed', 'cancelled']),
  note: z.string().trim().min(2).max(2000),
});

// ---------- disciplinary actions («الإنذارات والإجراءات الإدارية») ----------
export const DISCIPLINARY_STATES = ['draft', 'pending_approval', 'approved', 'delivered', 'appealed', 'objection_window', 'court_objection', 'upheld', 'withdrawn'] as const;
export type DisciplinaryState = (typeof DISCIPLINARY_STATES)[number];
export const DISCIPLINARY_STATE_AR: Record<DisciplinaryState, string> = {
  draft: 'مسودة',
  pending_approval: 'بانتظار الاعتماد',
  approved: 'معتمد',
  delivered: 'تم إبلاغ الموظف',
  appealed: 'قيد التظلم',
  objection_window: 'مهلة الاعتراض أمام المحكمة',
  court_objection: 'اعتراض أمام المحكمة',
  upheld: 'مثبت',
  withdrawn: 'مسحوب',
};
export const DISCIPLINARY_EFFECTS = ['none', 'fine', 'suspension', 'termination'] as const;
/** Art. 71 (owner decision 2026-11-25): every penalty follows an investigation whose record is kept; oral questioning only for a warning or a fine ≤ one day's wage. */
export const INVESTIGATION_MODES = ['written', 'oral'] as const;
export type InvestigationMode = (typeof INVESTIGATION_MODES)[number];
export const INVESTIGATION_MODE_AR: Record<InvestigationMode, string> = { written: 'تحقيق كتابي', oral: 'استجواب شفهي' };
export const disciplineLadderStepSchema = z.object({
  code: z.string().trim().min(1).max(40),
  labelAr: z.string().trim().min(1).max(120),
  order: z.number().int().min(1).max(50),
  payrollEffect: z.enum(DISCIPLINARY_EFFECTS),
  /** For `fine`: the most days of wage this step may deduct for one violation (art. 70: ≤ 5; the policy's `maxFineDaysPerViolation` also applies). */
  maxFineDaysPerMonth: z.number().int().min(0).max(31).nullable(),
  /** For `suspension`: the most days (art. 70: ≤ 5). */
  maxSuspensionDays: z.number().int().min(0).max(31).nullable(),
  articleAr: z.string().trim().max(120).optional(),
});
export type DisciplineLadderStep = z.infer<typeof disciplineLadderStepSchema>;
export const disciplinePolicySchema = z.object({
  /** The warnings ladder — must match the approved لائحة تنظيم العمل (Q11, provisional). */
  ladder: z.array(disciplineLadderStepSchema).max(50),
  /**
   * Days the employee has to object after the written notice — art. 72 (owner decision 2026-11-24: 30 days, official
   * holidays excluded, counted from the delivery date); the penalty is confirmed when the window ends without an appeal.
   * An *employee* deadline: counted over the `holidays` collection and, when `employeeDeadlinesExcludeWeekend` is on, over the weekend too.
   */
  appealDays: z.number().int().min(1).max(90),
  /** Days the approver has to decide an appeal in writing (art. 72: 15) — an *employer* deadline, calendar days; the decision is a task with that deadline, escalated to the HR manager when it passes. */
  appealDecisionDays: z.number().int().min(1).max(90),
  /**
   * Owner decision 2026-11-25 (art. 72): after the appeal is rejected — or the decision window passes undecided, whichever
   * comes first — the penalty waits this many *employee* days for an objection before the labour court, then becomes final.
   */
  courtObjectionDays: z.number().int().min(1).max(120),
  /** Owner decision 2026-11-25: the employee's deadlines (appeal, court objection) skip Friday–Saturday as well as the official holidays. The employer's deadlines (arts. 71, 72 decision) stay calendar days. */
  employeeDeadlinesExcludeWeekend: z.boolean(),
  /** A penalty for a violation *discovered* more than N days ago is refused (art. 71: 30, from the discovery date). */
  violationDiscoveryDays: z.number().int().min(1).max(365),
  /** No penalty may be signed more than N days after the investigation ended and the violation was established (art. 71: 30). */
  investigationSignDays: z.number().int().min(1).max(365),
  /** A single violation's fine ≤ N days of wage, and the fines deducted in one month ≤ N days of wage (art. 70: 5); the excess rolls over. */
  maxFineDaysPerViolation: z.number().min(0).max(31),
  maxFineDaysPerMonth: z.number().min(0).max(31),
  /** Roles that may draft an action: the direct manager (relation) and HR. */
  issuers: z.array(z.string()).min(1),
  approverRole: z.string().min(1),
});
export type DisciplinePolicy = z.infer<typeof disciplinePolicySchema>;
export const DEFAULT_DISCIPLINE_POLICY: DisciplinePolicy = {
  ladder: [
    { code: 'written_notice', labelAr: 'تنبيه كتابي', order: 1, payrollEffect: 'none', maxFineDaysPerMonth: null, maxSuspensionDays: null, articleAr: 'المادة 66' },
    { code: 'warning_1', labelAr: 'إنذار أول', order: 2, payrollEffect: 'none', maxFineDaysPerMonth: null, maxSuspensionDays: null, articleAr: 'المادة 66' },
    { code: 'warning_2', labelAr: 'إنذار ثانٍ', order: 3, payrollEffect: 'none', maxFineDaysPerMonth: null, maxSuspensionDays: null, articleAr: 'المادة 66' },
    { code: 'final_warning', labelAr: 'إنذار نهائي', order: 4, payrollEffect: 'none', maxFineDaysPerMonth: null, maxSuspensionDays: null, articleAr: 'المادة 66' },
    { code: 'fine', labelAr: 'خصم من الأجر (حتى أجر 5 أيام للمخالفة الواحدة)', order: 5, payrollEffect: 'fine', maxFineDaysPerMonth: 5, maxSuspensionDays: null, articleAr: 'المادتان 66 و70' },
    { code: 'suspension', labelAr: 'إيقاف عن العمل مع الحرمان من الأجر (حتى 5 أيام)', order: 6, payrollEffect: 'suspension', maxFineDaysPerMonth: null, maxSuspensionDays: 5, articleAr: 'المادتان 66 و70' },
    { code: 'termination', labelAr: 'فصل من الخدمة', order: 7, payrollEffect: 'termination', maxFineDaysPerMonth: null, maxSuspensionDays: null, articleAr: 'المادتان 66 و80' },
  ],
  appealDays: 30,
  appealDecisionDays: 15,
  courtObjectionDays: 30,
  employeeDeadlinesExcludeWeekend: true,
  violationDiscoveryDays: 30,
  investigationSignDays: 30,
  maxFineDaysPerViolation: 5,
  maxFineDaysPerMonth: 5,
  issuers: ['direct_manager', 'hr_officer', 'hr_manager'],
  approverRole: 'hr_manager',
};
export const createDisciplinarySchema = z.object({
  employeeId: objectIdSchema,
  kind: z.string().trim().min(1).max(40),
  violationDate: riyadhDaySchema,
  /** When the employer learned of the violation (art. 71: the 30 days run from here, not from the violation). */
  discoveryDate: riyadhDaySchema,
  /** When the investigation ended and the violation was established (art. 71: the penalty must be signed within 30 days of it). Mandatory (owner decision 2026-11-25). */
  investigationEndDate: riyadhDaySchema,
  /** `oral` is accepted only for a warning (no payroll effect) or a fine of at most one day's wage; it is still documented in the record. */
  investigationMode: z.enum(INVESTIGATION_MODES).default('written'),
  /** محضر التحقيق: its text or an attachment — one of the two is required. */
  investigationRecordText: z.string().trim().max(5000).optional(),
  investigationRecordAttachmentIds: z.array(objectIdSchema).default([]),
  description: z.string().trim().min(5).max(3000),
  evidenceAttachmentIds: z.array(objectIdSchema).default([]),
  /** For a fine: the days of wage to deduct (≤ `maxFineDaysPerViolation`, art. 70). */
  fineDays: z.number().min(0).max(31).optional(),
  suspensionDays: z.number().int().min(0).max(31).optional(),
  /** One penalty per violation: a second action on the same employee and day is refused (409) unless it is declared a separate violation. */
  separateViolation: z.boolean().optional(),
});
export type CreateDisciplinaryInput = z.infer<typeof createDisciplinarySchema>;
export const disciplinaryTransitionSchema = z.object({
  transition: z.enum(['submit', 'approve', 'reject', 'deliver', 'acknowledge', 'appeal', 'uphold', 'reject_appeal', 'withdraw', 'court_objection', 'court_uphold', 'court_cancel', 'finalize']),
  note: z.string().trim().max(2000).optional(),
});

// ---------- appraisal settings (Q11) ----------
export const appraisalPolicySchema = z.object({
  /** Employees hired fewer than N days before the cycle end get no appraisal (Q11: 90). */
  minServiceDays: z.number().int().min(0).max(365),
  improvementPlanDays: z.number().int().min(7).max(365),
  /** The standing cycles: month-day of the window and of the opening / due dates (Q11 proposals). */
  cycles: z.array(
    z.object({
      kind: z.enum(APPRAISAL_CYCLE_KINDS),
      from: z.string().regex(/^\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{2}-\d{2}$/),
      opensAt: z.string().regex(/^\d{2}-\d{2}$/),
      dueAt: z.string().regex(/^\d{2}-\d{2}$/),
    }),
  ),
  /** Days before `dueAt` the manager is reminded. */
  dueReminderDays: z.number().int().min(0).max(60),
});
export type AppraisalPolicy = z.infer<typeof appraisalPolicySchema>;
export const DEFAULT_APPRAISAL_POLICY: AppraisalPolicy = {
  minServiceDays: 90,
  improvementPlanDays: 90,
  cycles: [
    { kind: 'semi_annual_1', from: '01-01', to: '06-30', opensAt: '07-01', dueAt: '07-31' },
    { kind: 'annual', from: '01-01', to: '12-31', opensAt: '01-01', dueAt: '01-31' },
  ],
  dueReminderDays: 7,
};
/** Template v1 (Q11): الأهداف 40 %, الكفاءات 40 %, المهام والالتزام 20 %; scale 1–5. */
export const DEFAULT_APPRAISAL_TEMPLATE: AppraisalTemplateInput = {
  nameAr: 'نموذج تقييم الأداء (الإصدار الأول)',
  sections: [
    { titleAr: 'الأهداف', weightBp: 4000, criteria: [{ key: 'goals', labelAr: 'تحقيق الأهداف الوظيفية', weightBp: 10_000, source: 'goals' }] },
    {
      titleAr: 'الكفاءات',
      weightBp: 4000,
      criteria: [
        { key: 'quality', labelAr: 'جودة العمل', weightBp: 2500, source: 'manual' },
        { key: 'teamwork', labelAr: 'العمل ضمن الفريق', weightBr: undefined as never, source: 'manual' } as never,
      ],
    },
    { titleAr: 'المهام والالتزام', weightBp: 2000, criteria: [{ key: 'tasks', labelAr: 'إنجاز المهام المسندة في وقتها', weightBp: 10_000, source: 'tasks' }] },
  ],
  scale: [
    { value: 1, labelAr: 'ضعيف' },
    { value: 2, labelAr: 'يحتاج تحسين' },
    { value: 3, labelAr: 'جيد' },
    { value: 4, labelAr: 'جيد جداً' },
    { value: 5, labelAr: 'ممتاز' },
  ],
  improvementThresholdBp: 5000,
  active: true,
};
// Fix the second competencies criterion (kept readable above): four manual competencies of 25 % each.
DEFAULT_APPRAISAL_TEMPLATE.sections[1].criteria = [
  { key: 'quality', labelAr: 'جودة العمل', weightBp: 2500, source: 'manual' },
  { key: 'teamwork', labelAr: 'العمل ضمن الفريق', weightBp: 2500, source: 'manual' },
  { key: 'initiative', labelAr: 'المبادرة وتحمل المسؤولية', weightBp: 2500, source: 'manual' },
  { key: 'communication', labelAr: 'التواصل والالتزام بالأنظمة', weightBp: 2500, source: 'manual' },
];
