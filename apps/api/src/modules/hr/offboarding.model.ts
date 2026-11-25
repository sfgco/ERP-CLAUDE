import { Schema, model } from 'mongoose';
import { OFFBOARDING_STATES, OFFBOARDING_STEPS, SETTLEMENT_STATES } from '@eayni/shared';

/**
 * End of service [HR §3.10] — owned by `modules/hr` (HR_PLAN §3.7; docs/HR_H3B_LEGAL.md). One record per ending;
 * the four parallel steps after approval each carry their own done flag and actor; every move is in the stage log and
 * the append-only `offboardingEvents`.
 */
const lineSchema = new Schema(
  {
    code: { type: String, required: true },
    labelAr: { type: String, required: true },
    kind: { type: String, enum: ['earning', 'deduction'], required: true },
    amountHalalas: { type: Number, required: true },
    /** How the engine got the number (article, days, rates) — shown on the settlement screen (E11 «تفكيك الأجر»). */
    basisAr: { type: String },
    articleAr: { type: String },
    computed: { type: Boolean, default: true },
    editedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    editReason: { type: String },
    sourceType: { type: String },
    sourceId: { type: String },
  },
  { _id: false },
);

const offboardingSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', index: true },
    contractId: { type: Schema.Types.ObjectId, ref: 'Contract' },
    reason: { type: String, required: true, index: true },
    initiatedBy: { type: String, enum: ['employer', 'employee', 'law', 'mutual'], required: true },
    art80Case: { type: String },
    hearing: { heldAt: String, summary: String, attachmentIds: { type: [Schema.Types.ObjectId], default: [] }, employeeDeclined: Boolean },
    art81Case: { type: String },
    /** E14 (art. 87): the marriage / birth event behind the full award. */
    art87: { event: String, eventDate: String, attachmentId: Schema.Types.ObjectId, source: String, withinLimit: Boolean },
    medicalCertificateAttachmentId: { type: Schema.Types.ObjectId },
    writtenAgreementAttachmentId: { type: Schema.Types.ObjectId },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByRelation: { type: String },
    noticeDate: { type: String },
    lastWorkingDay: { type: String, required: true, index: true },
    details: { type: String },
    attachmentIds: { type: [Schema.Types.ObjectId], default: [] },
    /** E2 / E3: the legal minimum, the actual notice given and the shortfall that becomes a settlement line. */
    notice: { requiredDays: Number, givenDays: Number, shortfallDays: Number, basisAr: String },
    /** Legal checks run at creation / approval — warnings never block; blocks throw before the record exists. */
    legalWarnings: { type: [String], default: [] },
    /** E25 (art. 79 bis). */
    resignation: {
      submittedAt: Date,
      reason: String,
      requestedLastWorkingDay: String,
      withdrawDeadline: Date,
      deemedAcceptedAt: Date,
      postponedUntil: String,
      postponeReason: String,
      postponedBy: Schema.Types.ObjectId,
      acceptedAt: Date,
      acceptedBy: Schema.Types.ObjectId,
      acceptanceKind: String, // explicit | deemed | postponement_end
      withdrawnAt: Date,
      reminderSentAt: Date,
      managerRecommendation: { by: Schema.Types.ObjectId, at: Date, note: String },
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    // ---- the four parallel steps (HR_PLAN §4.8 rows 4–7)
    steps: {
      settlement: { done: Boolean, at: Date, by: Schema.Types.ObjectId },
      custody_return: { done: Boolean, at: Date, by: Schema.Types.ObjectId },
      it_closure: { done: Boolean, at: Date, by: Schema.Types.ObjectId },
      exit_interview: { done: Boolean, at: Date, by: Schema.Types.ObjectId },
    },
    /** Sensitive (HR_PLAN §6). */
    settlement: {
      state: { type: String, enum: SETTLEMENT_STATES, default: 'pending' },
      lines: { type: [lineSchema], default: [] },
      earningsHalalas: Number,
      deductionsHalalas: Number,
      netHalalas: Number,
      /** E11: the award wage and its breakdown (art. 2). */
      awardWage: { basicHalalas: Number, allowancesHalalas: Number, commissionsHalalas: Number, totalHalalas: Number, commissionsExcluded: Boolean, clauseRef: String, basisAr: String },
      serviceDays: Number,
      serviceYears: Number,
      awardFraction: Number, // E12 (art. 85) in basis points: 0 / 3333 / 6667 / 10000
      dueAt: Date, // E15 (art. 88)
      dueNotifiedAt: Date,
      overdueNotifiedAt: Date,
      computedAt: Date,
      computedBy: Schema.Types.ObjectId,
      approvedBy: Schema.Types.ObjectId,
      approvedAt: Date,
      sentToFinanceAt: Date,
      finance: { paidAt: Date, paidBy: Schema.Types.ObjectId, paymentRef: String, proofAttachmentId: Schema.Types.ObjectId, note: String },
      provisional: Boolean,
      flags: { type: [String], default: [] },
    },
    custodyChecklist: { type: [{ custodyId: Schema.Types.ObjectId, itemName: String, returnedAt: String, condition: String, notReturned: Boolean, chargeHalalas: Number, by: Schema.Types.ObjectId }], default: [] },
    it: { taskId: Schema.Types.ObjectId, requestedAt: Date, confirmedAt: Date, confirmedBy: Schema.Types.ObjectId, note: String, assetsReturned: Boolean },
    exitInterview: { templateVersion: Number, answers: { type: [{ key: String, value: Schema.Types.Mixed }], default: [] }, interviewerUserId: Schema.Types.ObjectId, at: String, declined: Boolean },
    experienceCertificate: { number: String, attachmentId: Schema.Types.ObjectId, issuedAt: Date, issuedBy: Schema.Types.ObjectId },
    gov: { gosiExitRef: String, gosiExitAt: String, qiwaExitRef: String, qiwaExitAt: String, finalExitRef: String, recordedBy: Schema.Types.ObjectId, at: Date, overdueNotifiedAt: Date },
    retention: { keepUntil: Date },
    completedAt: { type: Date },
    // workflow
    state: { type: String, enum: OFFBOARDING_STATES, required: true, index: true },
    stateEnteredAt: { type: Date, required: true },
    dueAt: { type: Date },
    closedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
offboardingSchema.index({ employeeId: 1, state: 1 });
export const Offboarding = model('Offboarding', offboardingSchema);
export type OffboardingDoc = InstanceType<typeof Offboarding>;
export const OFFBOARDING_STEP_KEYS = OFFBOARDING_STEPS;

/** Append-only step and decision log (golden rule 3). */
const offboardingEventSchema = new Schema(
  {
    offboardingId: { type: Schema.Types.ObjectId, ref: 'Offboarding', required: true, index: true },
    type: { type: String, required: true },
    fromState: { type: String },
    toState: { type: String },
    step: { type: String },
    note: { type: String },
    data: { type: Schema.Types.Mixed },
    actorUserId: { type: String },
    actorEmail: { type: String },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
export const OffboardingEvent = model('OffboardingEvent', offboardingEventSchema);
