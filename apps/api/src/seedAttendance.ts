import { LEAVE_TYPES } from '@eayni/shared';
import { Branch, Site } from './core/org/model';
import { riyadhDate } from './core/dates/businessDays';
import { Employee } from './modules/hr/model';
import {
  AttendanceDay,
  AttendancePunch,
  LeaveLedger,
  Shift,
  ShiftAssignment,
  ShiftVersion,
} from './modules/hr/attendance.model';
import { addDays, dayTime, recomputeRange, scheduleFor } from './modules/hr/attendance.service';
import { DEFAULT_LEAVE_POLICIES } from '@eayni/shared';
import { serviceYears } from './modules/hr/leave.service';

/**
 * Sample attendance data [HR §3.4] for local testing — shifts (Q1 provisional hours), a second operating site, field
 * assignments, opening leave balances (Q7) and sixty days of punches in every state (present / late / early leave /
 * missing check-out / absent, today in progress). Idempotent: skipped once a shift exists. Sites are samples (Q2).
 */
export async function seedAttendance(): Promise<{ shifts: number; punches: number; balances: number }> {
  if (await Shift.countDocuments()) return { shifts: 0, punches: 0, balances: 0 };
  const now = new Date();
  const today = riyadhDate(now);

  // Shifts — the standard day (default for everyone without an assignment), the field day, a sample evening rotation.
  const shiftDefs = [
    {
      code: 'standard',
      nameAr: 'الدوام الأساسي',
      kind: 'fixed',
      periods: [{ start: '08:00', end: '16:00', crossesMidnight: false }],
      ramadanPeriods: [{ start: '10:00', end: '16:00', crossesMidnight: false }],
      workDays: [0, 1, 2, 3, 4],
      notes: 'المادتان 98 و101 من نظام العمل — مؤقت حتى اعتماد الموارد البشرية (Q1)',
    },
    {
      code: 'field',
      nameAr: 'الدوام الميداني',
      kind: 'field',
      periods: [{ start: '07:00', end: '15:00', crossesMidnight: false }],
      ramadanPeriods: [{ start: '09:00', end: '15:00', crossesMidnight: false }],
      workDays: [0, 1, 2, 3, 4],
      graceMinutes: 15,
      notes: 'الفرق الميدانية والسائقون؛ عدة مواقع تشغيل لكل موظف [HR §3.4 ثانياً 8]',
    },
    {
      code: 'evening',
      nameAr: 'الوردية المسائية (نموذج)',
      kind: 'rotating',
      periods: [{ start: '15:00', end: '23:00', crossesMidnight: false }],
      ramadanPeriods: [],
      workDays: [6, 0, 1, 2, 3],
      active: true,
      notes: 'نموذج لنظام الورديات؛ لا موظفين عليها حتى تحدد الموارد البشرية الورديات الفعلية',
    },
  ];
  const shifts = new Map<string, InstanceType<typeof Shift>>();
  for (const def of shiftDefs) {
    const s = await Shift.create(def);
    await ShiftVersion.create({ shiftId: s._id, version: 1, snapshot: s.toObject(), changedBy: 'seed' });
    shifts.set(def.code, s);
  }

  // A second sample site for the field teams (the real list is Q2).
  const hq = await Branch.findOne({ code: 'hq' });
  const mainSite = hq ? await Site.findOne({ branchId: hq._id }).sort({ createdAt: 1 }) : null;
  let sortingSite = hq ? await Site.findOne({ branchId: hq._id, nameAr: 'موقع فرز الدمام (تجريبي)' }) : null;
  if (hq && !sortingSite)
    sortingSite = await Site.create({
      branchId: hq._id,
      nameAr: 'موقع فرز الدمام (تجريبي)',
      location: { type: 'Point', coordinates: [50.08, 26.4] },
      geofenceRadiusM: 300,
      active: true,
    });

  const employees = await Employee.find({ deletedAt: null, status: { $nin: ['resigned', 'terminated'] } }).sort({ employeeNumber: 1 });
  const positions = await (await import('./core/org/model')).Position.find().select('titleAr').lean();
  const positionTitle = new Map(positions.map((p) => [String(p._id), p.titleAr]));

  // Field staff → field shift with both sites, from 90 days ago [HR §3.4 أولاً 4–5, 7].
  for (const e of employees) {
    const title = e.positionId ? (positionTitle.get(String(e.positionId)) ?? '') : '';
    if (!/ميداني|سائق|مشرف موقع/.test(title)) continue;
    await ShiftAssignment.create({
      employeeId: e._id,
      shiftId: shifts.get('field')!._id,
      siteIds: [mainSite?._id, sortingSite?._id].filter(Boolean),
      branchId: e.branchId ?? undefined,
      fromDay: addDays(today, -90),
      toDay: null,
      reason: 'إسناد تجريبي للفرق الميدانية',
    });
  }

  // Opening leave balances for the current year (Q7 proposals; the ERPNext extraction is pending — DECISIONS §3).
  const year = Number(today.slice(0, 4));
  let balances = 0;
  for (const [i, e] of employees.entries()) {
    const annual = DEFAULT_LEAVE_POLICIES.annual;
    const entitlement = serviceYears(e.hireDate, now) >= 5 ? annual.entitlementAfter5YearsDays! : annual.entitlementDays!;
    const used = i % 4; // a few days already taken this year
    await LeaveLedger.create({
      employeeId: e._id,
      leaveType: 'annual',
      entryType: 'opening',
      days: entitlement - used,
      year,
      effectiveAt: dayTime(`${year}-01-01`, '00:00'),
      refType: 'seed',
      refId: `${year}:annual`,
      note: `رصيد افتتاحي تجريبي (استحقاق ${entitlement} يوماً، مستخدم ${used})`,
      actorEmail: 'seed',
    });
    await LeaveLedger.create({
      employeeId: e._id,
      leaveType: 'sick',
      entryType: 'opening',
      days: DEFAULT_LEAVE_POLICIES.sick.entitlementDays!,
      year,
      effectiveAt: dayTime(`${year}-01-01`, '00:00'),
      refType: 'seed',
      refId: `${year}:sick`,
      note: 'رصيد افتتاحي تجريبي (المادة 117)',
      actorEmail: 'seed',
    });
    balances += 2;
  }
  void LEAVE_TYPES;

  // Sixty days of punches up to yesterday (this month and last month's payroll window), every state; today in progress for a third of the staff.
  const siteOf = (e: InstanceType<typeof Employee>) => (e.siteId ? String(e.siteId) === String(mainSite?._id) : true) ? mainSite : sortingSite;
  let punches = 0;
  const hhmm = (base: string, deltaMin: number) => {
    const [h, m] = base.split(':').map(Number);
    const total = h * 60 + m + deltaMin;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  const insert = async (e: InstanceType<typeof Employee>, day: string, type: 'in' | 'out', time: string, site: typeof mainSite) => {
    const coords = site?.location?.coordinates ?? [50.1, 26.43];
    const wobble = (type === 'in' ? 0.0003 : -0.0002) * ((punches % 5) + 1);
    await AttendancePunch.create({
      employeeId: e._id,
      type,
      at: dayTime(day, time),
      day,
      location: { lat: coords[1] + wobble, lng: coords[0] + wobble, accuracyM: 12 + (punches % 20) },
      siteId: site?._id,
      distanceM: Math.round(Math.abs(wobble) * 111_000),
      radiusM: site?.geofenceRadiusM ?? 150,
      withinGeofence: true,
      source: punches % 3 === 0 ? 'mobile' : 'web',
      flags: [],
    });
    punches++;
  };
  for (const [i, e] of employees.entries()) {
    const isManager = /مدير/.test(e.positionId ? (positionTitle.get(String(e.positionId)) ?? '') : '');
    for (let back = 60; back >= 1; back--) {
      const day = addDays(today, -back);
      const sched = await scheduleFor(e, day);
      if (!sched.window) continue; // weekend / no schedule
      const start = sched.window.periods[0].start;
      const end = sched.window.periods[sched.window.periods.length - 1].end;
      const pattern = isManager ? (i + back) % 6 : (i * 7 + back * 3) % 10;
      const site = siteOf(e);
      if (pattern === 9) continue; // absent
      if (pattern === 6) await insert(e, day, 'in', hhmm(start, 27), site); // late
      else await insert(e, day, 'in', hhmm(start, -8 + ((i + back) % 13)), site);
      if (pattern === 8) continue; // missing check-out
      if (pattern === 7) await insert(e, day, 'out', hhmm(end, -40), site); // early leave
      else if (pattern === 5 && !isManager) await insert(e, day, 'out', hhmm(end, 95), site); // stayed late (unapproved overtime flag)
      else await insert(e, day, 'out', hhmm(end, 2 + ((i + back) % 17)), site);
    }
    // Today: a third of the staff already checked in (when the day has started).
    const sched = await scheduleFor(e, today);
    if (sched.window && i % 3 === 0 && now > new Date(sched.window.start.getTime() + 5 * 60_000)) {
      const at = new Date(sched.window.start.getTime() - 3 * 60_000);
      if (at < now) await insert(e, today, 'in', riyadhClock(at), siteOf(e));
    }
    await recomputeRange(e._id, addDays(today, -60), today, now);
  }
  void AttendanceDay;
  return { shifts: shifts.size, punches, balances };
}

const riyadhClock = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
