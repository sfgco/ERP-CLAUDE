import { Schema, model } from 'mongoose';
import { PAYROLL_RUN_STATES } from '@eayni/shared';

/**
 * Payroll [HR §3.6] — owned by `modules/hr`. A run is frozen after HR approval (only the Finance stage fields and the
 * close move afterwards); payslips are snapshots; adjustments and advance schedules are append-only (HR_PLAN §3.3).
 */
const payrollRunSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    period: { type: String, required: true, index: true },
    cutoff: { attendanceFrom: String, attendanceTo: String },
    state: { type: String, enum: PAYROLL_RUN_STATES, required: true, index: true },
    stateEnteredAt: { type: Date, required: true },
    dueAt: { type: Date },
    closedAt: { type: Date },
    preparedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    preparedAt: { type: Date },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    /** The thin Finance stage [FIN §5, §12]: decision, who, when; payment recorded by someone else. */
    finance: {
      decision: { type: String },
      by: { type: Schema.Types.ObjectId, ref: 'User' },
      at: { type: Date },
      note: { type: String },
      paidAt: { type: Date },
      paidBy: { type: Schema.Types.ObjectId, ref: 'User' },
      paymentRef: { type: String },
      proofAttachmentId: { type: Schema.Types.ObjectId },
    },
    totals: {
      employeeCount: { type: Number, default: 0 },
      grossHalalas: { type: Number, default: 0 },
      deductionsHalalas: { type: Number, default: 0 },
      netHalalas: { type: Number, default: 0 },
      gosiEmployeeHalalas: { type: Number, default: 0 },
      gosiEmployerHalalas: { type: Number, default: 0 },
      overtimeHalalas: { type: Number, default: 0 },
    },
    /** Policy snapshot used to compute the run (so a later policy change never changes a frozen run's meaning). */
    policySnapshot: { type: Schema.Types.Mixed },
    frozenAt: { type: Date },
    payslipsVisibleAt: { type: Date },
    notes: { type: String },
    /** Flags for the reviewer: employees without a salary, provisional policies used, capped deductions… */
    flags: { type: [String], default: [] },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
payrollRunSchema.index({ period: 1 }, { unique: true, partialFilterExpression: { state: { $ne: 'cancelled' } } });
export const PayrollRun = model('PayrollRun', payrollRunSchema);
export type PayrollRunDoc = InstanceType<typeof PayrollRun>;

const lineSchema = new Schema(
  {
    code: { type: String, required: true },
    labelAr: { type: String, required: true },
    amountHalalas: { type: Number, required: true },
    days: { type: Number },
    minutes: { type: Number },
    rateBp: { type: Number },
    sourceType: { type: String },
    sourceId: { type: String },
    note: { type: String },
  },
  { _id: false },
);

/** One payslip per employee per run — a snapshot of the salary master and the attendance of the window. */
const payslipSchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, ref: 'PayrollRun', required: true },
    period: { type: String, required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeNumber: { type: String, required: true },
    fullNameAr: { type: String, required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    nationality: { type: String },
    gosiGroup: { type: String },
    basicHalalas: { type: Number, required: true },
    earnings: { type: [lineSchema], default: [] },
    deductions: { type: [lineSchema], default: [] },
    grossHalalas: { type: Number, required: true },
    deductionsHalalas: { type: Number, required: true },
    netHalalas: { type: Number, required: true },
    gosiWageHalalas: { type: Number },
    gosiEmployeeHalalas: { type: Number, default: 0 },
    gosiEmployerHalalas: { type: Number, default: 0 },
    attendance: {
      scheduledDays: Number,
      presentDays: Number,
      absentDays: Number,
      lateMinutes: Number,
      overtimeApprovedMinutes: Number,
      leaveDays: Number,
      unpaidLeaveDays: Number,
      missingPunchDays: Number,
    },
    bankName: { type: String },
    bankLast4: { type: String },
    flags: { type: [String], default: [] },
    visibleToEmployeeAt: { type: Date },
    viewedByEmployeeAt: { type: Date },
  },
  { timestamps: true },
);
payslipSchema.index({ runId: 1, employeeId: 1 }, { unique: true });
payslipSchema.index({ employeeId: 1, period: -1 });
export const Payslip = model('Payslip', payslipSchema);
export type PayslipDoc = InstanceType<typeof Payslip>;

/** «التعديل يدخل في المسير التالي» — append-only; `consumedByRunId` is set once by the run that took it. */
const payrollAdjustmentSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    kind: { type: String, enum: ['earning', 'deduction'], required: true },
    amountHalalas: { type: Number, required: true },
    reason: { type: String, required: true },
    sourceType: { type: String },
    sourceId: { type: String },
    sourceRunId: { type: Schema.Types.ObjectId, ref: 'PayrollRun' },
    consumedByRunId: { type: Schema.Types.ObjectId, ref: 'PayrollRun', index: true },
    consumedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByEmail: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
payrollAdjustmentSchema.index({ employeeId: 1, consumedByRunId: 1 });
export const PayrollAdjustment = model('PayrollAdjustment', payrollAdjustmentSchema);

/** Instalments of an approved advance (`hrRequests` type advance), consumed one per period by payroll. */
const advanceScheduleSchema = new Schema(
  {
    requestId: { type: Schema.Types.ObjectId, ref: 'HrRequest', required: true, unique: true },
    requestNumber: { type: String },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    totalHalalas: { type: Number, required: true },
    instalments: {
      type: [
        new Schema(
          {
            period: { type: String, required: true },
            amountHalalas: { type: Number, required: true },
            payslipId: { type: Schema.Types.ObjectId, ref: 'Payslip' },
            runId: { type: Schema.Types.ObjectId, ref: 'PayrollRun' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);
export const AdvanceSchedule = model('AdvanceSchedule', advanceScheduleSchema);
