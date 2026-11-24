import type { ClientSession, FilterQuery } from 'mongoose';
import {
  TIMEZONE,
  type AttendanceDayStatus,
  type AttendanceRules,
  type GeoPoint,
  type LocationPolicy,
  type ManualPunchInput,
  type OvertimePolicy,
  type PunchInput,
  type PunchType,
  type ShiftPeriod,
} from '@eayni/shared';
import { badRequest, forbidden, notFound } from '../../core/http/errors';
import { SYSTEM_ACTOR, type Actor } from '../../core/http/context';
import { recordAudit } from '../../core/audit/service';
import { notify } from '../../core/notifications/service';
import { publish } from '../../core/outbox/service';
import { getSetting } from '../../core/settings/service';
import { loadHolidaySet, riyadhDate, riyadhWeekday } from '../../core/dates/businessDays';
import { Site } from '../../core/org/model';
import { Employee, type EmployeeDoc } from './model';
import { HrRequest } from './requests.model';
import {
  AttendanceDay,
  AttendanceException,
  AttendancePunch,
  Shift,
  ShiftAssignment,
  type AttendanceDayDoc,
  type AttendancePunchDoc,
  type ShiftDoc,
} from './attendance.model';
import { ON_DUTY_STATUSES } from './service';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

// ---------- Riyadh day / time helpers ----------
/** Instant of `HH:MM` on a Riyadh calendar day (`plusDays` shifts the day, for periods crossing midnight). */
export function dayTime(day: string, hhmm: string, plusDays = 0): Date {
  const base = new Date(`${day}T${hhmm}:00+03:00`);
  return plusDays ? new Date(base.getTime() + plusDays * DAY_MS) : base;
}
/** `YYYY-MM-DD` ± n days (pure calendar arithmetic). */
export function addDays(day: string, n: number): string {
  return riyadhDate(new Date(dayTime(day, '12:00').getTime() + n * DAY_MS));
}
export const weekdayOf = (day: string): number => riyadhWeekday(dayTime(day, '12:00'));
/** Every Riyadh day from `from` to `to` inclusive (capped so a bad range cannot loop for years). */
export function daysBetween(from: string, to: string, cap = 400): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
}
const hijriMonthFmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
  timeZone: TIMEZONE,
  month: 'numeric',
});
/** Ramadan is the ninth Hijri month (Umm al-Qura) — the shift's Ramadan periods apply (Q1). */
export function isRamadan(day: string): boolean {
  return hijriMonthFmt.format(dayTime(day, '12:00')) === '9';
}
const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MIN_MS);

// ---------- geofence ----------
/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

interface SiteLite {
  _id: unknown;
  nameAr: string;
  location?: { coordinates?: number[] } | null;
  geofenceRadiusM?: number | null;
}
export interface LocationVerdict {
  reason: 'ok' | 'outside' | 'no_location' | 'inaccurate' | 'no_site';
  siteId?: string;
  siteName?: string;
  distanceM?: number;
  radiusM?: number;
  within: boolean | null;
}
/** Nearest allowed site and whether the fix is inside its fence [HR §3.4 ثانياً 2–3]. */
export function evaluateLocation(
  location: GeoPoint | null | undefined,
  sites: SiteLite[],
  policy: LocationPolicy,
  defaultRadiusM: number,
): LocationVerdict {
  const fenced = sites.filter((s) => s.location?.coordinates?.length === 2);
  if (!fenced.length) return { reason: 'no_site', within: null };
  if (!location) return { reason: 'no_location', within: false };
  let best: LocationVerdict | undefined;
  for (const s of fenced) {
    const [lng, lat] = s.location!.coordinates!;
    const d = distanceM(location, { lat, lng });
    const radius = s.geofenceRadiusM ?? defaultRadiusM;
    if (!best || d < best.distanceM!)
      best = { reason: 'outside', siteId: String(s._id), siteName: s.nameAr, distanceM: d, radiusM: radius, within: false };
  }
  const b = best!;
  if (typeof location.accuracyM === 'number' && location.accuracyM > b.radiusM! * policy.maxAccuracyFactor)
    return { ...b, reason: 'inaccurate', within: false };
  if (b.distanceM! <= b.radiusM!) return { ...b, reason: 'ok', within: true };
  return b;
}

// ---------- schedule ----------
export interface Schedule {
  shift: ShiftDoc | null;
  assignmentId?: string;
  siteIds: string[];
  branchId?: string;
  /** The day is a working day of the shift (weekday in `workDays`). Holidays are checked by the caller. */
  isWorkDay: boolean;
  /** Expected start / end for the day (null when not a working day or no shift). */
  window: { start: Date; end: Date; periods: ShiftPeriod[] } | null;
  graceMinutes: number | null;
}

export async function defaultShift(): Promise<ShiftDoc | null> {
  const code = await getSetting('hr.attendance.defaultShiftCode');
  if (!code) return null;
  return Shift.findOne({ code, deletedAt: null, active: true });
}

/** The schedule in force for an employee on a Riyadh day: the assignment row covering it, else the default shift. */
export async function scheduleFor(employee: EmployeeDoc, day: string): Promise<Schedule> {
  const assignment = await ShiftAssignment.findOne({
    employeeId: employee._id,
    fromDay: { $lte: day },
    $or: [{ toDay: null }, { toDay: { $gte: day } }],
  })
    .sort({ fromDay: -1 })
    .lean();
  const shift = assignment
    ? await Shift.findOne({ _id: assignment.shiftId, deletedAt: null })
    : await defaultShift();
  const siteIds = assignment?.siteIds?.length
    ? assignment.siteIds.map(String)
    : employee.siteId
      ? [String(employee.siteId)]
      : [];
  if (!shift) return { shift: null, siteIds, isWorkDay: false, window: null, graceMinutes: null };
  const isWorkDay = shift.workDays.includes(weekdayOf(day));
  const periods = (isRamadan(day) && shift.ramadanPeriods.length ? shift.ramadanPeriods : shift.periods) as ShiftPeriod[];
  const first = periods[0];
  const last = periods[periods.length - 1];
  return {
    shift,
    assignmentId: assignment ? String(assignment._id) : undefined,
    siteIds,
    branchId: assignment?.branchId ? String(assignment.branchId) : employee.branchId ? String(employee.branchId) : undefined,
    isWorkDay,
    window: isWorkDay
      ? { start: dayTime(day, first.start), end: dayTime(day, last.end, last.crossesMidnight ? 1 : 0), periods }
      : null,
    graceMinutes: shift.graceMinutes ?? null,
  };
}

/** The Riyadh day a punch belongs to: after midnight inside a night shift it is still the previous day's shift. */
export async function attendanceDayOf(employee: EmployeeDoc, at: Date): Promise<string> {
  const today = riyadhDate(at);
  const yesterday = addDays(today, -1);
  const prev = await scheduleFor(employee, yesterday);
  if (prev.window && prev.window.end > dayTime(today, '00:00') && at < new Date(prev.window.end.getTime() + 2 * 60 * MIN_MS)) {
    const open = await AttendancePunch.findOne({ employeeId: employee._id, day: yesterday, type: 'in' }).lean();
    if (open) return yesterday;
  }
  return today;
}

export async function activeException(employeeId: unknown, day: string) {
  return AttendanceException.findOne({ employeeId, fromDay: { $lte: day }, toDay: { $gte: day } })
    .sort({ createdAt: -1 })
    .lean();
}

// ---------- punches ----------
const ON_DUTY = ON_DUTY_STATUSES as readonly string[];

export interface PunchContext {
  actor: Actor;
  ip?: string;
  userAgent?: string;
  now?: Date;
}
export interface PunchResult {
  punch: AttendancePunchDoc;
  day: AttendanceDayDoc;
  verdict: LocationVerdict;
  duplicate: boolean;
}

/**
 * The employee's own check-in / check-out [HR §3.4 ثانياً، ثالثاً]: server time, geofence check against the assigned
 * sites, refusal outside the fence unless an approved exception covers the day, idempotent on the client key,
 * alternating in / out. Every accepted punch is appended and the day recomputed; refusals are audited too.
 */
export async function punchForEmployee(employee: EmployeeDoc, input: PunchInput, ctx: PunchContext): Promise<PunchResult> {
  const now = ctx.now ?? new Date();
  if (!ON_DUTY.includes(employee.status)) throw forbidden('لا يمكن تسجيل الحضور في حالتك الوظيفية الحالية');
  if (input.idempotencyKey) {
    const existing = await AttendancePunch.findOne({ employeeId: employee._id, idempotencyKey: input.idempotencyKey });
    if (existing) {
      const day = await computeDay(employee, existing.day, now);
      return { punch: existing, day, verdict: { reason: 'ok', within: existing.withinGeofence ?? null }, duplicate: true };
    }
  }
  const day = await attendanceDayOf(employee, now);
  const last = await lastEffectivePunch(employee._id, day);
  if (last?.type === input.type)
    throw badRequest(input.type === 'in' ? 'سجّلت الحضور مسبقاً؛ سجّل الانصراف أولاً' : 'سجّلت الانصراف مسبقاً', {
      code: 'already_punched',
    });
  if (!last && input.type === 'out') throw badRequest('سجّل الحضور أولاً', { code: 'no_check_in' });

  const [schedule, policy, defaultRadius, exception] = await Promise.all([
    scheduleFor(employee, day),
    getSetting('hr.attendance.locationPolicy'),
    getSetting('hr.attendance.geofenceDefaultRadiusM'),
    activeException(employee._id, day),
  ]);
  const sites = schedule.siteIds.length
    ? await Site.find({ _id: { $in: schedule.siteIds }, deletedAt: null }).select('nameAr location geofenceRadiusM').lean()
    : [];
  const verdict = evaluateLocation(input.location, sites as SiteLite[], policy, defaultRadius);
  const flags: string[] = [];
  let exceptionId: unknown;
  if (verdict.reason === 'no_site') flags.push('no_site');
  else if (verdict.reason === 'ok') {
    /* inside the fence */
  } else if (exception) {
    exceptionId = exception._id; // «إلا وفق صلاحية أو استثناء معتمد» [HR §3.4 ثانياً 6]
    flags.push(verdict.reason === 'outside' ? 'outside_with_exception' : 'location_unavailable');
  } else if (verdict.reason === 'outside') {
    await recordAudit(ctx.actor, {
      action: 'create',
      resource: 'hr.attendance.refused',
      resourceId: String(employee._id),
      meta: { type: input.type, day, reason: 'outside_geofence', distanceM: verdict.distanceM, siteId: verdict.siteId },
    });
    throw badRequest(
      `أنت خارج النطاق الجغرافي المعتمد: تبعد ${verdict.distanceM} م عن «${verdict.siteName}» (المسموح ${verdict.radiusM} م). اطلب استثناءً إن كنت في مهمة خارجية.`,
      { code: 'outside_geofence', distanceM: verdict.distanceM, radiusM: verdict.radiusM, siteId: verdict.siteId },
    );
  } else if (policy.requireLocation && policy.onUnavailable === 'refuse') {
    await recordAudit(ctx.actor, {
      action: 'create',
      resource: 'hr.attendance.refused',
      resourceId: String(employee._id),
      meta: { type: input.type, day, reason: verdict.reason, locationError: input.locationError },
    });
    throw badRequest('تعذر تحديد الموقع — حاول مرة أخرى أو اطلب استثناءً من النطاق الجغرافي', {
      code: 'location_unavailable',
      reason: verdict.reason,
    });
  } else flags.push('location_unavailable');

  const punch = await AttendancePunch.create({
    employeeId: employee._id,
    type: input.type,
    at: now,
    day,
    location: input.location ?? undefined,
    locationError: input.locationError ?? (verdict.reason === 'inaccurate' ? 'inaccurate' : undefined),
    siteId: verdict.siteId,
    distanceM: verdict.distanceM,
    radiusM: verdict.radiusM,
    withinGeofence: verdict.within,
    exceptionId,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    byUserId: ctx.actor.userId,
    flags,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  await recordAudit(ctx.actor, {
    action: 'create',
    resource: 'hr.attendance',
    resourceId: String(punch._id),
    after: { employeeId: String(employee._id), type: punch.type, day, withinGeofence: punch.withinGeofence, flags },
  });
  const dayDoc = await computeDay(employee, day, now);
  return { punch, day: dayDoc, verdict, duplicate: false };
}

/** Last punch of the day that is not superseded by a correction. */
async function lastEffectivePunch(employeeId: unknown, day: string) {
  const punches = await effectivePunches(employeeId, day);
  return punches[punches.length - 1];
}

/** The day's punches minus the ones a `wrong_time` correction replaced, oldest first. */
export async function effectivePunches(employeeId: unknown, day: string): Promise<AttendancePunchDoc[]> {
  const all = await AttendancePunch.find({ employeeId, day }).sort({ at: 1 });
  const superseded = new Set(all.filter((p) => p.supersedesPunchId).map((p) => String(p.supersedesPunchId)));
  return all.filter((p) => !superseded.has(String(p._id)));
}

/** HR enters a punch by hand with a reason (Q17): audited, appended, recomputed. */
export async function manualPunch(input: ManualPunchInput, actor: Actor): Promise<PunchResult> {
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null });
  if (!employee) throw notFound('الموظف غير موجود');
  const day = await attendanceDayOf(employee, input.at);
  if (await isLocked(employee._id, day)) throw badRequest('اليوم مقفل بمسير رواتب معتمد');
  const punch = await AttendancePunch.create({
    employeeId: employee._id,
    type: input.type,
    at: input.at,
    day,
    siteId: input.siteId ?? undefined,
    withinGeofence: null,
    source: 'manual_hr',
    byUserId: actor.userId,
    reason: input.reason,
    flags: ['manual_hr'],
  });
  await recordAudit(actor, {
    action: 'create',
    resource: 'hr.attendance',
    resourceId: String(punch._id),
    after: { employeeId: String(employee._id), type: punch.type, at: punch.at, day, source: 'manual_hr', reason: input.reason },
    sensitive: true,
  });
  const dayDoc = await computeDay(employee, day, new Date());
  return { punch, day: dayDoc, verdict: { reason: 'no_site', within: null }, duplicate: false };
}

export async function isLocked(employeeId: unknown, day: string): Promise<boolean> {
  return !!(await AttendanceDay.exists({ employeeId, day, lockedByPayrollRunId: { $ne: null } }));
}

/** Punch as the API returns it: coordinates only for the employee themself and HR (HR_PLAN §10.10). */
export function serializePunch(p: AttendancePunchDoc | Record<string, unknown>, showLocation: boolean) {
  const o = typeof (p as AttendancePunchDoc).toObject === 'function' ? (p as AttendancePunchDoc).toObject() : { ...p };
  const out = o as Record<string, unknown>;
  if (!showLocation) {
    delete out.location;
    delete out.ip;
    delete out.userAgent;
  }
  return out;
}

// ---------- the computed day ----------
interface ComputeCtx {
  holidays: Set<string>;
  rules: AttendanceRules;
  overtime: OvertimePolicy;
}
async function computeCtx(): Promise<ComputeCtx> {
  const [holidays, rules, overtime] = await Promise.all([
    loadHolidaySet(),
    getSetting('hr.attendance.rules'),
    getSetting('hr.overtime'),
  ]);
  return { holidays, rules, overtime };
}

const APPROVED = { $or: [{ state: 'approved' }, { state: 'closed', 'decision.outcome': 'approved' }] };
/** Approved leave covering a Riyadh day (details dates are UTC midnights of Riyadh days). */
export async function approvedLeaveOn(employeeId: unknown, day: string) {
  const start = dayTime(day, '00:00');
  const end = dayTime(day, '23:59');
  return HrRequest.findOne({
    employeeId,
    type: 'leave',
    deletedAt: null,
    ...APPROVED,
    'details.startDate': { $lte: end },
    'details.endDate': { $gte: new Date(start.getTime() - DAY_MS) },
  })
    .select('details number')
    .lean()
    .then((r) => {
      if (!r) return null;
      const d = r.details as { startDate: Date; endDate: Date; leaveType: string };
      return riyadhDate(d.startDate) <= day && riyadhDate(d.endDate) >= day ? r : null;
    });
}
async function approvedPermissionsOn(employeeId: unknown, day: string) {
  const rows = await HrRequest.find({
    employeeId,
    type: 'permission',
    deletedAt: null,
    ...APPROVED,
    'details.date': { $gte: new Date(dayTime(day, '00:00').getTime() - DAY_MS), $lte: dayTime(day, '23:59') },
  })
    .select('details')
    .lean();
  return rows
    .map((r) => r.details as { date: Date; startTime: string; endTime: string })
    .filter((d) => riyadhDate(d.date) === day)
    .map((d) => ({ start: dayTime(day, d.startTime), end: dayTime(day, d.endTime) }));
}
async function approvedOvertimeOn(employeeId: unknown, day: string) {
  const r = await HrRequest.findOne({ employeeId, type: 'overtime', deletedAt: null, ...APPROVED, 'details.day': day })
    .select('details')
    .lean();
  if (!r) return null;
  const d = r.details as { startTime: string; endTime: string };
  return { requestId: String(r._id), minutes: minutesBetween(dayTime(day, d.startTime), dayTime(day, d.endTime)) };
}

/**
 * Recompute one employee-day from its sources [HR §3.4 رابعاً]. Idempotent; never touches a day a payroll run locked.
 * `now` decides whether today's day is final (shift end passed) or still in progress.
 */
export async function computeDay(employee: EmployeeDoc, day: string, now = new Date(), ctx?: ComputeCtx): Promise<AttendanceDayDoc> {
  const existing = await AttendanceDay.findOne({ employeeId: employee._id, day });
  if (existing?.lockedByPayrollRunId) return existing;
  const c = ctx ?? (await computeCtx());
  const [schedule, punches, leave, exception] = await Promise.all([
    scheduleFor(employee, day),
    effectivePunches(employee._id, day),
    approvedLeaveOn(employee._id, day),
    activeException(employee._id, day),
  ]);
  const today = riyadhDate(now);
  const flags = new Set<string>();
  const row: Partial<AttendanceDayDoc> & Record<string, unknown> = {
    employeeId: employee._id,
    day,
    departmentId: employee.departmentId,
    branchId: (schedule.branchId ?? employee.branchId ?? undefined) as never,
    shiftId: schedule.shift?._id,
    scheduled: false,
    expectedStart: undefined,
    expectedEnd: undefined,
    firstInAt: undefined,
    lastOutAt: undefined,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    workedMinutes: 0,
    overtimeMinutes: 0,
    overtimeApprovedMinutes: 0,
    permissionMinutes: 0,
    punchCount: punches.length,
    leaveRequestId: undefined,
    leaveType: undefined,
    exceptionId: exception?._id,
    overtimeRequestId: undefined,
    final: day < today,
  };
  // Pairs in → out; an open "in" is the last element with no out.
  let worked = 0;
  let openIn: Date | null = null;
  let firstIn: Date | undefined;
  let lastOut: Date | undefined;
  for (const p of punches) {
    if (p.type === 'in') {
      firstIn ??= p.at;
      if (!openIn) openIn = p.at;
    } else if (openIn) {
      worked += minutesBetween(openIn, p.at);
      lastOut = p.at;
      openIn = null;
    }
    if (p.exceptionId) flags.add('outside_with_exception');
    if (p.locationError || p.flags?.includes('location_unavailable')) flags.add('location_unavailable');
    if (p.source === 'correction') flags.add('corrected');
    if (p.source === 'manual_hr') flags.add('manual_hr');
  }
  row.firstInAt = firstIn;
  row.lastOutAt = lastOut;
  row.workedMinutes = worked;

  let status: AttendanceDayStatus;
  if (!schedule.shift) status = 'not_scheduled';
  else if (c.holidays.has(day)) status = 'holiday';
  else if (!schedule.isWorkDay) status = 'weekend';
  else if (leave) {
    status = 'on_leave';
    row.leaveRequestId = leave._id;
    row.leaveType = (leave.details as { leaveType?: string }).leaveType;
    row.scheduled = true;
  } else if (exception?.scope === 'remote') {
    status = 'remote'; // approved remote work [HR §3.5.3] punches from anywhere (HR_PLAN §10.5)
    row.scheduled = true;
  } else {
    row.scheduled = true;
    const w = schedule.window!;
    let expectedStart = w.start;
    let expectedEnd = w.end;
    const grace = schedule.graceMinutes ?? c.rules.graceMinutes;
    // An approved permission inside the window excuses the lateness / early leave it covers [HR §3.5.2].
    for (const perm of await approvedPermissionsOn(employee._id, day)) {
      const covered = minutesBetween(new Date(Math.max(perm.start.getTime(), w.start.getTime())), new Date(Math.min(perm.end.getTime(), w.end.getTime())));
      if (covered > 0) row.permissionMinutes = (row.permissionMinutes as number) + covered;
      if (perm.start <= new Date(expectedStart.getTime() + grace * MIN_MS) && perm.end > expectedStart) expectedStart = perm.end;
      if (perm.start < expectedEnd && perm.end >= expectedEnd) expectedEnd = perm.start;
    }
    row.expectedStart = expectedStart;
    row.expectedEnd = expectedEnd;
    const overtimeReq = await approvedOvertimeOn(employee._id, day);
    if (overtimeReq) row.overtimeRequestId = overtimeReq.requestId as never;
    const closeOutAt = new Date(expectedEnd.getTime() + c.rules.missedCheckOutAlertMinutes * MIN_MS);
    row.final = day < today || now >= closeOutAt;
    if (!firstIn) {
      if (now >= expectedEnd && c.rules.absentWhenNoCheckIn) status = 'absent';
      else status = 'missing_in';
    } else {
      const late = minutesBetween(expectedStart, firstIn);
      row.lateMinutes = late > grace ? late : 0;
      if (openIn && !lastOut) {
        // Checked in, never out.
        if (row.final) {
          if (c.rules.missingCheckoutPolicy === 'count_absent') {
            status = 'absent';
            row.workedMinutes = 0;
          } else if (c.rules.missingCheckoutPolicy === 'auto_close_at_shift_end_flagged') {
            status = row.lateMinutes ? 'late' : 'present';
            row.workedMinutes = Math.max(0, minutesBetween(openIn, expectedEnd));
            flags.add('auto_closed');
          } else {
            status = 'missing_out'; // Q4: hours wait for a correction
            row.workedMinutes = 0;
          }
        } else status = row.lateMinutes ? 'late' : 'present';
      } else {
        status = row.lateMinutes ? 'late' : 'present';
        if (lastOut) {
          const early = minutesBetween(lastOut, expectedEnd);
          row.earlyLeaveMinutes = early > c.rules.earlyLeaveGraceMinutes ? early : 0;
          const beyond = minutesBetween(expectedEnd, lastOut);
          const rounded = beyond > 0 ? Math.floor(beyond / c.overtime.roundingMinutes) * c.overtime.roundingMinutes : 0;
          row.overtimeMinutes = rounded;
          row.overtimeApprovedMinutes = c.overtime.requiresPreApproval
            ? Math.min(rounded, overtimeReq?.minutes ?? 0)
            : rounded;
          if (rounded > 0 && !overtimeReq && c.overtime.requiresPreApproval) flags.add('overtime_unapproved');
        }
      }
    }
  }
  row.status = status;
  row.flags = [...flags];
  row.computedAt = now;
  const update = { $set: row, $inc: { version: 1 } };
  const doc = await AttendanceDay.findOneAndUpdate({ employeeId: employee._id, day }, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });
  return doc!;
}

/** Recompute a range for one employee (after a correction, an approval, a schedule change). */
export async function recomputeRange(employeeId: unknown, fromDay: string, toDay: string, now = new Date()): Promise<number> {
  const employee = await Employee.findOne({ _id: employeeId, deletedAt: null });
  if (!employee) return 0;
  const ctx = await computeCtx();
  const today = riyadhDate(now);
  let n = 0;
  for (const day of daysBetween(fromDay, toDay > today ? today : toDay)) {
    await computeDay(employee, day, now, ctx);
    n++;
  }
  return n;
}

// ---------- jobs ----------
/**
 * Frequent job: compute today's (and the unfinished yesterday's) day for every on-duty employee, then
 * «إشعار الموظف عند نسيان تسجيل الحضور أو الانصراف» [HR §3.4 رابعاً] — once per day and punch, business days only.
 */
export async function runAttendanceCompute(now = new Date()): Promise<{ computed: number; alerts: number }> {
  const ctx = await computeCtx();
  const today = riyadhDate(now);
  const yesterday = addDays(today, -1);
  const employees = await Employee.find({ deletedAt: null, status: { $in: [...ON_DUTY_STATUSES] } });
  let computed = 0;
  let alerts = 0;
  for (const e of employees) {
    const prev = await AttendanceDay.findOne({ employeeId: e._id, day: yesterday }).select('final').lean();
    if (!prev?.final) {
      await computeDay(e, yesterday, now, ctx);
      computed++;
    }
    const d = await computeDay(e, today, now, ctx);
    computed++;
    if (!d.scheduled || !e.userId) continue;
    if (d.status === 'missing_in' && !d.alerts?.missedIn && d.expectedStart) {
      const due = new Date(d.expectedStart.getTime() + ctx.rules.missedCheckInAlertMinutes * MIN_MS);
      if (now >= due) {
        await notify({
          userIds: [String(e.userId)],
          type: 'attendance.missed_punch',
          bodyAr: `لم تسجّل حضورك اليوم ${today}؛ دوامك يبدأ ${hhmm(d.expectedStart)}. سجّل الآن أو ارفع طلب تعديل بصمة.`,
          link: '/me/attendance',
        });
        await AttendanceDay.updateOne({ _id: d._id }, { $set: { 'alerts.missedIn': now } });
        alerts++;
      }
    }
    if (d.firstInAt && !d.lastOutAt && !d.alerts?.missedOut && d.expectedEnd) {
      const due = new Date(d.expectedEnd.getTime() + ctx.rules.missedCheckOutAlertMinutes * MIN_MS);
      if (now >= due) {
        await notify({
          userIds: [String(e.userId)],
          type: 'attendance.missed_punch',
          bodyAr: `لم تسجّل انصرافك عن يوم ${d.day}؛ انتهى دوامك ${hhmm(d.expectedEnd)}. سجّل الانصراف أو ارفع طلب تعديل بصمة.`,
          link: '/me/attendance',
        });
        await AttendanceDay.updateOne({ _id: d._id }, { $set: { 'alerts.missedOut': now } });
        alerts++;
      }
    }
  }
  return { computed, alerts };
}
const hhmm = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

// ---------- hooks from the HR request lifecycle ----------
type Details = Record<string, unknown>;

/**
 * Validations at request creation for the attendance types (HR_PLAN §4.1–4.2, Q3 / Q5 / Q6). Returns flags for HR;
 * throws 400 for hard rules.
 */
export async function validateAttendanceRequest(
  type: 'attendance_correction' | 'geofence_exception' | 'overtime',
  details: Details,
  employee: EmployeeDoc,
  now = new Date(),
): Promise<{ flags: string[]; details: Details }> {
  const flags: string[] = [];
  const today = riyadhDate(now);
  if (type === 'attendance_correction') {
    const day = details.day as string;
    const policy = await getSetting('hr.attendance.correction');
    if (day > today) throw badRequest('لا يمكن طلب تعديل بصمة ليوم لم يأتِ بعد');
    if (day < addDays(today, -policy.deadlineDays))
      throw badRequest(`انتهت مهلة طلب التعديل (${policy.deadlineDays} أيام من تاريخ اليوم المطلوب)`);
    if (await isLocked(employee._id, day)) throw badRequest('اليوم مقفل بمسير رواتب معتمد؛ تواصل مع الموارد البشرية');
    if (details.kind === 'wrong_time') {
      const p = await AttendancePunch.findOne({ _id: details.punchId, employeeId: employee._id, day });
      if (!p) throw badRequest('البصمة المطلوب تعديلها غير موجودة في هذا اليوم');
    }
    if (policy.perMonth !== null) {
      const month = day.slice(0, 7);
      const count = await HrRequest.countDocuments({
        employeeId: employee._id,
        type: 'attendance_correction',
        deletedAt: null,
        state: { $ne: 'rejected' },
        'details.day': { $gte: `${month}-01`, $lte: `${month}-31` },
      });
      if (count >= policy.perMonth) flags.push('corrections_limit'); // Q6: beyond the limit HR decides
    }
  } else if (type === 'geofence_exception') {
    const max = await getSetting('hr.attendance.exceptionMaxDays');
    const days = daysBetween(details.from as string, details.to as string, max + 2).length;
    if (days > max) throw badRequest(`الحد الأقصى لمدة الاستثناء ${max} أيام`);
    if (details.scope === 'site') {
      const site = await Site.findOne({ _id: details.siteId, deletedAt: null }).select('_id').lean();
      if (!site) throw badRequest('الموقع غير موجود');
    }
  } else if (type === 'overtime') {
    const policy = await getSetting('hr.overtime');
    const day = details.day as string;
    if (day < addDays(today, -1)) throw badRequest('العمل الإضافي يحتاج موافقة مسبقة؛ لا يُطلب لأيام سابقة');
    if (policy.compensation === 'employee_choice') {
      if (!details.compensation) throw badRequest('اختر طريقة التعويض: صرف أو إجازة');
    } else details = { ...details, compensation: policy.compensation };
    if (policy.monthlyCapMinutes !== null) {
      const month = day.slice(0, 7);
      const rows = await HrRequest.find({
        employeeId: employee._id,
        type: 'overtime',
        deletedAt: null,
        ...APPROVED,
        'details.day': { $gte: `${month}-01`, $lte: `${month}-31` },
      })
        .select('details')
        .lean();
      const used = rows.reduce((s, r) => {
        const d = r.details as { day: string; startTime: string; endTime: string };
        return s + minutesBetween(dayTime(d.day, d.startTime), dayTime(d.day, d.endTime));
      }, 0);
      const asked = minutesBetween(dayTime(day, details.startTime as string), dayTime(day, details.endTime as string));
      if (used + asked > policy.monthlyCapMinutes) flags.push('overtime_cap');
    }
  }
  return { flags, details };
}

/**
 * Effects of an approved request on attendance, inside the approval transaction (HR_PLAN §5):
 * correction → a new punch (`source: correction`, the original stays); geofence exception → an exception row;
 * remote work → a remote exception for its days; overtime → the day is recomputed. Leave is handled by leave.service.
 */
export async function applyApprovedRequest(
  request: { _id: unknown; type: string; details: Details; employeeId: unknown },
  actor: Actor,
  session: ClientSession | undefined,
  now = new Date(),
): Promise<string[]> {
  const d = request.details;
  const daysToRecompute: string[] = [];
  if (request.type === 'attendance_correction') {
    const day = d.day as string;
    const kind = d.kind as string;
    let type: PunchType = kind === 'missing_out' ? 'out' : 'in';
    let supersedes: unknown;
    if (kind === 'wrong_time') {
      const old = await AttendancePunch.findById(d.punchId).session(session ?? null);
      if (!old) throw badRequest('البصمة الأصلية غير موجودة');
      type = old.type as PunchType;
      supersedes = old._id;
    }
    await AttendancePunch.create(
      [
        {
          employeeId: request.employeeId,
          type,
          at: dayTime(day, d.requestedTime as string),
          day,
          withinGeofence: null,
          source: 'correction',
          correctionRequestId: request._id,
          supersedesPunchId: supersedes,
          byUserId: actor.userId,
          reason: d.reason,
          flags: ['correction'],
        },
      ],
      { session },
    );
    daysToRecompute.push(day);
  } else if (request.type === 'geofence_exception') {
    await AttendanceException.create(
      [
        {
          employeeId: request.employeeId,
          fromDay: d.from,
          toDay: d.to,
          scope: d.scope,
          siteId: d.siteId ?? undefined,
          requestId: request._id,
          requestType: 'geofence_exception',
          approvedBy: actor.userId,
          reason: d.reason,
        },
      ],
      { session },
    );
    daysToRecompute.push(...daysBetween(d.from as string, d.to as string));
  } else if (request.type === 'remote_work') {
    const from = riyadhDate(new Date(d.startDate as string | Date));
    const to = addDays(from, Math.max(0, Number(d.days) - 1));
    await AttendanceException.create(
      [
        {
          employeeId: request.employeeId,
          fromDay: from,
          toDay: to,
          scope: 'remote',
          requestId: request._id,
          requestType: 'remote_work',
          approvedBy: actor.userId,
          reason: d.reason,
        },
      ],
      { session },
    );
    daysToRecompute.push(...daysBetween(from, to));
  } else if (request.type === 'overtime') {
    daysToRecompute.push(d.day as string);
  }
  if (daysToRecompute.length)
    await publish(
      {
        type: 'hr.attendance.recompute_requested',
        aggregateType: 'hr_request',
        aggregateId: String(request._id),
        payload: { employeeId: String(request.employeeId), days: daysToRecompute },
        actorUserId: actor.userId,
      },
      session,
    );
  void now;
  return daysToRecompute;
}

/** After the approval transaction committed: recompute the affected days (read-your-writes needs the commit). */
export async function recomputeDays(employeeId: unknown, days: string[], now = new Date()): Promise<void> {
  if (!days.length) return;
  const sorted = [...days].sort();
  await recomputeRange(employeeId, sorted[0], sorted[sorted.length - 1], now);
}

// ---------- queries for screens and reports ----------
export interface DaysFilter {
  employeeIds?: unknown[];
  from?: string;
  to?: string;
  status?: string;
  exceptionsOnly?: boolean;
  departmentId?: string;
  branchId?: string;
}
export function daysQuery(f: DaysFilter): FilterQuery<unknown> {
  const q: Record<string, unknown> = {};
  if (f.employeeIds) q.employeeId = { $in: f.employeeIds };
  if (f.from || f.to) q.day = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
  if (f.status) q.status = f.status;
  if (f.departmentId) q.departmentId = f.departmentId;
  if (f.branchId) q.branchId = f.branchId;
  if (f.exceptionsOnly)
    q.$or = [
      { status: { $in: ['late', 'absent', 'missing_in', 'missing_out'] } },
      { earlyLeaveMinutes: { $gt: 0 } },
    ];
  return q;
}

/** Totals of a set of days (the employee's month cards, the manager's team view, the dashboard). */
export function summarizeDays(days: Pick<AttendanceDayDoc, 'status' | 'scheduled' | 'workedMinutes' | 'lateMinutes' | 'overtimeMinutes' | 'overtimeApprovedMinutes' | 'earlyLeaveMinutes' | 'final'>[]) {
  const s = {
    scheduledDays: 0,
    presentDays: 0,
    lateDays: 0,
    absentDays: 0,
    leaveDays: 0,
    remoteDays: 0,
    missingPunchDays: 0,
    earlyLeaveDays: 0,
    workedMinutes: 0,
    lateMinutes: 0,
    overtimeMinutes: 0,
    overtimeApprovedMinutes: 0,
  };
  for (const d of days) {
    if (d.scheduled) s.scheduledDays++;
    if (d.status === 'present' || d.status === 'late') s.presentDays++;
    if (d.status === 'late') s.lateDays++;
    if (d.status === 'absent') s.absentDays++;
    if (d.status === 'on_leave') s.leaveDays++;
    if (d.status === 'remote') s.remoteDays++;
    if ((d.status === 'missing_in' || d.status === 'missing_out') && d.final) s.missingPunchDays++;
    if (d.earlyLeaveMinutes > 0) s.earlyLeaveDays++;
    s.workedMinutes += d.workedMinutes;
    s.lateMinutes += d.lateMinutes;
    s.overtimeMinutes += d.overtimeMinutes;
    s.overtimeApprovedMinutes += d.overtimeApprovedMinutes;
  }
  return s;
}

/** Make sure every on-duty employee has computed rows for a window (reports over days nobody opened yet). */
export async function ensureDaysComputed(employeeIds: unknown[], from: string, to: string, now = new Date()): Promise<void> {
  const ctx = await computeCtx();
  const today = riyadhDate(now);
  const end = to > today ? today : to;
  const days = daysBetween(from, end, 62);
  const employees = await Employee.find({ _id: { $in: employeeIds }, deletedAt: null });
  for (const e of employees) {
    const have = new Set(
      (await AttendanceDay.find({ employeeId: e._id, day: { $gte: from, $lte: end }, final: true }).select('day').lean()).map((r) => r.day),
    );
    for (const day of days) if (!have.has(day)) await computeDay(e, day, now, ctx);
  }
}

export { SYSTEM_ACTOR };
