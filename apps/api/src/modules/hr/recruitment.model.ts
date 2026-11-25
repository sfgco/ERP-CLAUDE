import { Schema, model } from 'mongoose';
import { APPLICANT_STAGES, INTERVIEW_MODES, INTERVIEW_RECOMMENDATIONS, INTERVIEW_STATES, OFFER_STATES, REQUISITION_STATES, WAGE_PERIODS } from '@eayni/shared';

/**
 * Recruitment [HR §3.2] — owned by `modules/hr` (HR_PLAN §3.6). Requisitions and offers are workflow records;
 * applicants move through stages with an append-only event log; interviews live here and on the shared calendar.
 */
const jobRequisitionSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    positionId: { type: Schema.Types.ObjectId, ref: 'Position' },
    titleAr: { type: String, required: true },
    headcount: { type: Number, required: true },
    hiredCount: { type: Number, default: 0 },
    justification: { type: String, required: true },
    requirements: { type: String },
    employmentType: { type: String, required: true },
    contractType: { type: String, required: true },
    durationMonths: { type: Number },
    /** Sensitive (HR_PLAN §6): hidden from department managers' colleagues and the system admin. */
    salaryRange: { minHalalas: Number, maxHalalas: Number },
    neededBy: { type: String },
    /** T12 (art. 40): recruitment cost items for a non-Saudi hire — read-only for Finance. */
    recruitmentCosts: { type: [{ labelAr: String, amountHalalas: Number }], default: [] },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The executive is required above the policy thresholds (Q10). */
    needsExecutive: { type: Boolean, default: false },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    posting: {
      channels: { type: [String], default: [] },
      postedAt: Date,
      closesAt: String,
      externalRefs: { type: [{ channel: String, reference: String }], default: [] },
    },
    /** T3: the Saudization warning computed when the requisition was submitted (never a block). */
    saudizationWarning: { type: String },
    // workflow
    state: { type: String, enum: REQUISITION_STATES, required: true, index: true },
    stateEnteredAt: { type: Date, required: true },
    dueAt: { type: Date },
    closedAt: { type: Date },
    flags: { type: [String], default: [] },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
jobRequisitionSchema.index({ departmentId: 1, state: 1 });
export const JobRequisition = model('JobRequisition', jobRequisitionSchema);
export type JobRequisitionDoc = InstanceType<typeof JobRequisition>;

const applicantSchema = new Schema(
  {
    requisitionId: { type: Schema.Types.ObjectId, ref: 'JobRequisition', required: true, index: true },
    fullNameAr: { type: String, required: true },
    phone: { type: String, required: true, index: true },
    email: { type: String, lowercase: true, index: true },
    nationality: { type: String, required: true },
    /** Encrypted at rest; last 4 in clear (HR_PLAN §3.6, EP §5.2). */
    identityNumberEnc: { type: String },
    identityLast4: { type: String },
    birthDate: { type: String },
    source: { type: String },
    cvAttachmentId: { type: Schema.Types.ObjectId },
    qualificationAr: { type: String },
    experienceYears: { type: Number },
    currentEmployer: { type: String },
    /** Sensitive. */
    expectedSalaryHalalas: { type: Number },
    stage: { type: String, enum: APPLICANT_STAGES, default: 'new', index: true },
    rejectionReason: { type: String },
    notes: { type: String },
    importedBatchId: { type: String },
    /** PDPL (Q10): CVs of rejected / withdrawn applicants are purged after `cvRetentionMonths`. */
    retainUntil: { type: Date, index: true },
    cvPurgedAt: { type: Date },
    linkedEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    /** T8 (art. 54): a previous employee of the cooperative — the probation rule applies at hire. */
    previousEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
applicantSchema.index({ requisitionId: 1, stage: 1 });
export const Applicant = model('Applicant', applicantSchema);
export type ApplicantDoc = InstanceType<typeof Applicant>;

/** Append-only (golden rule 3). */
const applicantEventSchema = new Schema(
  {
    applicantId: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true, index: true },
    type: { type: String, required: true },
    fromStage: { type: String },
    toStage: { type: String },
    note: { type: String },
    data: { type: Schema.Types.Mixed },
    actorUserId: { type: String },
    actorEmail: { type: String },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
export const ApplicantEvent = model('ApplicantEvent', applicantEventSchema);

const interviewSchema = new Schema(
  {
    applicantId: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true, index: true },
    requisitionId: { type: Schema.Types.ObjectId, ref: 'JobRequisition', required: true, index: true },
    round: { type: Number, required: true },
    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, default: 60 },
    mode: { type: String, enum: INTERVIEW_MODES, required: true },
    location: { type: String },
    panelUserIds: { type: [Schema.Types.ObjectId], default: [] },
    calendarEventId: { type: Schema.Types.ObjectId, ref: 'CalendarEvent' },
    state: { type: String, enum: INTERVIEW_STATES, default: 'scheduled', index: true },
    /** Q10: criteria scored 1–5 (the criteria list and the scale are settings). */
    scores: { type: [{ criterion: String, value: Number }], default: [] },
    totalScore: { type: Number },
    recommendation: { type: String, enum: INTERVIEW_RECOMMENDATIONS },
    notes: { type: String },
    resultBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resultAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
interviewSchema.index({ applicantId: 1, round: 1 });
export const Interview = model('Interview', interviewSchema);
export type InterviewDoc = InstanceType<typeof Interview>;

const offerSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    applicantId: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true, index: true },
    requisitionId: { type: Schema.Types.ObjectId, ref: 'JobRequisition', required: true, index: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    positionId: { type: Schema.Types.ObjectId, ref: 'Position' },
    directManagerId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    employmentType: { type: String, required: true },
    contractType: { type: String, required: true },
    durationMonths: { type: Number },
    workDescription: { type: String },
    probationDays: { type: Number, default: 0 },
    wagePeriod: { type: String, enum: WAGE_PERIODS, default: 'monthly' },
    /** Sensitive (default deny). */
    basicSalaryHalalas: { type: Number, required: true },
    allowances: { type: [{ type: { type: String }, amountHalalas: Number }], default: [] },
    renewalClause: { enabled: { type: Boolean, default: false }, periodMonths: Number },
    awardExcludesVariableWage: { type: Boolean, default: false },
    awardExclusionClauseRef: { type: String },
    nonCompete: { months: Number, scopeAr: String },
    workPermit: { number: String, professionAr: String, expiryDate: String },
    startDate: { type: String, required: true },
    validUntil: { type: String, required: true },
    notes: { type: String },
    /** Q10: executive approval needed above the position's salary range / policy threshold. */
    needsExecutive: { type: Boolean, default: false },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    sentAt: { type: Date },
    response: { at: Date, accepted: Boolean, note: String, signedAttachmentId: Schema.Types.ObjectId },
    createdEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    createdContractId: { type: Schema.Types.ObjectId, ref: 'Contract' },
    /** T13 (by hand until phase 7). */
    govRegistration: { qiwaRef: String, qiwaAt: String, gosiRef: String, gosiAt: String, recordedBy: Schema.Types.ObjectId, at: Date },
    govOverdueNotifiedAt: { type: Date },
    /** T2 / T3 / T6 / T8 warnings computed at creation and at hire (never blocks except the legal minimums). */
    flags: { type: [String], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // workflow
    state: { type: String, enum: OFFER_STATES, required: true, index: true },
    stateEnteredAt: { type: Date, required: true },
    dueAt: { type: Date },
    closedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
export const Offer = model('Offer', offerSchema);
export type OfferDoc = InstanceType<typeof Offer>;
