import { Schema, model } from 'mongoose';
import {
  APPRAISAL_CYCLE_KINDS,
  APPRAISAL_CYCLE_STATES,
  APPRAISAL_STATES,
  DISCIPLINARY_STATES,
  GOAL_STATES,
  IMPROVEMENT_PLAN_STATES,
} from '@eayni/shared';

/** Performance [HR §3.7] — goals, appraisal templates and cycles, appraisals, improvement plans, disciplinary actions. */

const goalSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    cycleId: { type: Schema.Types.ObjectId, ref: 'AppraisalCycle', index: true },
    title: { type: String, required: true },
    description: { type: String },
    weightBp: { type: Number, required: true },
    /** A code from the KPI registry: the goal is tied to a department KPI [HR §3.7]. */
    kpiCode: { type: String, index: true },
    kpiNameAr: { type: String },
    targetValue: { type: Number },
    unit: { type: String },
    dueDate: { type: String },
    state: { type: String, enum: GOAL_STATES, default: 'active', index: true },
    percent: { type: Number, default: 0 },
    /** Append-only progress entries [HR §3.7 «متابعة نسبة الإنجاز»]. */
    progress: {
      type: [
        new Schema(
          { at: Date, percent: Number, note: String, byUserId: Schema.Types.ObjectId, byEmail: String },
          { _id: false },
        ),
      ],
      default: [],
    },
    setBy: { type: Schema.Types.ObjectId, ref: 'User' },
    agreedByEmployeeAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
export const Goal = model('Goal', goalSchema);
export type GoalDoc = InstanceType<typeof Goal>;

const appraisalTemplateSchema = new Schema(
  {
    nameAr: { type: String, required: true },
    version: { type: Number, default: 1 },
    sections: { type: Schema.Types.Mixed, required: true },
    scale: { type: Schema.Types.Mixed, required: true },
    improvementThresholdBp: { type: Number, required: true },
    active: { type: Boolean, default: true },
    createdBy: { type: String },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
export const AppraisalTemplate = model('AppraisalTemplate', appraisalTemplateSchema);

const appraisalCycleSchema = new Schema(
  {
    year: { type: Number, required: true },
    kind: { type: String, enum: APPRAISAL_CYCLE_KINDS, required: true },
    nameAr: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    opensAt: { type: String, required: true },
    dueAt: { type: String, required: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'AppraisalTemplate', required: true },
    /** Snapshot of the template at opening so a later template change never changes an open cycle. */
    templateSnapshot: { type: Schema.Types.Mixed },
    state: { type: String, enum: APPRAISAL_CYCLE_STATES, default: 'planned', index: true },
    openedAt: { type: Date },
    closedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
appraisalCycleSchema.index({ year: 1, kind: 1 }, { unique: true });
export const AppraisalCycle = model('AppraisalCycle', appraisalCycleSchema);
export type AppraisalCycleDoc = InstanceType<typeof AppraisalCycle>;

const appraisalSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    cycleId: { type: Schema.Types.ObjectId, ref: 'AppraisalCycle', required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', index: true },
    /** Direct manager at opening (user id); the manager-change handler moves it (DECISIONS §11.4). */
    managerUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    state: { type: String, enum: APPRAISAL_STATES, default: 'open', index: true },
    stateEnteredAt: { type: Date, required: true },
    dueAt: { type: Date },
    closedAt: { type: Date },
    goalsSnapshot: { type: Schema.Types.Mixed },
    tasksCompletion: { assigned: Number, done: Number, late: Number, percentBp: Number },
    scores: { type: [new Schema({ key: String, value: Number, note: String }, { _id: false })], default: [] },
    overallScoreBp: { type: Number },
    overallRatingLabel: { type: String },
    managerNotes: { type: String },
    employeeComment: { type: String },
    hrNotes: { type: String },
    submittedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    acknowledgedAt: { type: Date },
    improvementPlanId: { type: Schema.Types.ObjectId, ref: 'ImprovementPlan' },
    dueReminderSentAt: { type: Date },
  },
  { timestamps: true },
);
appraisalSchema.index({ employeeId: 1, cycleId: 1 }, { unique: true });
appraisalSchema.index({ cycleId: 1, state: 1 });
export const Appraisal = model('Appraisal', appraisalSchema);
export type AppraisalDoc = InstanceType<typeof Appraisal>;

/** Append-only history of an appraisal / a disciplinary action / a goal (golden rule 3). */
const performanceEventSchema = new Schema(
  {
    recordType: { type: String, required: true, index: true },
    recordId: { type: Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, required: true },
    fromState: String,
    toState: String,
    note: String,
    changes: Schema.Types.Mixed,
    actorUserId: String,
    actorEmail: String,
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
export const PerformanceEvent = model('PerformanceEvent', performanceEventSchema);

const improvementPlanSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    appraisalId: { type: Schema.Types.ObjectId, ref: 'Appraisal' },
    from: { type: String, required: true },
    to: { type: String, required: true },
    objectives: {
      type: [new Schema({ text: String, measure: String, dueDate: String, done: { type: Boolean, default: false } }, { _id: false })],
      default: [],
    },
    /** Append-only reviews [HR §3.7 «متابعة خطط تحسين الأداء»]. */
    reviews: {
      type: [new Schema({ at: Date, byUserId: Schema.Types.ObjectId, byEmail: String, note: String, rating: Number }, { _id: false })],
      default: [],
    },
    state: { type: String, enum: IMPROVEMENT_PLAN_STATES, default: 'active', index: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    hrFollowerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    closingNote: { type: String },
    closedAt: { type: Date },
    reviewReminderSentOn: { type: String },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
  },
  { timestamps: true },
);
export const ImprovementPlan = model('ImprovementPlan', improvementPlanSchema);

const disciplinaryActionSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },
    kind: { type: String, required: true },
    kindLabelAr: { type: String, required: true },
    payrollEffect: { type: String, default: 'none' },
    fineDays: { type: Number },
    fineHalalas: { type: Number },
    suspensionDays: { type: Number },
    violationDate: { type: String, required: true },
    /** Art. 71 (owner decision 2026-11-24): the 30 days run from the discovery, and the penalty is signed within 30 days of the investigation's end. */
    discoveryDate: { type: String },
    investigationEndDate: { type: String },
    separateViolation: { type: Boolean },
    description: { type: String, required: true },
    evidenceAttachmentIds: { type: [Schema.Types.ObjectId], default: [] },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    issuedByRelation: { type: String },
    state: { type: String, enum: DISCIPLINARY_STATES, default: 'draft', index: true },
    stateEnteredAt: { type: Date, required: true },
    dueAt: { type: Date },
    closedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    deliveredAt: { type: Date },
    deliveredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    appealDeadline: { type: Date },
    /** Art. 72: the written decision on an appeal is due within `appealDecisionDays`; `appealTaskId` is the approver's task. */
    appealDecisionDueAt: { type: Date },
    appealTaskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    employeeAck: { at: Date, note: String },
    appeal: { at: Date, note: String, outcome: String, decidedBy: Schema.Types.ObjectId, decidedAt: Date, decisionNote: String },
    payrollAdjustmentId: { type: Schema.Types.ObjectId, ref: 'PayrollAdjustment' },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
disciplinaryActionSchema.index({ employeeId: 1, violationDate: -1 });
export const DisciplinaryAction = model('DisciplinaryAction', disciplinaryActionSchema);
export type DisciplinaryActionDoc = InstanceType<typeof DisciplinaryAction>;
