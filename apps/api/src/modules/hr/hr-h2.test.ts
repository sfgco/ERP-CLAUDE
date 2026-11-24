import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { activateAccount, auth, loginAs, makeDepartment, makeUser, testApp } from '../../test/helpers';
import { setSetting } from '../../core/settings/service';
import { SYSTEM_ACTOR } from '../../core/http/context';
import { Notification } from '../../core/notifications/model';
import { AuditLog } from '../../core/audit/model';
import { Holiday } from '../../core/dates/model';
import { Branch, Site } from '../../core/org/model';
import { riyadhDate } from '../../core/dates/businessDays';
import { Employee } from './model';
import { AttendanceDay, AttendanceException, AttendancePunch, LeaveLedger, Shift } from './attendance.model';
import { addDays, computeDay, dayTime, runAttendanceCompute, weekdayOf } from './attendance.service';
import { balance, runLeaveAccrual } from './leave.service';

const app = () => testApp();
const DAY = 86_400_000;
const HQ = { lat: 26.43, lng: 50.1 }; // the sample site
const INSIDE = { lat: 26.4302, lng: 50.1003, accuracyM: 15 };
const FAR = { lat: 26.47, lng: 50.15, accuracyM: 10 }; // ~7 km away
const today = () => riyadhDate(new Date());
/** The n-th most recent Sunday–Thursday before today (n = 1 → the last working weekday). */
function recentWeekday(n = 1): string {
  let d = today();
  let left = n;
  while (left > 0) {
    d = addDays(d, -1);
    if (weekdayOf(d) <= 4) left--;
  }
  return d;
}

/**
 * H2 — التشغيل اليومي: schedules and shifts, GPS punches with geofences, the computed day, the two attendance request
 * types and the overtime request, leave balances and the eight reports [HR §3.4, §3.5.1, HR §8 المرحلة الثانية].
 */
async function setup() {
  await setSetting('auth.mfaRequiredRoles', [], SYSTEM_ACTOR);
  const ops = await makeDepartment('ops', 'التشغيل');
  const branch = await Branch.create({ code: 'hq', nameAr: 'المقر', active: true });
  const site = await Site.create({
    branchId: branch._id,
    nameAr: 'موقع التشغيل الرئيسي',
    location: { type: 'Point', coordinates: [HQ.lng, HQ.lat] },
    geofenceRadiusM: 200,
    active: true,
  });
  await makeUser('hr@eayni.local', [{ role: 'employee' }, { role: 'hr_manager' }]);
  const hr = await loginAs('hr@eayni.local');
  // The default shift of Q1 (provisional) — created through the API like HR would.
  const shift = await request(app())
    .post('/api/v1/hr/shifts')
    .set(auth(hr))
    .send({ code: 'standard', nameAr: 'الدوام الأساسي', kind: 'fixed', periods: [{ start: '08:00', end: '16:00' }], ramadanPeriods: [{ start: '10:00', end: '16:00' }], workDays: [0, 1, 2, 3, 4] });
  expect(shift.status).toBe(201);
  let n = 0;
  const mk = async (email: string, first: string, extra: Record<string, unknown> = {}, directManagerId?: string) => {
    const r = await request(app())
      .post('/api/v1/hr/employees')
      .set(auth(hr))
      .send({
        firstNameAr: first,
        lastNameAr: 'العنزي',
        gender: 'male',
        nationality: 'سعودي',
        workEmail: email,
        identity: { type: 'national_id', number: `10${String(60000000 + ++n).padStart(8, '0')}`, expiryDate: new Date(Date.now() + 400 * DAY) },
        hireDate: '2024-01-10',
        departmentId: String(ops._id),
        branchId: String(branch._id),
        siteId: String(site._id),
        directManagerId,
        ...extra,
      });
    expect(r.status).toBe(201);
    return { employeeId: r.body._id as string, userId: r.body.userId as string, token: await activateAccount(email, r.body.temporaryPassword) };
  };
  const mgr = await mk('mgr@eayni.local', 'خالد');
  const a = await mk('a@eayni.local', 'عمر', {}, mgr.employeeId);
  const b = await mk('b@eayni.local', 'راشد', {}, mgr.employeeId);
  const other = await mk('other@eayni.local', 'فهد'); // not in mgr's team
  return { hr, ops, branch, site, shift: shift.body, mgr, a, b, other };
}

const hrReq = (token: string, type: string, details: Record<string, unknown>, attachmentIds: string[] = []) =>
  request(app()).post('/api/v1/hr/requests').set(auth(token)).send({ type, details, attachmentIds });
const act = (token: string, id: string, transition: string, extra: Record<string, unknown> = {}) =>
  request(app()).post(`/api/v1/hr/requests/${id}/transition`).set(auth(token)).send({ transition, ...extra });
const punch = (token: string, body: Record<string, unknown>) =>
  request(app()).post('/api/v1/hr/attendance/me/punch').set(auth(token)).send(body);
const emp = (id: string) => Employee.findById(id).then((e) => e!);
const insertPunch = (employeeId: string, day: string, type: 'in' | 'out', hhmm: string) =>
  AttendancePunch.create({ employeeId, type, at: dayTime(day, hhmm), day, source: 'web', withinGeofence: true });

describe('H2 §3.4 أولاً — work schedules and shifts', () => {
  it('shifts are created, versioned on change and assigned with sites; the assignment history closes the previous row', async () => {
    const { hr, a, site, shift } = await setup();
    const dup = await request(app()).post('/api/v1/hr/shifts').set(auth(hr)).send({ code: 'standard', nameAr: 'x', periods: [{ start: '08:00', end: '16:00' }] });
    expect(dup.status).toBe(400);
    const field = await request(app())
      .post('/api/v1/hr/shifts')
      .set(auth(hr))
      .send({ code: 'field', nameAr: 'الدوام الميداني', kind: 'field', periods: [{ start: '07:00', end: '15:00' }], graceMinutes: 15 });
    expect(field.status).toBe(201);
    const patched = await request(app()).patch(`/api/v1/hr/shifts/${field.body._id}`).set(auth(hr)).send({ periods: [{ start: '06:30', end: '14:30' }] });
    expect(patched.status).toBe(200);
    expect(patched.body.version).toBe(2);
    const versions = await request(app()).get(`/api/v1/hr/shifts/${field.body._id}/versions`).set(auth(hr));
    expect(versions.body.items).toHaveLength(2);
    expect(versions.body.items[1].snapshot.periods[0].start).toBe('07:00');

    // Assignment with a site, then a later one: the first closes the day before [HR §3.4 أولاً 4–6].
    const from1 = addDays(today(), -30);
    const from2 = addDays(today(), -10);
    const a1 = await request(app()).post('/api/v1/hr/shifts/assignments').set(auth(hr)).send({ employeeId: a.employeeId, shiftId: field.body._id, siteIds: [String(site._id)], from: from1 });
    expect(a1.status).toBe(201);
    const a2 = await request(app()).post('/api/v1/hr/shifts/assignments').set(auth(hr)).send({ employeeId: a.employeeId, shiftId: shift._id, siteIds: [], from: from2, reason: 'عودة إلى المكتب' });
    expect(a2.status).toBe(201);
    const hist = await request(app()).get(`/api/v1/hr/shifts/assignments?employeeId=${a.employeeId}`).set(auth(hr));
    expect(hist.body.items).toHaveLength(2);
    expect(hist.body.items.find((x: { fromDay: string }) => x.fromDay === from1).toDay).toBe(addDays(from2, -1));
    expect(hist.body.items.find((x: { fromDay: string }) => x.fromDay === from2).toDay).toBeNull();
    // Earlier start than the current row is refused.
    const bad = await request(app()).post('/api/v1/hr/shifts/assignments').set(auth(hr)).send({ employeeId: a.employeeId, shiftId: shift._id, from: addDays(today(), -20) });
    expect(bad.status).toBe(400);

    // An employee reads only their own assignment and cannot create shifts.
    const mine = await request(app()).get(`/api/v1/hr/shifts/assignments?employeeId=${a.employeeId}`).set(auth(a.token));
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(2);
    expect((await request(app()).post('/api/v1/hr/shifts').set(auth(a.token)).send({ code: 'x1', nameAr: 'xx', periods: [{ start: '08:00', end: '16:00' }] })).status).toBe(403);
    // The list carries the provisional marker of the default shift (Q1).
    const list = await request(app()).get('/api/v1/hr/shifts').set(auth(a.token));
    expect(list.body.defaultShiftCode).toBe('standard');
    expect(list.body.defaultShiftProvisional).toBe(true);
  });
});

describe('H2 §3.4 ثانياً — GPS check-in / check-out with geofences', () => {
  it('records server time inside the fence, refuses outside and without location, honours an approved exception, and is idempotent', async () => {
    const { hr, mgr, a, b } = await setup();
    const before = Date.now();
    const r1 = await punch(a.token, { type: 'in', location: INSIDE, idempotencyKey: 'key-1-aaaaaaaa' });
    expect(r1.status).toBe(201);
    expect(new Date(r1.body.punch.at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(r1.body.punch.withinGeofence).toBe(true);
    expect(r1.body.verdict).toMatchObject({ reason: 'ok', siteName: 'موقع التشغيل الرئيسي' });
    expect(r1.body.day.status).toMatch(/present|late/);
    // Same key again → the same punch, not a second row.
    const again = await punch(a.token, { type: 'in', location: INSIDE, idempotencyKey: 'key-1-aaaaaaaa' });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(await AttendancePunch.countDocuments({ employeeId: a.employeeId })).toBe(1);
    // Alternation.
    const dupIn = await punch(a.token, { type: 'in', location: INSIDE });
    expect(dupIn.status).toBe(400);
    expect(dupIn.body.error.details.code).toBe('already_punched');
    const outFirst = await punch(b.token, { type: 'out', location: INSIDE });
    expect(outFirst.status).toBe(400);
    // Outside the fence: refused with the distance, and the refusal is audited [HR §3.4 ثانياً 6].
    const far = await punch(b.token, { type: 'in', location: FAR });
    expect(far.status).toBe(400);
    expect(far.body.error.details.code).toBe('outside_geofence');
    expect(far.body.error.details.distanceM).toBeGreaterThan(1000);
    expect(await AuditLog.countDocuments({ resource: 'hr.attendance.refused' })).toBe(1);
    // No location: refused by the default policy (Q3), accepted flagged when the policy says so.
    const noLoc = await punch(b.token, { type: 'in', locationError: 'denied' });
    expect(noLoc.status).toBe(400);
    expect(noLoc.body.error.details.code).toBe('location_unavailable');
    // Inaccurate fix (accuracy 900 m > 2 × 200 m) counts as unavailable.
    const blurry = await punch(b.token, { type: 'in', location: { ...INSIDE, accuracyM: 900 } });
    expect(blurry.status).toBe(400);
    await setSetting('hr.attendance.locationPolicy', { requireLocation: true, maxAccuracyFactor: 2, onUnavailable: 'allow_flagged' }, SYSTEM_ACTOR);
    const flagged = await punch(b.token, { type: 'in', locationError: 'timeout' });
    expect(flagged.status).toBe(201);
    expect(flagged.body.punch.flags).toContain('location_unavailable');
    await setSetting('hr.attendance.locationPolicy', { requireLocation: true, maxAccuracyFactor: 2, onUnavailable: 'refuse' }, SYSTEM_ACTOR);

    // An approved geofence exception lets b check out from far away, marked with the exception [HR §3.4 ثانياً 6].
    const exc = await hrReq(b.token, 'geofence_exception', { from: today(), to: addDays(today(), 1), scope: 'any_location', reason: 'مهمة توصيل' });
    expect(exc.status).toBe(201);
    expect(exc.body.state).toBe('awaiting_manager');
    expect((await act(mgr.token, exc.body._id, 'approve')).status).toBe(200);
    expect((await act(hr, exc.body._id, 'approve')).body.state).toBe('approved');
    expect(await AttendanceException.countDocuments({ employeeId: b.employeeId, scope: 'any_location' })).toBe(1);
    const farOk = await punch(b.token, { type: 'out', location: FAR });
    expect(farOk.status).toBe(201);
    expect(farOk.body.punch.exceptionId).toBeTruthy();
    expect(farOk.body.punch.withinGeofence).toBe(false);
    expect(farOk.body.punch.flags).toContain('outside_with_exception');
    // Too long an exception is refused (Q3: 5 days).
    const long = await hrReq(b.token, 'geofence_exception', { from: today(), to: addDays(today(), 6), scope: 'any_location', reason: 'طويل' });
    expect(long.status).toBe(400);
    // Every accepted punch is audited.
    expect(await AuditLog.countDocuments({ resource: 'hr.attendance', action: 'create' })).toBeGreaterThanOrEqual(3);
  });

  it('coordinates are visible to the employee and HR only; the manager sees inside / outside and the site', async () => {
    const { hr, mgr, a, other } = await setup();
    expect((await punch(a.token, { type: 'in', location: INSIDE })).status).toBe(201);
    const mine = await request(app()).get('/api/v1/hr/attendance/me/punches').set(auth(a.token));
    expect(mine.body.items[0].location.lat).toBeCloseTo(INSIDE.lat, 3);
    const asMgr = await request(app()).get(`/api/v1/hr/attendance/punches?employeeId=${a.employeeId}`).set(auth(mgr.token));
    expect(asMgr.status).toBe(200);
    expect(asMgr.body.items).toHaveLength(1);
    expect(asMgr.body.items[0].location).toBeUndefined();
    expect(asMgr.body.items[0].withinGeofence).toBe(true);
    expect(asMgr.body.items[0].siteId).toBeTruthy();
    // Outside the team → not found, never revealed.
    expect((await request(app()).get(`/api/v1/hr/attendance/punches?employeeId=${other.employeeId}`).set(auth(mgr.token))).status).toBe(404);
    expect((await request(app()).get(`/api/v1/hr/attendance/days?employeeId=${other.employeeId}`).set(auth(mgr.token))).status).toBe(404);
    // HR sees the coordinates and the view is audited as sensitive (golden rule 4).
    const asHr = await request(app()).get(`/api/v1/hr/attendance/punches?employeeId=${a.employeeId}`).set(auth(hr));
    expect(asHr.body.items[0].location.lng).toBeCloseTo(INSIDE.lng, 3);
    expect(await AuditLog.countDocuments({ resource: 'hr.attendance', action: 'view', sensitive: true })).toBe(1);
    // The employee cannot read anyone else's punches.
    expect((await request(app()).get(`/api/v1/hr/attendance/punches?employeeId=${other.employeeId}`).set(auth(a.token))).status).toBe(404);
  });

  it('Q17: only HR enters a manual punch, with a reason, audited as sensitive', async () => {
    const { hr, mgr, a } = await setup();
    const day = recentWeekday(1);
    const body = { employeeId: a.employeeId, type: 'in', at: dayTime(day, '08:00').toISOString(), reason: 'تعطل الجهاز في الموقع' };
    expect((await request(app()).post('/api/v1/hr/attendance/punches/manual').set(auth(mgr.token)).send(body)).status).toBe(403);
    expect((await request(app()).post('/api/v1/hr/attendance/punches/manual').set(auth(a.token)).send(body)).status).toBe(403);
    const ok = await request(app()).post('/api/v1/hr/attendance/punches/manual').set(auth(hr)).send(body);
    expect(ok.status).toBe(201);
    expect(ok.body.punch.source).toBe('manual_hr');
    expect(ok.body.day.day).toBe(day);
    expect(await AuditLog.countDocuments({ resource: 'hr.attendance', action: 'create', sensitive: true })).toBe(1);
  });
});

describe('H2 §3.4 رابعاً — the computed day: lateness, absence, hours, overtime, leave, permission, holidays', () => {
  it('derives every status from the punches, the schedule, approved requests and holidays', async () => {
    const { hr, mgr, a } = await setup();
    const e = await emp(a.employeeId);
    const now = new Date();
    // On time: 07:55 → 16:05: present, 490 min, overtime 5 min floors to 0 (rounding 15).
    await insertPunch(a.employeeId, '2026-11-15', 'in', '07:55');
    await insertPunch(a.employeeId, '2026-11-15', 'out', '16:05');
    let d = await computeDay(e, '2026-11-15', now);
    expect(d).toMatchObject({ status: 'present', workedMinutes: 490, lateMinutes: 0, overtimeMinutes: 0, scheduled: true, final: true });
    // Within the grace (Q4: 10 min): present; beyond: late with the minutes past the start.
    await insertPunch(a.employeeId, '2026-11-16', 'in', '08:08');
    await insertPunch(a.employeeId, '2026-11-16', 'out', '16:00');
    expect((await computeDay(e, '2026-11-16', now)).status).toBe('present');
    await insertPunch(a.employeeId, '2026-11-17', 'in', '08:25');
    await insertPunch(a.employeeId, '2026-11-17', 'out', '15:30');
    d = await computeDay(e, '2026-11-17', now);
    expect(d).toMatchObject({ status: 'late', lateMinutes: 25, earlyLeaveMinutes: 30 });
    // No punches on a scheduled day → absent; check-in without check-out → missing_out, hours not counted (Q4).
    expect((await computeDay(e, '2026-11-18', now)).status).toBe('absent');
    await insertPunch(a.employeeId, '2026-11-19', 'in', '08:00');
    d = await computeDay(e, '2026-11-19', now);
    expect(d).toMatchObject({ status: 'missing_out', workedMinutes: 0 });
    // Friday → weekend; a holiday → holiday.
    expect((await computeDay(e, '2026-11-20', now)).status).toBe('weekend');
    await Holiday.create({ date: '2026-11-22', nameAr: 'عطلة تجريبية' });
    expect((await computeDay(e, '2026-11-22', now)).status).toBe('holiday');

    // An approved permission 08:00–10:00 excuses a 09:50 arrival [HR §3.5.2].
    const perm = await hrReq(a.token, 'permission', { date: '2026-11-23', startTime: '08:00', endTime: '10:00', reason: 'موعد' });
    expect(perm.status).toBe(201);
    await act(mgr.token, perm.body._id, 'approve');
    expect((await act(hr, perm.body._id, 'approve')).body.state).toBe('approved');
    await insertPunch(a.employeeId, '2026-11-23', 'in', '09:50');
    await insertPunch(a.employeeId, '2026-11-23', 'out', '16:00');
    d = await computeDay(e, '2026-11-23', now);
    expect(d).toMatchObject({ status: 'present', lateMinutes: 0, permissionMinutes: 120 });

    // Overtime: counted only from approved minutes actually worked (Q5); unapproved stays a flag.
    const otDay = today();
    await insertPunch(a.employeeId, '2026-11-24', 'in', '08:00');
    await insertPunch(a.employeeId, '2026-11-24', 'out', '18:10');
    d = await computeDay(e, '2026-11-24', new Date(dayTime('2026-11-25', '12:00')));
    expect(d).toMatchObject({ overtimeMinutes: 120, overtimeApprovedMinutes: 0 });
    expect(d.flags).toContain('overtime_unapproved');
    const ot = await hrReq(a.token, 'overtime', { day: otDay, startTime: '16:00', endTime: '18:00', reason: 'فرز شحنة' });
    expect(ot.status).toBe(201);
    // Q16: the direct manager's approval is final — HR is not in the route.
    const approved = await act(mgr.token, ot.body._id, 'approve');
    expect(approved.body.state).toBe('approved');
    expect(approved.body.handoff).toBeFalsy();
    const queue = await request(app()).get('/api/v1/hr/requests?view=queue').set(auth(hr));
    expect(queue.body.items.map((i: { type: string }) => i.type)).not.toContain('overtime');
    await insertPunch(a.employeeId, otDay, 'in', '08:00');
    await insertPunch(a.employeeId, otDay, 'out', '18:10');
    d = await computeDay(e, otDay, new Date(dayTime(addDays(otDay, 1), '12:00')));
    expect(d.overtimeApprovedMinutes).toBe(120);
    expect(String(d.overtimeRequestId)).toBe(ot.body._id);
    // A past-day overtime request is refused (pre-approval, Q5).
    expect((await hrReq(a.token, 'overtime', { day: addDays(today(), -5), startTime: '16:00', endTime: '17:00', reason: 'سبب تجريبي' })).status).toBe(400);
  });

  it('approved leave marks the days on_leave and writes the ledger; approved remote work marks them remote', async () => {
    const { hr, mgr, a } = await setup();
    const e = await emp(a.employeeId);
    await LeaveLedger.create({ employeeId: a.employeeId, leaveType: 'annual', entryType: 'opening', days: 21, year: 2026, effectiveAt: new Date('2026-01-01'), refType: 'test', refId: 'open' });
    const lv = await hrReq(a.token, 'leave', { leaveType: 'annual', startDate: '2026-11-15', endDate: '2026-11-17', reason: 'إجازة' });
    expect(lv.status).toBe(201);
    expect(lv.body.flags).toEqual([]);
    await act(mgr.token, lv.body._id, 'approve');
    expect((await act(hr, lv.body._id, 'approve')).body.state).toBe('approved');
    expect(await balance(a.employeeId, 'annual', 2026)).toBe(18);
    // Approving twice can never write the taken row twice (unique ref key).
    expect(await LeaveLedger.countDocuments({ employeeId: a.employeeId, entryType: 'taken' })).toBe(1);
    const d = await AttendanceDay.findOne({ employeeId: a.employeeId, day: '2026-11-16' }).lean();
    expect(d).toMatchObject({ status: 'on_leave', leaveType: 'annual' });
    expect(String(d!.leaveRequestId)).toBe(lv.body._id);
    // Remote work → an exception row with scope remote; the day is «عمل عن بُعد» (HR_PLAN §10.5).
    const rw = await hrReq(a.token, 'remote_work', { startDate: '2026-11-22', days: 2, reason: 'صيانة المنزل' });
    await act(mgr.token, rw.body._id, 'approve');
    expect((await act(hr, rw.body._id, 'approve')).body.state).toBe('approved');
    expect(await AttendanceException.findOne({ requestId: rw.body._id }).lean()).toMatchObject({ scope: 'remote', fromDay: '2026-11-22', toDay: '2026-11-23' });
    expect((await computeDay(e, '2026-11-23')).status).toBe('remote');
  });

  it('a correction request inserts the punch on approval and the day is recomputed; validations follow Q6', async () => {
    const { hr, mgr, a } = await setup();
    const e = await emp(a.employeeId);
    const day = recentWeekday(1);
    await insertPunch(a.employeeId, day, 'in', '08:00');
    expect((await computeDay(e, day)).status).toBe('missing_out');
    // Validations: future day, beyond the deadline, wrong_time without a punch.
    expect((await hrReq(a.token, 'attendance_correction', { day: addDays(today(), 1), kind: 'missing_out', requestedTime: '16:00', reason: 'سبب تجريبي' })).status).toBe(400);
    expect((await hrReq(a.token, 'attendance_correction', { day: addDays(today(), -12), kind: 'missing_out', requestedTime: '16:00', reason: 'سبب تجريبي' })).status).toBe(400);
    expect((await hrReq(a.token, 'attendance_correction', { day, kind: 'wrong_time', requestedTime: '16:00', reason: 'سبب تجريبي' })).status).toBe(400);
    const c = await hrReq(a.token, 'attendance_correction', { day, kind: 'missing_out', requestedTime: '16:10', reason: 'نسيت تسجيل الانصراف' });
    expect(c.status).toBe(201);
    expect(c.body.state).toBe('awaiting_manager');
    expect((await act(mgr.token, c.body._id, 'approve')).body.state).toBe('awaiting_hr');
    expect((await act(hr, c.body._id, 'approve')).body.state).toBe('approved');
    const inserted = await AttendancePunch.findOne({ correctionRequestId: c.body._id }).lean();
    expect(inserted).toMatchObject({ type: 'out', source: 'correction', day });
    expect(await AttendancePunch.countDocuments({ employeeId: a.employeeId, day })).toBe(2); // the original stays
    const d = await AttendanceDay.findOne({ employeeId: a.employeeId, day }).lean();
    expect(d).toMatchObject({ status: 'present', workedMinutes: 490 });
    expect(d!.flags).toContain('corrected');
    // wrong_time: the new punch supersedes the old one in the computation; the old row is never edited.
    const wrongIn = await AttendancePunch.findOne({ employeeId: a.employeeId, day, type: 'in' }).lean();
    const w = await hrReq(a.token, 'attendance_correction', { day, kind: 'wrong_time', punchId: String(wrongIn!._id), requestedTime: '07:30', reason: 'سجلت متأخراً بسبب الشبكة' });
    expect(w.status).toBe(201);
    // Q6: the second correction this month is beyond the limit of 1 → flagged for HR, not refused.
    await setSetting('hr.attendance.correction', { deadlineDays: 7, perMonth: 1 }, SYSTEM_ACTOR);
    const third = await hrReq(a.token, 'attendance_correction', { day, kind: 'missing_in', requestedTime: '07:00', reason: 'سبب تجريبي' });
    expect(third.status).toBe(201);
    expect(third.body.flags).toContain('corrections_limit');
    await act(mgr.token, w.body._id, 'approve');
    await act(hr, w.body._id, 'approve');
    const after = await AttendanceDay.findOne({ employeeId: a.employeeId, day }).lean();
    expect(after!.workedMinutes).toBe(520);
    expect(await AttendancePunch.countDocuments({ _id: wrongIn!._id })).toBe(1);
    // Corrections appear in the «طلبات تعديل البصمة» report.
    const rep = await request(app()).post('/api/v1/export').set(auth(hr)).send({ resource: 'hr.corrections', fields: ['number', 'day', 'kindAr', 'stateAr'], filters: { from: addDays(today(), -10), to: today() }, format: 'preview', limit: 50 });
    expect(rep.status).toBe(200);
    expect(rep.body.total).toBe(3);
  });

  it('the frequent job computes the days and reminds the employee once of a missed check-in or check-out, business days only', async () => {
    const { a } = await setup();
    // Sunday 2026-11-15 09:00 Riyadh: a has no punch → one reminder; a second run adds none.
    const nine = dayTime('2026-11-15', '09:00');
    const r1 = await runAttendanceCompute(nine);
    expect(r1.alerts).toBe(4); // mgr, a, b, other — nobody checked in
    expect(await runAttendanceCompute(new Date(nine.getTime() + 10 * 60_000))).toMatchObject({ alerts: 0 });
    const notes = await Notification.find({ userId: a.userId, type: 'attendance.missed_punch' }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0].link).toBe('/me/attendance');
    expect(notes[0].bodyAr).toContain('لم تسجّل حضورك');
    // Before the alert offset (08:20 < 08:30) nothing is sent; on a Friday nothing is sent either.
    await Notification.deleteMany({});
    await AttendanceDay.deleteMany({});
    expect((await runAttendanceCompute(dayTime('2026-11-15', '08:20'))).alerts).toBe(0);
    expect((await runAttendanceCompute(dayTime('2026-11-20', '12:00'))).alerts).toBe(0);
    // Checked in, never out: 17:30 (end 16:00 + 60 min) → one reminder about the check-out.
    await insertPunch(a.employeeId, '2026-11-16', 'in', '08:00');
    const r3 = await runAttendanceCompute(dayTime('2026-11-16', '17:30'));
    expect(r3.alerts).toBe(1); // a: missed check-out; the others are absent by now (no check-in by the shift end), not reminded again
    expect((await Notification.findOne({ userId: a.userId, type: 'attendance.missed_punch' }).lean())!.bodyAr).toContain('انصرافك');
    expect((await runAttendanceCompute(dayTime('2026-11-16', '18:30'))).alerts).toBe(0);
  });
});

describe('H2 §3.5.1 — leave balances (ledger) and the Q7 rules', () => {
  it('opening balances, over-balance refusal for annual leave, flags for others, event rules, accrual job, roles', async () => {
    const { hr, mgr, a, b, other } = await setup();
    // Without any ledger row the request is flagged for HR, not refused (balances not loaded yet).
    const unset = await hrReq(a.token, 'leave', { leaveType: 'annual', startDate: '2026-12-01', endDate: '2026-12-03', reason: 'سبب تجريبي' });
    expect(unset.status, JSON.stringify(unset.body)).toBe(201);
    expect(unset.body.flags).toContain('leave_balance_unset');
    // HR enters an opening balance (audited); the employee sees it.
    const open = await request(app()).post('/api/v1/hr/leave/balances').set(auth(hr)).send({ employeeId: a.employeeId, leaveType: 'annual', entryType: 'opening', days: 2, year: 2026, note: 'رصيد افتتاحي من ERPNext' });
    expect(open.status).toBe(201);
    expect((await request(app()).post('/api/v1/hr/leave/balances').set(auth(a.token)).send({ employeeId: a.employeeId, leaveType: 'annual', entryType: 'opening', days: 99, year: 2026, note: 'x' })).status).toBe(403);
    const me = await request(app()).get('/api/v1/hr/leave/me?year=2026').set(auth(a.token));
    const annual = me.body.balances.find((x: { leaveType: string }) => x.leaveType === 'annual');
    expect(annual).toMatchObject({ balance: 2, entitlementDays: 21, provisional: true, labelAr: 'سنوية' });
    // Annual over the balance → refused (Q7); sick over → flagged; unpaid → allowed.
    const over = await hrReq(a.token, 'leave', { leaveType: 'annual', startDate: '2026-12-10', endDate: '2026-12-14', reason: 'سبب تجريبي' });
    expect(over.status).toBe(400);
    expect(over.body.error.details.code).toBe('over_balance');
    await LeaveLedger.create({ employeeId: a.employeeId, leaveType: 'sick', entryType: 'opening', days: 1, year: 2026, effectiveAt: new Date(), refType: 'test', refId: 's' });
    const sick = await hrReq(a.token, 'leave', { leaveType: 'sick', startDate: '2026-12-10', endDate: '2026-12-14', reason: 'سبب تجريبي' });
    expect(sick.status).toBe(201);
    expect(sick.body.flags).toEqual(expect.arrayContaining(['over_balance', 'attachment_missing']));
    // 2025 amendments: birth leave needs the event date and must start within 7 days; maternity covers 6 weeks after the birth.
    expect((await hrReq(b.token, 'leave', { leaveType: 'newborn', startDate: '2026-12-01', endDate: '2026-12-03', reason: 'سبب تجريبي' })).status).toBe(400);
    expect((await hrReq(b.token, 'leave', { leaveType: 'newborn', startDate: '2026-12-10', endDate: '2026-12-12', eventDate: '2026-12-01', reason: 'سبب تجريبي' })).status).toBe(400);
    expect((await hrReq(b.token, 'leave', { leaveType: 'newborn', startDate: '2026-12-05', endDate: '2026-12-07', eventDate: '2026-12-01', reason: 'سبب تجريبي' })).status).toBe(201);
    expect((await hrReq(b.token, 'leave', { leaveType: 'maternity', startDate: '2026-12-01', endDate: '2026-12-20', eventDate: '2026-12-01', reason: 'سبب تجريبي' })).status).toBe(400);
    expect((await hrReq(b.token, 'leave', { leaveType: 'maternity', startDate: '2026-11-25', endDate: '2027-02-10', eventDate: '2026-12-01', reason: 'سبب تجريبي' })).status).toBe(201);
    expect((await hrReq(b.token, 'leave', { leaveType: 'marriage', startDate: '2026-12-01', endDate: '2026-12-07', reason: 'سبب تجريبي' })).status).toBe(400); // 7 > 5
    // Import by employee number: unknown numbers are skipped, duplicates too.
    const empA = await emp(a.employeeId);
    const imp = await request(app()).post('/api/v1/hr/leave/balances/import').set(auth(hr)).send({ year: 2026, rows: [{ employeeNumber: empA.employeeNumber, leaveType: 'hajj', days: 15 }, { employeeNumber: 'EMP-0000-99999', leaveType: 'annual', days: 5 }] });
    expect(imp.body).toMatchObject({ inserted: 1 });
    expect(imp.body.skipped).toEqual([{ employeeNumber: 'EMP-0000-99999', reason: 'employee_not_found' }]);
    // Accrual job: 21/12 for annual this month, the yearly sick entitlement; a second run adds nothing.
    const n1 = await runLeaveAccrual(new Date());
    expect(n1).toBeGreaterThan(0);
    expect(await runLeaveAccrual(new Date())).toBe(0);
    const accrual = await LeaveLedger.findOne({ employeeId: a.employeeId, leaveType: 'annual', entryType: 'accrual' }).lean();
    expect(accrual!.days).toBe(1.75);
    expect((await LeaveLedger.findOne({ employeeId: a.employeeId, leaveType: 'sick', entryType: 'accrual' }).lean())!.days).toBe(120);
    // The manager lists the team's balances only; the balances report lists them for HR.
    const team = await request(app()).get('/api/v1/hr/leave/balances?year=2026').set(auth(mgr.token));
    const ids = team.body.items.map((i: { employee: { _id: string } }) => i.employee._id);
    expect(ids).toEqual(expect.arrayContaining([a.employeeId, b.employeeId]));
    expect(ids).not.toContain(other.employeeId);
    expect((await request(app()).get(`/api/v1/hr/leave/ledger?employeeId=${other.employeeId}`).set(auth(mgr.token))).status).toBe(404);
    const rep = await request(app()).post('/api/v1/export').set(auth(hr)).send({ resource: 'hr.leave_balances', fields: ['fullNameAr', 'leaveTypeAr', 'balance', 'provisionalAr'], filters: { year: 2026, leaveType: 'annual' }, format: 'preview', limit: 50 });
    expect(rep.status).toBe(200);
    expect(rep.body.total).toBe(4);
  });
});

describe('H2 §3.4 خامساً — reports, dashboard cards, provisional settings, API document', () => {
  it('the eight reports are export resources scoped like the rest; the dashboard counts the period; settings carry the provisional flag', async () => {
    const { hr, mgr, a, b, other } = await setup();
    const e = await emp(a.employeeId);
    await insertPunch(a.employeeId, '2026-11-15', 'in', '08:30');
    await insertPunch(a.employeeId, '2026-11-15', 'out', '16:00');
    await insertPunch(b.employeeId, '2026-11-15', 'in', '08:00');
    await insertPunch(b.employeeId, '2026-11-15', 'out', '16:30');
    await computeDay(e, '2026-11-15');
    await computeDay(await emp(b.employeeId), '2026-11-15');
    await computeDay(await emp(other.employeeId), '2026-11-16'); // absent
    const resources = await request(app()).get('/api/v1/export/resources').set(auth(hr));
    const codes = resources.body.items.map((r: { resource: string }) => r.resource);
    for (const r of ['hr.attendance_log', 'hr.lateness_log', 'hr.absence_log', 'hr.hours_overtime', 'hr.corrections', 'hr.attendance_monthly_employee', 'hr.attendance_totals', 'hr.leave_balances', 'hr.leave_taken'])
      expect(codes).toContain(r);
    const filters = { from: '2026-11-15', to: '2026-11-16' };
    const log = await request(app()).post('/api/v1/export').set(auth(hr)).send({ resource: 'hr.attendance_log', fields: ['fullNameAr', 'day', 'typeAr', 'at', 'withinAr'], filters, format: 'preview', limit: 50 });
    expect(log.status).toBe(200);
    expect(log.body.total).toBe(4);
    expect(log.body.header).toEqual(['الاسم', 'اليوم', 'العملية', 'الوقت', 'داخل النطاق']);
    const late = await request(app()).post('/api/v1/export').set(auth(hr)).send({ resource: 'hr.lateness_log', fields: ['fullNameAr', 'lateMinutes'], filters, format: 'preview', limit: 50 });
    expect(late.body.rows).toEqual([['عمر العنزي', 30]]);
    const absent = await request(app()).post('/api/v1/export').set(auth(hr)).send({ resource: 'hr.absence_log', fields: ['fullNameAr', 'day'], filters, format: 'preview', limit: 50 });
    expect(absent.body.total).toBeGreaterThanOrEqual(1);
    const monthly = await request(app()).post('/api/v1/export').set(auth(hr)).send({ resource: 'hr.attendance_monthly_employee', fields: ['fullNameAr', 'presentDays', 'lateDays', 'absentDays', 'workedHours'], filters, format: 'preview', limit: 50 });
    const rowA = monthly.body.rows.find((r: unknown[]) => r[0] === 'عمر العنزي');
    expect(rowA).toEqual(['عمر العنزي', 1, 1, 1, 7.5]);
    const totals = await request(app()).post('/api/v1/export').set(auth(hr)).send({ resource: 'hr.attendance_totals', fields: ['groupAr', 'employees', 'presentDays', 'absentDays'], filters: { ...filters, groupBy: 'department' }, format: 'preview', limit: 50 });
    expect(totals.body.rows[0][0]).toBe('التشغيل');
    expect(totals.body.rows[0][1]).toBe(4); // mgr, a, b, other (the HR user has no employee file)
    // A department manager exports the department only; a direct manager without that role reads the team on screen
    // but has no export right; an employee has none either (HR_PLAN §6).
    const { ops } = await (async () => ({ ops: (await Employee.findById(a.employeeId).lean())!.departmentId }))();
    await makeUser('dm@eayni.local', [{ role: 'employee' }, { role: 'department_manager', departmentId: String(ops) }], { departmentId: ops });
    const dm = await loginAs('dm@eayni.local');
    const dmRows = await request(app()).post('/api/v1/export').set(auth(dm)).send({ resource: 'hr.attendance_monthly_employee', fields: ['fullNameAr', 'presentDays'], filters, format: 'preview', limit: 50 });
    expect(dmRows.status).toBe(200);
    expect(dmRows.body.rows.map((r: unknown[]) => r[0]).sort()).toEqual(['خالد العنزي', 'راشد العنزي', 'عمر العنزي', 'فهد العنزي']);
    expect((await request(app()).post('/api/v1/export').set(auth(mgr.token)).send({ resource: 'hr.attendance_monthly_employee', fields: ['fullNameAr'], filters, format: 'preview', limit: 5 })).status).toBe(403);
    expect((await request(app()).post('/api/v1/export').set(auth(a.token)).send({ resource: 'hr.attendance_log', fields: ['day'], filters, format: 'preview', limit: 5 })).status).toBe(403);

    // Dashboard cards [HR §5 ثانياً] for the period; drill-down list accepts the same filters.
    const dash = await request(app()).get('/api/v1/hr/dashboard/hr?from=2026-11-15&to=2026-11-16').set(auth(hr));
    expect(dash.body.attendance).toMatchObject({ late: 1, absent: 6, onLeaveToday: 0 }); // the report run above computed every employee's two days
    expect(dash.body.attendance.workedMinutes).toBe(960);
    const days = await request(app()).get('/api/v1/hr/attendance/days?from=2026-11-15&to=2026-11-16&status=late').set(auth(hr));
    expect(days.body.items).toHaveLength(1);
    expect(days.body.items[0].employee.fullNameAr).toBe('عمر العنزي');
    // The manager's team view: the team's days, no coordinates involved.
    const teamDays = await request(app()).get('/api/v1/hr/attendance/days?from=2026-11-15&to=2026-11-15').set(auth(mgr.token));
    expect(teamDays.body.items.map((i: { employee: { fullNameAr: string } }) => i.employee.fullNameAr).sort()).toEqual(['خالد العنزي', 'راشد العنزي', 'عمر العنزي']);

    // Provisional settings (DECISIONS §21): flagged until an admin confirms; the policy endpoint mirrors it.
    await makeUser('admin@eayni.local', [{ role: 'employee' }, { role: 'system_admin' }]);
    const admin = await loginAs('admin@eayni.local');
    const settings = await request(app()).get('/api/v1/settings').set(auth(admin));
    const leavePol = settings.body.items.find((s: { key: string }) => s.key === 'hr.leave.policies');
    expect(leavePol.provisional).toBe(true);
    expect(settings.body.items.find((s: { key: string }) => s.key === 'hr.attendance.rules').provisional).toBe(false);
    let policy = await request(app()).get('/api/v1/hr/attendance/policy').set(auth(a.token));
    expect(policy.body.provisional).toEqual({ shift: true, geofence: true, leave: true });
    expect(policy.body.rules.graceMinutes).toBe(10);
    expect((await request(app()).post('/api/v1/settings/hr.leave.policies/confirm').set(auth(hr))).status).toBe(403);
    expect((await request(app()).post('/api/v1/settings/hr.leave.policies/confirm').set(auth(admin))).status).toBe(200);
    policy = await request(app()).get('/api/v1/hr/attendance/policy').set(auth(a.token));
    expect(policy.body.provisional.leave).toBe(false);
    expect(await AuditLog.countDocuments({ resource: 'settings', action: 'approve' })).toBe(1);

    // The employee's own screen.
    const mine = await request(app()).get('/api/v1/hr/attendance/me').set(auth(a.token));
    expect(mine.status).toBe(200);
    expect(mine.body.schedule).toMatchObject({ nameAr: 'الدوام الأساسي' });
    expect(mine.body.nextPunch).toBe('in');
    expect(mine.body.sites[0]).toMatchObject({ nameAr: 'موقع التشغيل الرئيسي', hasLocation: true, radiusM: 200 });
    const myDays = await request(app()).get('/api/v1/hr/attendance/me/days?from=2026-11-15&to=2026-11-16').set(auth(a.token));
    expect(myDays.body.summary).toMatchObject({ lateDays: 1, absentDays: 1 });

    // API document: the punch route is listed with its permission [HR §9.14].
    const doc = await request(app()).get('/api/v1/openapi.json').set(auth(admin));
    expect(doc.status).toBe(200);
    expect(doc.body.paths['/api/v1/hr/attendance/me/punch'].post['x-permission']).toBe('hr.attendance:create');
    expect(doc.body.paths['/api/v1/hr/shifts/assignments'].post['x-permission']).toBe('hr.shifts:create');
    expect(doc.body.paths['/api/v1/hr/leave/balances'].post['x-permission']).toBe('hr.leave:create');
    void Shift;
  });
});
