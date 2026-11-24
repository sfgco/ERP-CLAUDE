import { Schema, model } from 'mongoose';
import {
  ATTENDANCE_DAY_STATUSES,
  EXCEPTION_SCOPES,
  LEAVE_ENTRY_TYPES,
  LEAVE_TYPES,
  LOCATION_ERRORS,
  PUNCH_SOURCES,
  PUNCH_TYPES,
  SHIFT_KINDS,
} from '@eayni/shared';

/**
 * Attendance [HR §3.4] — owned by `modules/hr` (golden rule 2).
 * Punches, exceptions, assignment rows and the leave ledger are append-only (golden rule 3); the computed day is a
 * recomputable cache of them (HR_PLAN §10.2) until a payroll run locks it (H3a).
 */

const periodSchema = new Schema(
  {
    start: { type: String, required: true },
    end: { type: String, required: true },
    crossesMidnight: { type: Boolean, default: false },
  },
  { _id: false },
);

/** «فترات الدوام» [HR §3.4 أولاً 1–3, 6–7]. A change writes a `ShiftVersion` row and bumps `version`. */
const shiftSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    nameAr: { type: String, required: true },
    kind: { type: String, enum: SHIFT_KINDS, default: 'fixed' },
    periods: { type: [periodSchema], required: true },
    ramadanPeriods: { type: [periodSchema], default: [] },
    workDays: { type: [Number], default: [0, 1, 2, 3, 4] },
    graceMinutes: { type: Number },
    active: { type: Boolean, default: true },
    notes: { type: String },
    version: { type: Number, default: 1 },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
export const Shift = model('Shift', shiftSchema);
export type ShiftDoc = InstanceType<typeof Shift>;

const shiftVersionSchema = new Schema(
  {
    shiftId: { type: Schema.Types.ObjectId, ref: 'Shift', required: true, index: true },
    version: { type: Number, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    changedBy: { type: String },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
export const ShiftVersion = model('ShiftVersion', shiftVersionSchema);

/**
 * «إسناد الموظفين إلى فترات العمل» and «ربط الموظفين بفروعهم ومواقع تشغيلهم» [HR §3.4 أولاً 4–5]. The history is the
 * collection itself: a new row closes the previous one (`toDay`) — the only update the collection ever sees.
 */
const shiftAssignmentSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    shiftId: { type: Schema.Types.ObjectId, ref: 'Shift', required: true, index: true },
    siteIds: { type: [Schema.Types.ObjectId], default: [] },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    /** Riyadh days, inclusive; `toDay` null = current. */
    fromDay: { type: String, required: true },
    toDay: { type: String, default: null },
    reason: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
shiftAssignmentSchema.index({ employeeId: 1, fromDay: -1 });
shiftAssignmentSchema.index({ shiftId: 1, toDay: 1 });
export const ShiftAssignment = model('ShiftAssignment', shiftAssignmentSchema);

/**
 * One check-in / check-out [HR §3.4 ثانياً 1, 7]: server time, the matched site and distance, and the location the
 * browser reported. Never updated or deleted; a correction inserts a new punch that `supersedes` the wrong one.
 */
const punchSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    type: { type: String, enum: PUNCH_TYPES, required: true },
    at: { type: Date, required: true },
    /** Riyadh day the punch belongs to (a night shift's check-out after midnight belongs to the shift's day). */
    day: { type: String, required: true },
    location: { lat: Number, lng: Number, accuracyM: Number },
    locationError: { type: String, enum: LOCATION_ERRORS },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    distanceM: { type: Number },
    radiusM: { type: Number },
    /** null = no site with coordinates to check against. */
    withinGeofence: { type: Boolean, default: null },
    exceptionId: { type: Schema.Types.ObjectId, ref: 'AttendanceException' },
    source: { type: String, enum: PUNCH_SOURCES, required: true },
    correctionRequestId: { type: Schema.Types.ObjectId, ref: 'HrRequest' },
    /** For `wrong_time` corrections: the punch this one replaces in the computation (the old row stays). */
    supersedesPunchId: { type: Schema.Types.ObjectId, ref: 'AttendancePunch' },
    idempotencyKey: { type: String },
    /** Who recorded it when not the employee (HR manual punch, Q17). */
    byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String },
    flags: { type: [String], default: [] },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
punchSchema.index({ employeeId: 1, at: -1 });
punchSchema.index({ employeeId: 1, day: 1 });
// Partial (not sparse): a compound sparse index would still index rows without a key through `employeeId`.
punchSchema.index(
  { employeeId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } },
);
punchSchema.index({ day: 1 });
export const AttendancePunch = model('AttendancePunch', punchSchema);
export type AttendancePunchDoc = InstanceType<typeof AttendancePunch>;

/**
 * The computed day [HR §3.4 رابعاً]: lateness, absence, hours and overtime derived from the punches, the schedule,
 * approved leave / permission / remote work, exceptions and holidays. Recomputed on every relevant change until a
 * payroll run locks it (`lockedByPayrollRunId`, H3a).
 */
const attendanceDaySchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    day: { type: String, required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', index: true },
    shiftId: { type: Schema.Types.ObjectId, ref: 'Shift' },
    /** A working day per the schedule (not weekend / holiday / unscheduled). */
    scheduled: { type: Boolean, default: false },
    expectedStart: { type: Date },
    expectedEnd: { type: Date },
    firstInAt: { type: Date },
    lastOutAt: { type: Date },
    status: { type: String, enum: ATTENDANCE_DAY_STATUSES, required: true, index: true },
    lateMinutes: { type: Number, default: 0 },
    earlyLeaveMinutes: { type: Number, default: 0 },
    workedMinutes: { type: Number, default: 0 },
    overtimeMinutes: { type: Number, default: 0 },
    overtimeApprovedMinutes: { type: Number, default: 0 },
    permissionMinutes: { type: Number, default: 0 },
    punchCount: { type: Number, default: 0 },
    leaveRequestId: { type: Schema.Types.ObjectId, ref: 'HrRequest' },
    leaveType: { type: String },
    exceptionId: { type: Schema.Types.ObjectId, ref: 'AttendanceException' },
    overtimeRequestId: { type: Schema.Types.ObjectId, ref: 'HrRequest' },
    flags: { type: [String], default: [] },
    /** The day is over: its status will not change by itself any more (only by a correction). */
    final: { type: Boolean, default: false },
    alerts: { missedIn: Date, missedOut: Date },
    computedAt: { type: Date, required: true },
    version: { type: Number, default: 1 },
    lockedByPayrollRunId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);
attendanceDaySchema.index({ employeeId: 1, day: 1 }, { unique: true });
attendanceDaySchema.index({ day: 1, status: 1 });
export const AttendanceDay = model('AttendanceDay', attendanceDaySchema);
export type AttendanceDayDoc = InstanceType<typeof AttendanceDay>;

/** An approved «استثناء» [HR §3.4 ثانياً 6]: written when a geofence-exception or remote-work request is approved. */
const attendanceExceptionSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    fromDay: { type: String, required: true },
    toDay: { type: String, required: true },
    scope: { type: String, enum: EXCEPTION_SCOPES, required: true },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    requestId: { type: Schema.Types.ObjectId, ref: 'HrRequest', index: true },
    requestType: { type: String },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
attendanceExceptionSchema.index({ employeeId: 1, fromDay: 1, toDay: 1 });
export const AttendanceException = model('AttendanceException', attendanceExceptionSchema);

/**
 * Leave ledger [HR §3.5.1, Q7]: every balance movement is a signed row; the balance is the sum. Append-only; the
 * `(employeeId, leaveType, refType, refId)` key makes accruals and approvals idempotent.
 */
const leaveLedgerSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveType: { type: String, enum: LEAVE_TYPES, required: true },
    entryType: { type: String, enum: LEAVE_ENTRY_TYPES, required: true },
    days: { type: Number, required: true },
    year: { type: Number, required: true },
    effectiveAt: { type: Date, required: true },
    refType: { type: String },
    refId: { type: String },
    note: { type: String },
    actorUserId: { type: String },
    actorEmail: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
leaveLedgerSchema.index({ employeeId: 1, leaveType: 1, year: 1 });
leaveLedgerSchema.index({ employeeId: 1, leaveType: 1, refType: 1, refId: 1 }, { unique: true, sparse: true });
export const LeaveLedger = model('LeaveLedger', leaveLedgerSchema);
