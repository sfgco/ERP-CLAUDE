import { Schema, model } from 'mongoose';
import {
  PARTICIPANT_STATUSES,
  TRAINING_KINDS,
  TRAINING_NEED_SOURCES,
  TRAINING_NEED_STATES,
  TRAINING_PLAN_STATES,
  TRAINING_STATES,
} from '@eayni/shared';

/** Training and development [HR §3.8]: plan, needs, courses, participants (and their certificates). */

const trainingPlanSchema = new Schema(
  {
    year: { type: Number, required: true, unique: true },
    state: { type: String, enum: TRAINING_PLAN_STATES, default: 'draft', index: true },
    items: {
      type: [
        new Schema(
          {
            title: String,
            departmentIds: [Schema.Types.ObjectId],
            quarter: Number,
            estimatedCostHalalas: Number,
            needIds: [Schema.Types.ObjectId],
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    notes: { type: String },
    version: { type: Number, default: 1 },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    returnReason: { type: String },
    closedAt: { type: Date },
    /** Read-only from Finance once the Finance module exists [HR §3.8, FIN §11]. */
    budgetHalalas: { type: Number },
  },
  { timestamps: true },
);
export const TrainingPlan = model('TrainingPlan', trainingPlanSchema);

const trainingNeedSchema = new Schema(
  {
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    year: { type: Number, required: true, index: true },
    title: { type: String, required: true },
    justification: { type: String },
    source: { type: String, enum: TRAINING_NEED_SOURCES, default: 'department' },
    appraisalId: { type: Schema.Types.ObjectId, ref: 'Appraisal' },
    employeeIds: { type: [Schema.Types.ObjectId], default: [] },
    priority: { type: String, default: 'medium' },
    state: { type: String, enum: TRAINING_NEED_STATES, default: 'new', index: true },
    stateNote: { type: String },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
export const TrainingNeed = model('TrainingNeed', trainingNeedSchema);

const trainingSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    providerPartyId: { type: Schema.Types.ObjectId, ref: 'Party' },
    providerName: { type: String },
    kind: { type: String, enum: TRAINING_KINDS, default: 'internal' },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true },
    location: { type: String },
    description: { type: String },
    planId: { type: Schema.Types.ObjectId, ref: 'TrainingPlan' },
    planItemIndex: { type: Number },
    needIds: { type: [Schema.Types.ObjectId], default: [] },
    departmentIds: { type: [Schema.Types.ObjectId], default: [] },
    costHalalas: { type: Number },
    calendarEventId: { type: Schema.Types.ObjectId, ref: 'CalendarEvent' },
    state: { type: String, enum: TRAINING_STATES, default: 'planned', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reminderSentAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
export const Training = model('Training', trainingSchema);
export type TrainingDoc = InstanceType<typeof Training>;

/** «حالة المشاركة والإكمال» per employee per course [HR §3.8.6–3.8.7]. */
const trainingParticipantSchema = new Schema(
  {
    trainingId: { type: Schema.Types.ObjectId, ref: 'Training', required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },
    status: { type: String, enum: PARTICIPANT_STATUSES, default: 'nominated', index: true },
    result: { type: String },
    certificateAttachmentId: { type: Schema.Types.ObjectId },
    certificateUploadedAt: { type: Date },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    nominatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    history: {
      type: [new Schema({ at: Date, status: String, byEmail: String, note: String }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true },
);
trainingParticipantSchema.index({ trainingId: 1, employeeId: 1 }, { unique: true });
trainingParticipantSchema.index({ employeeId: 1 });
export const TrainingParticipant = model('TrainingParticipant', trainingParticipantSchema);
