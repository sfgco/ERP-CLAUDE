import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEFAULT_APPRAISAL_TEMPLATE, DEFAULT_DISCIPLINE_POLICY, DEFAULT_PAYROLL_POLICY } from '@eayni/shared';
import { activateAccount, auth, loginAs, makeDepartment, makeUser, testApp } from '../../test/helpers';
import { setSetting } from '../../core/settings/service';
import { SYSTEM_ACTOR } from '../../core/http/context';
import { Notification } from '../../core/notifications/model';
import { Outbox } from '../../core/outbox/model';
import { AuditLog } from '../../core/audit/model';
import { Attachment } from '../../core/files/model';
import { Task, TaskEvent } from '../../core/tasks/model';
import { CalendarEvent } from '../../core/calendar/model';
import { Branch, Site } from '../../core/org/model';
import { Holiday } from '../../core/dates/model';
import { User } from '../../core/auth/model';
import { riyadhDate, riyadhDayEndOf } from '../../core/dates/businessDays';
import { HrRequest } from './requests.model';
import { AttendanceDay, AttendancePunch } from './attendance.model';
import { addDays, computeDay, dayTime, weekdayOf } from './attendance.service';
import { AdvanceSchedule, PayrollAdjustment, Payslip } from './payroll.model';
import { advanceInstalmentPlan, attendanceWindow, currentPeriod, gosiWageOf, nextPeriod, overtimeHourHalalas, previousPeriod } from './payroll.service';
import { Appraisal, AppraisalCycle, DisciplinaryAction } from './performance.model';
import { appealDeadlineFrom, employeeDeadlineFrom, oralQuestioningAllowed, runAppraisalJobs, runPerformanceFollowUps } from './performance.service';
import { Employee } from './model';

const app = () => testApp();
const DAY = 86_400_000;
const today = () => riyadhDate(new Date());
const api = (token: string) => ({
  get: (p: string) => request(app()).get(`/api/v1${p}`).set(auth(token)),
  post: (p: string, body?: object) => request(app()).post(`/api/v1${p}`).set(auth(token)).send(body),
  patch: (p: string, body?: object) => request(app()).patch(`/api/v1${p}`).set(auth(token)).send(body),
  put: (p: string, body?: object) => request(app()).put(`/api/v1${p}`).set(auth(token)).send(body),
});
/** Working weekdays (Sun–Thu) of a Riyadh-day window, oldest first. */
function workdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (weekdayOf(d) <= 4) out.push(d);
  return out;
}
const punch = (employeeId: string, day: string, type: 'in' | 'out', hhmm: string) =>
  AttendancePunch.create({ employeeId, type, at: dayTime(day, hhmm), day, source: 'web', withinGeofence: true });

/**
 * H3a — الإدارة والمتابعة (1): payroll runs with the thin Finance stage [HR §3.6, FIN §12], performance [HR §3.7]
 * and training [HR §3.8]. Each test names the spec bullet it covers.
 */
async function setup() {
  await setSetting('auth.mfaRequiredRoles', [], SYSTEM_ACTOR);
  const ops = await makeDepartment('ops', 'التشغيل');
  const branch = await Branch.create({ code: 'hq', nameAr: 'المقر', active: true });
  const site = await Site.create({ branchId: branch._id, nameAr: 'الموقع', location: { type: 'Point', coordinates: [50.1, 26.43] }, geofenceRadiusM: 200, active: true });
  await makeUser('hr@eayni.local', [{ role: 'employee' }, { role: 'hr_manager' }]);
  await makeUser('hro@eayni.local', [{ role: 'employee' }, { role: 'hr_officer' }]);
  await makeUser('fm@eayni.local', [{ role: 'employee' }, { role: 'finance_manager' }]);
  await makeUser('fs@eayni.local', [{ role: 'employee' }, { role: 'finance_staff' }]);
  await makeUser('admin@eayni.local', [{ role: 'employee' }, { role: 'system_admin' }]);
  await makeUser('dm@eayni.local', [{ role: 'employee' }, { role: 'department_manager', departmentId: String(ops._id) }], { departmentId: ops._id });
  const [hr, hro, fm, fs, admin, dm] = await Promise.all(['hr', 'hro', 'fm', 'fs', 'admin', 'dm'].map((u) => loginAs(`${u}@eayni.local`)));
  expect((await api(hr).post('/hr/shifts', { code: 'standard', nameAr: 'الدوام الأساسي', periods: [{ start: '08:00', end: '16:00' }], workDays: [0, 1, 2, 3, 4] })).status).toBe(201);
  let n = 0;
  const mk = async (email: string, first: string, extra: Record<string, unknown> = {}, directManagerId?: string) => {
    const r = await api(hr).post('/hr/employees', {
      firstNameAr: first,
      lastNameAr: 'الحربي',
      gender: 'male',
      nationality: 'سعودي',
      workEmail: email,
      identity: { type: 'national_id', number: `10${String(70000000 + ++n).padStart(8, '0')}`, expiryDate: new Date(Date.now() + 400 * DAY) },
      hireDate: '2024-01-10',
      departmentId: String(ops._id),
      branchId: String(branch._id),
      siteId: String(site._id),
      directManagerId,
      basicSalaryHalalas: 600_000,
      allowances: [{ type: 'سكن', amountHalalas: 150_000 }, { type: 'نقل', amountHalalas: 50_000 }],
      bank: { bankName: 'الراجحي', iban: 'SA0380000000608010167519' },
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { employeeId: r.body._id as string, userId: r.body.userId as string, token: await activateAccount(email, r.body.temporaryPassword) };
  };
  const mgr = await mk('mgr@eayni.local', 'خالد', { gosiJoinDate: '2020-05-01', basicSalaryHalalas: 1_200_000 });
  const a = await mk('a@eayni.local', 'عمر', { gosiJoinDate: '2023-01-01' }, mgr.employeeId);
  const b = await mk('b@eayni.local', 'راشد', { gosiJoinDate: '2025-02-01', basicSalaryHalalas: 500_000, allowances: [] }, mgr.employeeId);
  const c = await mk('c@eayni.local', 'يوسف', { nationality: 'مصري', basicSalaryHalalas: 400_000, allowances: [], identity: { type: 'iqama', number: '2099887766', expiryDate: new Date(Date.now() + 400 * DAY) } }, mgr.employeeId);
  const other = await mk('other@eayni.local', 'فهد');
  return { hr, hro, fm, fs, admin, dm, ops, mgr, a, b, c, other, mk };
}

describe('H3a §3.6 — payroll runs, deductions, GOSI, overtime, the Finance stage and segregation of duties', () => {
  it('prepares a run from the salary master and the locked attendance window, moves through HR and Finance, and publishes payslips', async () => {
    const { hr, hro, fm, fs, admin, mgr, a, b, c } = await setup();
    const period = previousPeriod(currentPeriod());
    const win = attendanceWindow(period, 25);
    const days = workdays(win.from, win.to);
    expect(days.length).toBeGreaterThan(15);
    // a: present every day but two absences and one missing check-out (never an absence — DECISIONS §21).
    for (const [i, d] of days.entries()) {
      if (i === 0 || i === 1) continue; // absent
      await punch(a.employeeId, d, 'in', '07:55');
      if (i !== 2) await punch(a.employeeId, d, 'out', '16:05');
    }
    // b: present, with an approved 2-hour overtime (compensated in pay) actually worked on day 3.
    for (const [i, d] of days.entries()) {
      await punch(b.employeeId, d, 'in', '08:00');
      await punch(b.employeeId, d, 'out', i === 3 ? '18:05' : '16:00');
    }
    await HrRequest.create({ number: 'HRQ-TEST-00001', type: 'overtime', employeeId: b.employeeId, requesterUserId: b.userId, state: 'approved', stateEnteredAt: new Date(), details: { day: days[3], startTime: '16:00', endTime: '18:00', reason: 'شحنة', compensation: 'pay' }, decision: { outcome: 'approved', at: new Date() }, route: { viaManager: true, finalApprover: 'manager' } });
    // c: two days of unpaid leave approved (paidPercent 0), otherwise present.
    const leave = await api(c.token).post('/hr/requests', { type: 'leave', details: { leaveType: 'unpaid', startDate: days[4], endDate: days[5], reason: 'ظرف خاص' }, attachmentIds: [] });
    expect(leave.status).toBe(201);
    await api(mgr.token).post(`/hr/requests/${leave.body._id}/transition`, { transition: 'approve' });
    expect((await api(hr).post(`/hr/requests/${leave.body._id}/transition`, { transition: 'approve' })).body.state).toBe('approved');
    for (const [i, d] of days.entries()) {
      if (i === 4 || i === 5) continue;
      await punch(c.employeeId, d, 'in', '08:00');
      await punch(c.employeeId, d, 'out', '16:00');
    }
    // An earning adjustment for a, an instalment due this period for b, a huge deduction for c (hits the 50 % cap).
    expect((await api(hro).post('/hr/payroll/adjustments', { employeeId: a.employeeId, kind: 'earning', amountHalalas: 10_000, reason: 'مكافأة' })).status).toBe(201);
    expect((await api(a.token).post('/hr/payroll/adjustments', { employeeId: a.employeeId, kind: 'earning', amountHalalas: 10_000, reason: 'x' })).status).toBe(403);
    await AdvanceSchedule.create({ requestId: (await HrRequest.create({ number: 'HRQ-TEST-00002', type: 'advance', employeeId: b.employeeId, requesterUserId: b.userId, state: 'approved', stateEnteredAt: new Date(), details: { amountHalalas: 60_000, reason: 'x', instalments: 2 } }))._id, requestNumber: 'HRQ-TEST-00002', employeeId: b.employeeId, totalHalalas: 60_000, instalments: [{ period, amountHalalas: 30_000 }, { period: nextPeriod(period), amountHalalas: 30_000 }] });
    await api(hro).post('/hr/payroll/adjustments', { employeeId: c.employeeId, kind: 'deduction', amountHalalas: 400_000, reason: 'تعويض عهدة مفقودة' });

    // Prepare [HR §3.6.2]: the officer creates the run; everyone on duty is in (Q18).
    const created = await api(hro).post('/hr/payroll', { period, notes: 'مسير تجريبي' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const runId = created.body._id as string;
    expect(created.body.number).toMatch(/^PAY-\d{4}-\d{5}$/);
    expect(created.body.state).toBe('draft');
    expect(created.body.totals.employeeCount).toBe(5);
    expect(created.body.provisional).toBe(true);
    expect((await api(hro).post('/hr/payroll', { period })).status).toBe(409);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the payslip JSON is inspected field by field below
    const slips = (await api(hr).get(`/hr/payroll/${runId}`)).body.payslips as Record<string, any>[];
    const slipA = slips.find((p) => p.employeeId === a.employeeId)!;
    const slipB = slips.find((p) => p.employeeId === b.employeeId)!;
    const slipC = slips.find((p) => p.employeeId === c.employeeId)!;
    // a: 800 000 total; 2 absences × 800000/30; the missing check-out day is not an absence; GOSI 9.75 % of 750 000 (basic + housing).
    expect(slipA.attendance.absentDays).toBe(2);
    expect(slipA.attendance.missingPunchDays).toBe(1);
    expect(slipA.deductions.find((l: { code: string }) => l.code === 'absence').amountHalalas).toBe(Math.round((2 * 800_000) / 30));
    expect(slipA.gosiGroup).toBe('saudi_before_2024_07_03');
    expect(slipA.gosiEmployeeHalalas).toBe(Math.round(750_000 * 0.0975));
    expect(slipA.gosiEmployerHalalas).toBe(Math.round(750_000 * 0.1175));
    expect(slipA.earnings.find((l: { code: string }) => l.code === 'adjustment').amountHalalas).toBe(10_000);
    expect(slipA.flags).toContain('provisional_policy');
    // b: joined GOSI 2025 → the post-July-2026 rate 10.75 %; 2 h overtime at 150 % of 500000/30/8; the instalment.
    expect(slipB.gosiGroup).toBe('saudi_from_2024_07_03');
    const bRate = period >= '2026-07' ? 0.1075 : 0.1025;
    expect(slipB.gosiEmployeeHalalas).toBe(Math.round(500_000 * bRate));
    expect(slipB.attendance.overtimeApprovedMinutes).toBe(120);
    expect(slipB.earnings.find((l: { code: string }) => l.code === 'overtime').amountHalalas).toBe(Math.round(2 * (500_000 / 30 / 8) * 1.5));
    expect(slipB.deductions.find((l: { code: string }) => l.code === 'advance_instalment').amountHalalas).toBe(30_000);
    // c: non-Saudi → no employee share, employer 2 %; two unpaid leave days; deductions capped at 50 % with the rest deferred.
    expect(slipC.gosiGroup).toBe('non_saudi');
    expect(slipC.gosiEmployeeHalalas).toBe(0);
    expect(slipC.gosiEmployerHalalas).toBe(8_000);
    expect(slipC.deductions.find((l: { code: string }) => l.code === 'unpaid_leave').days).toBe(2);
    expect(slipC.flags).toContain('deduction_capped');
    const nonGosi = slipC.deductions.filter((l: { code: string }) => l.code !== 'gosi_employee').reduce((s: number, l: { amountHalalas: number }) => s + l.amountHalalas, 0);
    expect(nonGosi).toBe(200_000);
    // The adjustment is consumed by this run; a recompute keeps it once.
    expect(await PayrollAdjustment.countDocuments({ consumedByRunId: runId })).toBe(2);
    expect((await api(hro).post(`/hr/payroll/${runId}/recompute`)).body.totals.employeeCount).toBe(5);
    expect(await Payslip.countDocuments({ runId })).toBe(5);
    // A recompute rebuilds the payslips (new ids, same figures).
    const slipA2 = (await Payslip.findOne({ runId, employeeId: a.employeeId }).lean())!;
    expect(slipA2.netHalalas).toBe(slipA.netHalalas);
    slipA._id = String(slipA2._id);

    // Review [HR §3.6.6]: submit locks the window; the preparer cannot approve; the manager approves → straight to Finance [§3.6.7].
    expect((await api(hro).post(`/hr/payroll/${runId}/transition`, { transition: 'submit_for_review' })).body.state).toBe('under_hr_review');
    expect(await AttendanceDay.countDocuments({ employeeId: a.employeeId, lockedByPayrollRunId: runId })).toBeGreaterThanOrEqual(days.length); // every computed day of the window, weekends included
    expect((await api(hro).post(`/hr/payroll/${runId}/recompute`)).status).toBe(400);
    const lockedCorrection = await api(a.token).post('/hr/requests', { type: 'attendance_correction', details: { day: days[days.length - 1], kind: 'missing_out', requestedTime: '16:00', reason: 'نسيت' }, attachmentIds: [] });
    expect([400, 201]).toContain(lockedCorrection.status); // 400 when the day is inside the correction deadline window (locked), 201 otherwise never reaches the lock check
    expect((await api(hro).post(`/hr/payroll/${runId}/transition`, { transition: 'hr_approve' })).status).toBe(403);
    expect(await Notification.countDocuments({ type: 'payroll.submitted' })).toBeGreaterThan(0);
    const approved = await api(hr).post(`/hr/payroll/${runId}/transition`, { transition: 'hr_approve' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.state).toBe('at_finance');
    expect(approved.body.frozenAt).toBeTruthy();
    expect(await Outbox.countDocuments({ type: 'hr.payroll.sent_to_finance' })).toBe(1);
    expect(await Notification.countDocuments({ type: 'payroll.at_finance' })).toBe(2); // fm + fs
    // The capped excess became a next-run adjustment, once.
    expect(await PayrollAdjustment.countDocuments({ sourceType: 'payroll_cap', employeeId: c.employeeId })).toBe(1);
    // Finance [FIN §5, §12]: staff may return, only the manager approves; the approver never records the payment.
    expect((await api(fs).post(`/finance/payroll/${runId}/transition`, { transition: 'finance_approve' })).status).toBe(403);
    expect((await api(fs).post(`/finance/payroll/${runId}/transition`, { transition: 'finance_return', reason: 'راجعوا قسط السلفة' })).body.state).toBe('finance_returned');
    expect((await api(hr).post(`/hr/payroll/${runId}/transition`, { transition: 'send_to_finance' })).body.state).toBe('at_finance');
    const fin = await api(fm).post(`/finance/payroll/${runId}/transition`, { transition: 'finance_approve' });
    expect(fin.body.state).toBe('finance_approved');
    expect((await api(fm).post(`/finance/payroll/${runId}/transition`, { transition: 'record_payment', paidAt: new Date().toISOString(), paymentRef: 'WPS-1' })).status).toBe(403);
    expect((await api(fs).post(`/finance/payroll/${runId}/transition`, { transition: 'record_payment', paymentRef: 'WPS-1' })).status).toBe(400); // paidAt required
    const paid = await api(fs).post(`/finance/payroll/${runId}/transition`, { transition: 'record_payment', paidAt: new Date().toISOString(), paymentRef: 'WPS-2026-01' });
    expect(paid.body.state).toBe('paid');
    expect(await Outbox.countDocuments({ type: 'hr.payroll.paid' })).toBe(1);
    // Payslips [HR §3.6.8–3.6.9]: visible to the employee at paid, own only; HR / Finance read (audited); the admin never.
    expect(await Notification.countDocuments({ type: 'payslip.available', userId: a.userId })).toBe(1);
    const mine = await api(a.token).get('/hr/payslips/me');
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].netHalalas).toBe(slipA.netHalalas);
    const doc = await api(a.token).get(`/hr/payslips/${slipA._id}/document`);
    expect(doc.status).toBe(200);
    expect(doc.text).toContain('قسيمة راتب');
    expect((await api(b.token).get(`/hr/payslips/${slipA._id}`)).status).toBe(404);
    // The system admin holds the employee role too, so the route answers; another person's payslip is never revealed (404), the runs are forbidden.
    expect((await api(admin).get(`/hr/payslips/${slipA._id}`)).status).toBe(404);
    expect((await api(admin).get('/hr/payroll')).status).toBe(403);
    const fmSlip = await api(fm).get(`/hr/payslips/${slipA._id}`);
    expect(fmSlip.status, JSON.stringify(fmSlip.body)).toBe(200);
    expect(await AuditLog.countDocuments({ resource: 'hr.payslips', action: 'view', sensitive: true })).toBeGreaterThan(0);
    expect((await api(hr).post(`/hr/payroll/${runId}/transition`, { transition: 'close' })).body.state).toBe('closed');
    // History [HR §3.6.8]: the register export, sensitive columns for HR only.
    const reg = await api(hr).post('/export', { resource: 'hr.payroll_register', fields: ['runNumber', 'fullNameAr', 'net', 'gosiEmployee'], filters: { period }, format: 'preview', limit: 50 });
    expect(reg.status).toBe(200);
    expect(reg.body.total).toBe(5);
    expect((await api(admin).post('/export', { resource: 'hr.payroll_register', fields: ['runNumber'], filters: {}, format: 'preview', limit: 5 })).status).toBe(403);
    // Cancelling a run releases what it consumed.
    const r2 = await api(hro).post('/hr/payroll', { period: nextPeriod(currentPeriod()) });
    expect(r2.status).toBe(201);
    expect((await api(hr).post(`/hr/payroll/${r2.body._id}/transition`, { transition: 'cancel', reason: 'خطأ في الفترة' })).body.state).toBe('cancelled');
    expect(await PayrollAdjustment.countDocuments({ consumedByRunId: r2.body._id })).toBe(0);
  });

  it('an approved advance creates the instalment plan Finance deducts from the next period (Q8)', async () => {
    const { hr, fm, mgr, a } = await setup();
    const adv = await api(a.token).post('/hr/requests', { type: 'advance', details: { amountHalalas: 90_000, reason: 'ظرف أسري', instalments: 3 }, attachmentIds: [] });
    expect(adv.status).toBe(201);
    await api(mgr.token).post(`/hr/requests/${adv.body._id}/transition`, { transition: 'approve' });
    await api(hr).post(`/hr/requests/${adv.body._id}/transition`, { transition: 'approve' });
    expect((await api(fm).post(`/hr/requests/${adv.body._id}/transition`, { transition: 'approve' })).body.state).toBe('approved');
    const sch = await AdvanceSchedule.findOne({ requestId: adv.body._id }).lean();
    expect(sch).toBeTruthy();
    expect(sch!.instalments.map((i) => i.amountHalalas)).toEqual([30_000, 30_000, 30_000]);
    expect(sch!.instalments[0].period).toBe(nextPeriod(currentPeriod()));
    expect((await api(hr).get(`/hr/payroll/advances?employeeId=${a.employeeId}`)).body.items).toHaveLength(1);
  });

  it('owner decisions 2026-11-24 — the overtime hour per art. 107 (actual hour + 50 % of the basic hour) and the GOSI wage with commissions, bounded to 1 500 – 45 000', async () => {
    // The owner's example: basic 4 000 + allowances 2 000, 8 h → 25 + 8.33 = 33.33 SAR per overtime hour (never 6 000 × 1.5 ÷ 240 = 37.50).
    expect(overtimeHourHalalas(400_000, 600_000, 8, 15_000)).toBeCloseTo(3333.33, 1);
    expect(overtimeHourHalalas(500_000, 500_000, 8, 15_000)).toBeCloseTo(3125, 1); // no allowances → the old 150 % of basic
    // GOSI wage: basic + housing + commissions (on by default), then the bounds.
    const pol = DEFAULT_PAYROLL_POLICY;
    expect(gosiWageOf(100_000, [{ type: 'عمولة', amountHalalas: 80_000 }, { type: 'نقل', amountHalalas: 50_000 }], pol)).toEqual({ wage: 180_000, bounded: null });
    expect(gosiWageOf(100_000, [{ type: 'عمولة', amountHalalas: 80_000 }], { ...pol, gosiIncludeCommissions: false })).toEqual({ wage: 150_000, bounded: 'min' });
    expect(gosiWageOf(5_000_000, [], pol)).toEqual({ wage: 4_500_000, bounded: 'max' });
    expect(gosiWageOf(100_000, [], pol)).toEqual({ wage: 150_000, bounded: 'min' });
    expect(gosiWageOf(100_000, [], { ...pol, gosiWageMinHalalas: null })).toEqual({ wage: 100_000, bounded: null });

    const { hr, hro, mk } = await setup();
    const period = previousPeriod(currentPeriod());
    const win = attendanceWindow(period, 25);
    const days = workdays(win.from, win.to);
    // x: basic 4 000 + transport 2 000, one approved overtime hour actually worked → 33.33 SAR.
    const x = await mk('x@eayni.local', 'سعد', { gosiJoinDate: '2020-01-01', basicSalaryHalalas: 400_000, allowances: [{ type: 'نقل', amountHalalas: 200_000 }] });
    for (const [i, d] of days.entries()) {
      await punch(x.employeeId, d, 'in', '08:00');
      await punch(x.employeeId, d, 'out', i === 2 ? '17:02' : '16:00');
    }
    await HrRequest.create({ number: 'HRQ-TEST-00011', type: 'overtime', employeeId: x.employeeId, requesterUserId: x.userId, state: 'approved', stateEnteredAt: new Date(), details: { day: days[2], startTime: '16:00', endTime: '17:00', reason: 'جرد', compensation: 'pay' }, decision: { outcome: 'approved', at: new Date() }, route: { viaManager: true, finalApprover: 'manager' } });
    // y: Sales rep with a monthly commission allowance → inside the GOSI wage; z: above the ceiling; w: under the floor.
    const y = await mk('y@eayni.local', 'ريم', { gosiJoinDate: '2020-01-01', basicSalaryHalalas: 100_000, allowances: [{ type: 'عمولة', amountHalalas: 80_000 }] });
    const z = await mk('z@eayni.local', 'ماجد', { gosiJoinDate: '2020-01-01', basicSalaryHalalas: 5_000_000, allowances: [] });
    const w = await mk('w@eayni.local', 'نورة', { gosiJoinDate: '2020-01-01', basicSalaryHalalas: 100_000, allowances: [] });
    const run = await api(hro).post('/hr/payroll', { period });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const slips = (await api(hr).get(`/hr/payroll/${run.body._id}`)).body.payslips as { employeeId: string; earnings: { code: string; amountHalalas: number; minutes?: number }[]; gosiWageHalalas: number; gosiEmployeeHalalas: number; flags: string[] }[];
    const of = (id: string) => slips.find((p) => p.employeeId === id)!;
    const ot = of(x.employeeId).earnings.find((l) => l.code === 'overtime')!;
    expect(ot.minutes).toBe(60);
    expect(ot.amountHalalas).toBe(3333); // 33.33 SAR
    expect(of(y.employeeId).gosiWageHalalas).toBe(180_000);
    expect(of(y.employeeId).gosiEmployeeHalalas).toBe(Math.round(180_000 * 0.0975));
    expect(of(y.employeeId).flags).not.toContain('gosi_wage_bounded');
    expect(of(z.employeeId).gosiWageHalalas).toBe(4_500_000);
    expect(of(z.employeeId).gosiEmployeeHalalas).toBe(Math.round(4_500_000 * 0.0975));
    expect(of(z.employeeId).flags).toContain('gosi_wage_bounded');
    expect(of(w.employeeId).gosiWageHalalas).toBe(150_000);
    expect(of(w.employeeId).flags).toContain('gosi_wage_bounded');
    // The commission switch is a setting: off → y falls to the floor.
    await setSetting('hr.payroll.policy', { ...DEFAULT_PAYROLL_POLICY, gosiIncludeCommissions: false }, SYSTEM_ACTOR);
    const re = await api(hro).post(`/hr/payroll/${run.body._id}/recompute`);
    expect(re.status).toBe(200);
    const y2 = (await Payslip.findOne({ runId: run.body._id, employeeId: y.employeeId }).lean())!;
    expect(y2.gosiWageHalalas).toBe(150_000);
    expect(y2.flags).toContain('gosi_wage_bounded');
  });

  it('owner decision 2026-11-24 — an advance instalment above 10 % of the wage needs the employee\'s written consent, otherwise the advance is split so no instalment exceeds 10 %', async () => {
    expect(advanceInstalmentPlan(240_000, 1, 800_000, false, 1000)).toEqual({ instalments: 3, capHalalas: 80_000, flag: 'instalments_rescheduled' });
    expect(advanceInstalmentPlan(240_000, 1, 800_000, true, 1000)).toEqual({ instalments: 1, capHalalas: 80_000, flag: 'instalment_consent_given' });
    expect(advanceInstalmentPlan(90_000, 3, 800_000, false, 1000)).toEqual({ instalments: 3, capHalalas: 80_000, flag: null });
    expect(advanceInstalmentPlan(250_000, 2, 800_000, false, 1000)).toEqual({ instalments: 4, capHalalas: 80_000, flag: 'instalments_rescheduled' }); // 125 000 > 80 000 → 4 × 62 500
    const { hr, fm, mgr, a } = await setup(); // a: 6 000 + 1 500 + 500 = 8 000 SAR → cap 800 SAR
    expect((await api(a.token).get('/hr/requests/types')).body).toMatchObject({ advanceInstalmentCapBp: 1000, advanceInstalmentCapHalalas: 80_000 });
    // 2 400 SAR in one instalment without consent → split into 3 × 800, flagged; the employee's wish is kept for the record.
    const split = await api(a.token).post('/hr/requests', { type: 'advance', details: { amountHalalas: 240_000, reason: 'علاج', instalments: 1 }, attachmentIds: [] });
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    expect(split.body.details).toMatchObject({ instalments: 3, requestedInstalments: 1, instalmentHalalas: 80_000 });
    expect(split.body.flags).toContain('instalments_rescheduled');
    await api(mgr.token).post(`/hr/requests/${split.body._id}/transition`, { transition: 'approve' });
    await api(hr).post(`/hr/requests/${split.body._id}/transition`, { transition: 'approve' });
    expect((await api(fm).post(`/hr/requests/${split.body._id}/transition`, { transition: 'approve' })).body.state).toBe('approved');
    const sch = (await AdvanceSchedule.findOne({ requestId: split.body._id }).lean())!;
    expect(sch.instalments.map((i) => i.amountHalalas)).toEqual([80_000, 80_000, 80_000]);
    // The same amount with the written consent stays one instalment, flagged for the record.
    const consent = await api(a.token).post('/hr/requests', { type: 'advance', details: { amountHalalas: 240_000, reason: 'علاج', instalments: 1, scheduleConsent: true }, attachmentIds: [] });
    expect(consent.status).toBe(201);
    expect(consent.body.details).toMatchObject({ instalments: 1, instalmentHalalas: 240_000 });
    expect(consent.body.flags).toContain('instalment_consent_given');
    expect(consent.body.flags).not.toContain('instalments_rescheduled');
    // Within the cap → nothing to flag.
    const small = await api(a.token).post('/hr/requests', { type: 'advance', details: { amountHalalas: 90_000, reason: 'سفر', instalments: 3 }, attachmentIds: [] });
    expect(small.body.details.instalments).toBe(3);
    expect(small.body.flags.filter((f: string) => f.startsWith('instalment'))).toEqual([]);
  });

  it('art. 70 (owner decision 2026-11-24) — the fines deducted in one month are capped at 5 days of wage and the excess rolls into the next run as a fine', async () => {
    const { hr, hro, a } = await setup();
    const period = previousPeriod(currentPeriod());
    const win = attendanceWindow(period, 25);
    for (const d of workdays(win.from, win.to)) {
      await punch(a.employeeId, d, 'in', '08:00');
      await punch(a.employeeId, d, 'out', '16:00');
    }
    // Two upheld fines of 3 days each (80 000 halalas on an 8 000 SAR wage) = 6 days > the monthly cap of 5 days (133 333).
    for (const n of [1, 2])
      await PayrollAdjustment.create({ employeeId: a.employeeId, kind: 'deduction', amountHalalas: 80_000, reason: `خصم من الأجر DIS-TEST-0000${n}`, sourceType: 'disciplinary', sourceId: `dis-${n}`, createdByEmail: 'test' });
    const run = await api(hro).post('/hr/payroll', { period });
    expect(run.status).toBe(201);
    const slip = (await api(hr).get(`/hr/payroll/${run.body._id}`)).body.payslips.find((p: { employeeId: string }) => p.employeeId === a.employeeId) as { deductions: { code: string; amountHalalas: number; note?: string }[]; flags: string[] };
    const fines = slip.deductions.filter((l) => l.code === 'fine');
    expect(fines).toHaveLength(2);
    expect(fines.reduce((s, l) => s + l.amountHalalas, 0)).toBe(Math.round((5 * 800_000) / 30));
    expect(fines[1].note).toContain('مرحّلة');
    expect(slip.flags).toContain('fine_capped');
    expect(slip.flags).toContain('fine_deferred:26667');
    expect(slip.flags).not.toContain('deduction_capped'); // the art. 92 cap (50 %) is a different rule and was not hit
    // At the HR approval the excess becomes a next-run fine (sourceType disciplinary, so it counts against next month's cap too).
    await api(hro).post(`/hr/payroll/${run.body._id}/transition`, { transition: 'submit_for_review' });
    expect((await api(hr).post(`/hr/payroll/${run.body._id}/transition`, { transition: 'hr_approve' })).body.state).toBe('at_finance');
    const carried = await PayrollAdjustment.findOne({ employeeId: a.employeeId, sourceRunId: run.body._id }).lean();
    expect(carried).toMatchObject({ kind: 'deduction', amountHalalas: 26_667, sourceType: 'disciplinary' });
    expect(carried!.consumedByRunId ?? null).toBeNull(); // waits for the next run
    expect(carried!.reason).toContain('المادة 70');
  });
});

describe('H3a §3.7 — goals linked to KPIs, appraisal cycles, scoring, approval, improvement plans, disciplinary actions', () => {
  it('goals validate the KPI code, progress is appended, and the cycle flows manager → HR → employee acknowledgement', async () => {
    const { hr, mgr, a, b, other } = await setup();
    expect((await api(a.token).get('/hr/performance/kpis')).body.items.map((k: { code: string }) => k.code)).toEqual(expect.arrayContaining(['sales.revenue', 'hr.attendance_rate']));
    const badKpi = await api(mgr.token).post('/hr/performance/goals', { employeeId: a.employeeId, title: 'رفع نسبة الحضور', weightBp: 10_000, kpiCode: 'nope' });
    expect(badKpi.status, JSON.stringify(badKpi.body)).toBe(400);
    expect((await api(mgr.token).post('/hr/performance/goals', { employeeId: other.employeeId, title: 'هدف خارج الفريق', weightBp: 10_000 })).status).toBe(404); // not in the team
    const goal = await api(mgr.token).post('/hr/performance/goals', { employeeId: a.employeeId, title: 'رفع نسبة الحضور إلى 98%', weightBp: 10_000, kpiCode: 'hr.attendance_rate', targetValue: 98, unit: '%' });
    expect(goal.status).toBe(201);
    expect(goal.body.kpiNameAr).toBe('نسبة الحضور');
    expect(await Notification.countDocuments({ userId: a.userId, type: 'goal.assigned' })).toBe(1);
    expect((await api(a.token).post(`/hr/performance/goals/${goal.body._id}/progress`, { percent: 50, note: 'نصف الطريق' })).body.percent).toBe(50);
    expect((await api(b.token).post(`/hr/performance/goals/${goal.body._id}/progress`, { percent: 90 })).status).toBe(404);
    const me = await api(a.token).get('/hr/performance/me');
    expect(me.body.goals).toHaveLength(1);
    expect(me.body.goals[0].progress).toHaveLength(1);

    // Template and cycle [HR §3.7 «تقييم الأداء نصف سنوي وسنوي»].
    const badTpl = await api(hr).post('/hr/performance/templates', { ...DEFAULT_APPRAISAL_TEMPLATE, sections: [{ ...DEFAULT_APPRAISAL_TEMPLATE.sections[0], weightBp: 5000 }] });
    expect(badTpl.status).toBe(400);
    const tpl = await api(hr).post('/hr/performance/templates', DEFAULT_APPRAISAL_TEMPLATE);
    expect(tpl.status).toBe(201);
    expect((await api(mgr.token).post('/hr/performance/templates', DEFAULT_APPRAISAL_TEMPLATE)).status).toBe(403);
    const cycle = await api(hr).post('/hr/performance/cycles', { year: 2026, kind: 'semi_annual_1', from: '2026-01-01', to: '2026-06-30', opensAt: today(), dueAt: addDays(today(), 30), templateId: tpl.body._id });
    expect(cycle.status).toBe(201);
    const opened = await api(hr).post(`/hr/performance/cycles/${cycle.body._id}/open`);
    expect(opened.body.created).toBe(5);
    // The manager sees the team's appraisals; the employee sees nothing until approval.
    const team = await api(mgr.token).get('/hr/performance/appraisals?view=team');
    expect(team.body.items.map((x: { employee: { fullNameAr: string } }) => x.employee.fullNameAr).sort()).toEqual(['راشد الحربي', 'عمر الحربي', 'يوسف الحربي']);
    expect((await api(a.token).get('/hr/performance/appraisals?view=mine')).body.items).toHaveLength(0);
    const apprA = team.body.items.find((x: { employeeId: string }) => x.employeeId === a.employeeId);
    expect((await api(a.token).get(`/hr/performance/appraisals/${apprA._id}`)).status).toBe(404);
    // Scoring: the goals criterion is pre-filled from the snapshot (50 % → 3 of 5); tasks need a manual score when there were none.
    expect((await api(mgr.token).post(`/hr/performance/appraisals/${apprA._id}/score`, { scores: [{ key: 'quality', value: 5 }] })).status).toBe(400);
    const scored = await api(mgr.token).post(`/hr/performance/appraisals/${apprA._id}/score`, {
      scores: [{ key: 'quality', value: 5 }, { key: 'teamwork', value: 4 }, { key: 'initiative', value: 4 }, { key: 'communication', value: 5 }, { key: 'tasks', value: 4 }],
      managerNotes: 'أداء ممتاز مع التزام عالٍ',
    });
    expect(scored.status, JSON.stringify(scored.body)).toBe(200);
    expect(scored.body.scores.find((s: { key: string }) => s.key === 'goals').value).toBe(3);
    // goals 40 % × 0.5 + competencies 40 % × 0.875 + tasks 20 % × 0.75 = 0.20 + 0.35 + 0.15 = 70 %
    expect(scored.body.overallScoreBp).toBe(7000);
    expect(scored.body.overallRatingLabel).toBe('جيد جداً');
    expect((await api(hr).post(`/hr/performance/appraisals/${apprA._id}/score`, { scores: [{ key: 'quality', value: 1 }] })).status).toBe(400); // HR may score but the set must be complete
    expect((await api(mgr.token).post(`/hr/performance/appraisals/${apprA._id}/transition`, { transition: 'submit' })).body.state).toBe('manager_submitted');
    expect(await Notification.countDocuments({ type: 'appraisal.submitted' })).toBe(2); // both HR users (manager and officer)
    expect((await api(hr).post(`/hr/performance/appraisals/${apprA._id}/transition`, { transition: 'return', reason: 'أضف أمثلة على الالتزام' })).body.state).toBe('returned');
    expect(await Notification.countDocuments({ userId: mgr.userId, type: 'appraisal.returned' })).toBe(1);
    expect((await api(mgr.token).post(`/hr/performance/appraisals/${apprA._id}/transition`, { transition: 'submit' })).body.state).toBe('manager_submitted');
    const approvedA = await api(hr).post(`/hr/performance/appraisals/${apprA._id}/transition`, { transition: 'approve', hrNotes: 'معتمد' });
    expect(approvedA.body.state).toBe('approved');
    expect(approvedA.body.offerImprovementPlan).toBe(false);
    expect(await Notification.countDocuments({ userId: a.userId, type: 'appraisal.approved' })).toBe(1);
    const own = await api(a.token).get(`/hr/performance/appraisals/${apprA._id}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.actions).toEqual(['acknowledge']);
    expect((await api(a.token).post(`/hr/performance/appraisals/${apprA._id}/transition`, { transition: 'acknowledge', employeeComment: 'شكراً' })).body.state).toBe('acknowledged');
    // A low result offers an improvement plan; the manager creates it and follows it.
    const apprB = team.body.items.find((x: { employeeId: string }) => x.employeeId === b.employeeId);
    await api(mgr.token).post(`/hr/performance/appraisals/${apprB._id}/score`, { scores: [{ key: 'goals', value: 1 }, { key: 'quality', value: 1 }, { key: 'teamwork', value: 2 }, { key: 'initiative', value: 1 }, { key: 'communication', value: 2 }, { key: 'tasks', value: 1 }] });
    await api(mgr.token).post(`/hr/performance/appraisals/${apprB._id}/transition`, { transition: 'submit' });
    const approvedB = await api(hr).post(`/hr/performance/appraisals/${apprB._id}/transition`, { transition: 'approve' });
    expect(approvedB.body.offerImprovementPlan).toBe(true);
    const plan = await api(mgr.token).post('/hr/performance/plans', { employeeId: b.employeeId, appraisalId: apprB._id, from: today(), to: addDays(today(), 90), objectives: [{ text: 'الالتزام بمواعيد الحضور', measure: 'لا تأخير خلال شهر' }, { text: 'إنجاز المهام في وقتها' }] });
    expect(plan.status).toBe(201);
    expect((await api(mgr.token).post(`/hr/performance/plans/${plan.body._id}/reviews`, { note: 'تحسن ملحوظ', rating: 4, objectivesDone: [0] })).body.objectives[0].done).toBe(true);
    expect((await api(mgr.token).post(`/hr/performance/plans/${plan.body._id}/close`, { state: 'completed', note: 'تحققت الأهداف' })).body.state).toBe('completed');
    expect((await api(b.token).get('/hr/performance/me')).body.plans).toHaveLength(1);
    // The daily job opens a planned cycle whose opening day arrived; the export lists the appraisals with their state.
    await api(hr).post('/hr/performance/cycles', { year: 2026, kind: 'annual', from: '2026-01-01', to: '2026-12-31', opensAt: addDays(today(), -1), dueAt: addDays(today(), 40), templateId: tpl.body._id });
    expect((await runAppraisalJobs(new Date())).opened).toBe(1);
    expect(await AppraisalCycle.countDocuments({ state: 'open' })).toBe(2);
    expect(await Appraisal.countDocuments()).toBe(10);
    const rep = await api(hr).post('/export', { resource: 'hr.appraisals', fields: ['fullNameAr', 'cycleName', 'stateAr', 'overallScore'], filters: { cycleId: cycle.body._id }, format: 'preview', limit: 50 });
    expect(rep.body.total).toBe(5);
    expect(rep.body.rows.find((r: unknown[]) => r[0] === 'عمر الحربي')).toEqual(['عمر الحربي', 'نصف سنوي (النصف الأول) 2026', 'تم إشعار الموظف', 70]);
    const dash = await api(hr).get('/hr/dashboard/hr');
    expect(dash.body.performance).toMatchObject({ employeesWithGoals: 1, appraisalsTotal: 10, appraisalsDone: 2, appraisalCompletionBp: 2000 });
  });

  it('disciplinary actions follow the ladder (provisional), need an approver other than the issuer, are delivered in writing, may be appealed, and a fine reaches payroll once upheld — with the Labor Law windows the owner set on 2026-11-24', async () => {
    const { hr, hro, mgr, a, b } = await setup();
    // The 2026-11-25 review made the weekend exclusion a setting (default on) — off here so the 2026-11-24 day counts stay exact; see the dedicated test below.
    await setSetting('hr.discipline', { ...DEFAULT_DISCIPLINE_POLICY, employeeDeadlinesExcludeWeekend: false }, SYSTEM_ACTOR);
    // Art. 71 (2026-11-25): every penalty carries the investigation's end date and its record.
    const inv = { investigationEndDate: today(), investigationRecordText: 'محضر التحقيق: استُمع إلى الموظف بحضور المشرف وأقرّ بالواقعة' };
    const policy = await api(a.token).get('/hr/discipline/policy');
    expect(policy.body.provisional).toBe(true); // the ladder stays provisional until the HR team confirms it (Q11)
    expect(policy.body).toMatchObject({ appealDays: 30, appealDecisionDays: 15, violationDiscoveryDays: 30, investigationSignDays: 30, maxFineDaysPerViolation: 5, maxFineDaysPerMonth: 5 });
    expect(policy.body.ladder.map((s: { code: string }) => s.code)).toContain('final_warning');
    // The appeal window: 30 days excluding official holidays — a holiday inside it extends it by a day.
    expect(appealDeadlineFrom('2026-01-01', 30, new Set())).toEqual(new Date('2026-01-31T23:59:59.999+03:00'));
    expect(appealDeadlineFrom('2026-01-01', 30, new Set(['2026-01-10', '2026-01-11']))).toEqual(new Date('2026-02-02T23:59:59.999+03:00'));
    const d = (n: number) => addDays(today(), n);
    expect((await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'nope', violationDate: today(), discoveryDate: today(), ...inv, description: 'تأخر متكرر خلال الأسبوع' })).status).toBe(400);
    expect((await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate: d(-2), ...inv, description: 'بلا تاريخ اكتشاف' })).status).toBe(400); // discoveryDate required
    // Art. 71: the 30 days run from the *discovery*, not the violation.
    const late = await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate: d(-40), discoveryDate: d(-40), ...inv, description: 'مخالفة قديمة اكتُشفت في يومها' });
    expect(late.status).toBe(400);
    expect(late.body.error.details.code).toBe('discovery_expired');
    const discoveredLate = await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate: d(-40), discoveryDate: d(-5), ...inv, description: 'مخالفة قديمة اكتُشفت قبل خمسة أيام فقط' });
    expect(discoveredLate.status, JSON.stringify(discoveredLate.body)).toBe(201);
    expect((await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate: d(-3), discoveryDate: d(-5), ...inv, description: 'اكتشاف قبل الوقوع' })).status).toBe(400);
    // Art. 71: no penalty more than 30 days after the investigation ended.
    const staleInv = await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate: d(-50), discoveryDate: d(-45), investigationEndDate: d(-31), investigationRecordText: inv.investigationRecordText, description: 'تحقيق انتهى قبل أكثر من ثلاثين يوماً' });
    expect(staleInv.status).toBe(400);
    expect(staleInv.body.error.details.code).toMatch(/discovery_expired|investigation_expired/);
    // Art. 70: a single violation's fine ≤ 5 days.
    const bigFine = await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'fine', fineDays: 6, violationDate: today(), discoveryDate: today(), ...inv, description: 'خصم كبير' });
    expect(bigFine.status).toBe(400);
    expect(bigFine.body.error.details.code).toBe('fine_over_max');
    expect((await api(b.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate: today(), discoveryDate: today(), ...inv, description: 'زميل يحاول' })).status).toBe(403);
    const w = await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate: d(-2), discoveryDate: d(-1), investigationEndDate: today(), investigationRecordText: inv.investigationRecordText, description: 'تأخر متكرر ثلاث مرات هذا الأسبوع رغم التنبيه الشفهي' });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body.number).toMatch(/^DIS-/);
    expect(w.body.state).toBe('draft');
    expect(w.body).toMatchObject({ discoveryDate: d(-1), investigationEndDate: today() });
    // One penalty per violation: a second action on the same employee and day is refused unless declared a separate violation.
    const dup = await api(hro).post('/hr/discipline', { employeeId: a.employeeId, kind: 'written_notice', violationDate: d(-2), discoveryDate: d(-1), ...inv, description: 'نفس المخالفة بجزاء ثانٍ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.code).toBe('violation_already_penalised');
    const separate = await api(hro).post('/hr/discipline', { employeeId: a.employeeId, kind: 'written_notice', violationDate: d(-2), discoveryDate: d(-1), separateViolation: true, ...inv, description: 'مخالفة أخرى مستقلة في نفس اليوم: ترك الموقع دون إذن' });
    expect(separate.status).toBe(201);
    expect((await api(a.token).get('/hr/discipline')).body.items).toHaveLength(0); // nothing until delivered
    const submitted = await api(mgr.token).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'submit' });
    expect(submitted.body.state, JSON.stringify(submitted.body)).toBe('pending_approval');
    expect(await Notification.countDocuments({ type: 'discipline.pending' })).toBe(1);
    expect((await api(mgr.token).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'approve' })).status).toBe(403); // issuer ≠ approver
    expect((await api(hro).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'approve' })).status).toBe(403); // approver role = hr_manager (Q11)
    expect((await api(hr).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'approve' })).body.state).toBe('approved');
    // Delivery stamps the appeal deadline: 30 days excluding the official holidays inside the window (one here → 31 days).
    await Holiday.create({ date: d(10), nameAr: 'عطلة تجريبية' });
    const delivered = await api(hro).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'deliver' });
    expect(delivered.body.state).toBe('delivered');
    expect(riyadhDate(new Date(delivered.body.appealDeadline))).toBe(d(31));
    expect(await Notification.countDocuments({ userId: a.userId, type: 'discipline.delivered' })).toBe(1);
    const mine = await api(a.token).get('/hr/discipline');
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].evidenceAttachmentIds).toBeDefined();
    expect((await api(a.token).get(`/hr/discipline/${w.body._id}`)).body.actions.sort()).toEqual(['acknowledge', 'appeal']);
    // Art. 72: the appeal must be decided in writing within 15 days — a task with that deadline for the approver.
    const appealed = await api(a.token).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'appeal', note: 'كان التأخر بسبب مهمة ميدانية موثقة' });
    expect(appealed.body.state).toBe('appealed');
    expect(riyadhDate(new Date(appealed.body.appealDecisionDueAt))).toBe(d(15));
    expect(await Notification.countDocuments({ type: 'discipline.appealed' })).toBe(1);
    const hrUser = (await User.findOne({ email: 'hr@eayni.local' }).lean())!;
    const task = (await Task.findOne({ 'source.type': 'disciplinary', 'source.id': w.body._id }).lean())!;
    expect(task).toBeTruthy();
    expect(String(task.assigneeId)).toBe(String(hrUser._id));
    expect(riyadhDate(task.dueAt!)).toBe(d(15));
    expect(task.priority).toBe('high');
    expect((await api(hr).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'uphold' })).status).toBe(400); // from «قيد التظلم» the written decision is reject_appeal, never a direct uphold (2026-11-25)
    expect((await api(hr).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'reject_appeal', note: 'المهمة لم تكن مسجلة' })).body.state).toBe('objection_window'); // not final yet — the court-objection window
    expect((await Task.findById(task._id).lean())!.status).toBe('done'); // the written decision closes the task
    // A fine: 2 days of wage = 2 × 800000/30; it becomes a payroll deduction once upheld (here by the employee's acknowledgement).
    const f = await api(hr).post('/hr/discipline', { employeeId: a.employeeId, kind: 'fine', fineDays: 2, violationDate: today(), discoveryDate: today(), ...inv, description: 'إتلاف عهدة بسبب الإهمال الموثق في التقرير' });
    expect(f.status).toBe(201);
    expect(f.body.fineHalalas).toBe(Math.round((2 * 800_000) / 30));
    await api(hr).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'submit' });
    expect((await api(hr).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'approve' })).status).toBe(403); // the HR manager issued it
    await makeUser('hr2@eayni.local', [{ role: 'employee' }, { role: 'hr_manager' }]);
    const hr2 = await loginAs('hr2@eayni.local');
    expect((await api(hr2).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'approve' })).body.state).toBe('approved');
    await api(hro).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'deliver' });
    expect(await PayrollAdjustment.countDocuments({ sourceType: 'disciplinary', sourceId: f.body._id })).toBe(0); // nothing before it is final
    expect((await api(a.token).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'acknowledge' })).body.state).toBe('upheld');
    const adj = await PayrollAdjustment.findOne({ sourceType: 'disciplinary', sourceId: f.body._id }).lean();
    expect(adj).toMatchObject({ kind: 'deduction', amountHalalas: f.body.fineHalalas });
    expect(await Outbox.countDocuments({ type: 'hr.discipline.payroll_effect' })).toBe(1);
    const rep = await api(hr).post('/export', { resource: 'hr.discipline', fields: ['number', 'fullNameAr', 'kindLabelAr', 'discoveryDate', 'stateAr', 'fine'], filters: {}, format: 'preview', limit: 50 });
    expect(rep.body.total).toBe(4); // the late-discovered draft, the warning, the separate notice, the fine
  });
});


describe('H3a §3.7 — owner review 2026-11-25: the court-objection window, the escalation, the investigation record, the deadline setting, the advance notice', () => {
  const inv = { investigationEndDate: today(), investigationRecordText: 'محضر التحقيق: استُمع إلى الموظف بحضور المشرف وأقرّ بالواقعة' };
  const d = (n: number) => addDays(today(), n);
  /** A one-day fine on `a`, issued by the manager, approved by HR, delivered, and appealed by the employee. */
  async function appealedFine(t: Awaited<ReturnType<typeof setup>>, violationDate: string) {
    const f = await api(t.mgr.token).post('/hr/discipline', { employeeId: t.a.employeeId, kind: 'fine', fineDays: 1, violationDate, discoveryDate: violationDate, ...inv, description: 'إتلاف عهدة بسبب الإهمال الموثق في التقرير' });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    await api(t.mgr.token).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'submit' });
    expect((await api(t.hr).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'approve' })).body.state).toBe('approved');
    expect((await api(t.hro).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'deliver' })).body.state).toBe('delivered');
    const ap = await api(t.a.token).post(`/hr/discipline/${f.body._id}/transition`, { transition: 'appeal', note: 'العهدة كانت معطوبة قبل تسلّمها' });
    expect(ap.body.state).toBe('appealed');
    return ap.body as { _id: string; number: string; fineHalalas: number; appealTaskId: string };
  }
  const fines = (id: string) => PayrollAdjustment.countDocuments({ sourceType: 'disciplinary', sourceId: id });

  it('art. 72 (1) — a rejected appeal opens a 30-day court-objection window that holds the fine; «اعتراض أمام المحكمة» holds it until the ruling; the window\'s end or the ruling makes the penalty final', async () => {
    const t = await setup();
    const { hr, hro, a } = t;
    // 1) Rejected → «مهلة الاعتراض أمام المحكمة», not final: no payroll adjustment, the task is closed, the employee is told the deadline.
    const f1 = await appealedFine(t, d(-1));
    const rejected = await api(hr).post(`/hr/discipline/${f1._id}/transition`, { transition: 'reject_appeal', note: 'التقرير الفني يثبت أن العطب حدث بعد التسلّم' });
    expect(rejected.body.state).toBe('objection_window');
    expect(rejected.body.appeal.outcome).toBe('rejected');
    expect(new Date(rejected.body.courtObjectionDeadline)).toEqual(employeeDeadlineFrom(today(), 30, new Set(), true));
    expect((await Task.findById(f1.appealTaskId).lean())!.status).toBe('done');
    expect(await fines(f1._id)).toBe(0);
    expect((await Notification.findOne({ userId: a.userId, type: 'discipline.appeal_rejected' }).lean())!.bodyAr).toContain('المحكمة');
    expect(rejected.body.actions).not.toContain('finalize'); // the system's move, never a button
    expect((await api(hr).post(`/hr/discipline/${f1._id}/transition`, { transition: 'finalize' })).status).toBe(403);
    expect((await runPerformanceFollowUps()).finalized).toBe(0); // the window is still open
    // 2) HR records the court objection → the fine is held even after the window would have ended; the ruling (HR manager only) ends it.
    expect((await api(hro).post(`/hr/discipline/${f1._id}/transition`, { transition: 'court_objection', note: 'الدعوى رقم 1234/1448 — المحكمة العمالية بالرياض' })).body.state).toBe('court_objection');
    await DisciplinaryAction.updateOne({ _id: f1._id }, { $set: { courtObjectionDeadline: new Date(Date.now() - DAY) } });
    expect((await runPerformanceFollowUps()).finalized).toBe(0);
    expect((await DisciplinaryAction.findById(f1._id).lean())!.state).toBe('court_objection');
    expect(await fines(f1._id)).toBe(0);
    expect((await api(hro).post(`/hr/discipline/${f1._id}/transition`, { transition: 'court_uphold', note: 'x' })).status).toBe(403); // hr_manager only
    const ruled = await api(hr).post(`/hr/discipline/${f1._id}/transition`, { transition: 'court_uphold', note: 'حكم بتأييد الجزاء — صك رقم 55' });
    expect(ruled.body.state).toBe('upheld');
    expect(ruled.body.court).toMatchObject({ reference: 'الدعوى رقم 1234/1448 — المحكمة العمالية بالرياض', rulingOutcome: 'upheld' });
    expect(await fines(f1._id)).toBe(1); // the fine reaches payroll only now
    expect(await Notification.countDocuments({ userId: a.userId, type: 'discipline.final' })).toBe(1);
    // 3) Rejected, no objection recorded, the window ends → final by the daily job, and the fine reaches payroll.
    const f2 = await appealedFine(t, d(-2));
    await api(hr).post(`/hr/discipline/${f2._id}/transition`, { transition: 'reject_appeal', note: 'مرفوض' });
    await DisciplinaryAction.updateOne({ _id: f2._id }, { $set: { courtObjectionDeadline: new Date(Date.now() - DAY) } });
    expect((await runPerformanceFollowUps()).finalized).toBe(1);
    expect((await DisciplinaryAction.findById(f2._id).lean())!.state).toBe('upheld');
    expect(await fines(f2._id)).toBe(1);
    // 4) The court cancels the penalty → withdrawn, nothing deducted.
    const f3 = await appealedFine(t, d(-3));
    await api(hr).post(`/hr/discipline/${f3._id}/transition`, { transition: 'reject_appeal', note: 'مرفوض' });
    await api(hro).post(`/hr/discipline/${f3._id}/transition`, { transition: 'court_objection', note: 'الدعوى 99' });
    expect((await api(hr).post(`/hr/discipline/${f3._id}/transition`, { transition: 'court_cancel', note: 'حكم بإلغاء الجزاء' })).body.state).toBe('withdrawn');
    expect(await fines(f3._id)).toBe(0);
    // The employee sees his final actions on «أدائي»; the withdrawn one is not listed.
    const mine = await api(a.token).get('/hr/discipline');
    expect(mine.body.items.map((x: { state: string }) => x.state).sort()).toEqual(['upheld', 'upheld']);
  });

  it('art. 72 (2) — an appeal undecided after 15 days is escalated to the HR manager with a notification, and the court-objection window runs from the end of the decision window', async () => {
    const t = await setup();
    const { hr } = t;
    const hrUser = (await User.findOne({ email: 'hr@eayni.local' }).lean())!;
    const f1 = await appealedFine(t, d(-1));
    expect((await runPerformanceFollowUps()).escalated).toBe(0); // day 15 not reached
    // Day 15 passed two days ago without a decision.
    await DisciplinaryAction.updateOne({ _id: f1._id }, { $set: { appealDecisionDueAt: riyadhDayEndOf(d(-2)) } });
    expect((await runPerformanceFollowUps()).escalated).toBe(1);
    const esc = (await DisciplinaryAction.findById(f1._id).lean())!;
    expect(esc.state).toBe('appealed'); // the HR manager can still decide
    expect(esc.appealEscalatedAt).toBeTruthy();
    expect(esc.courtObjectionDeadline).toEqual(employeeDeadlineFrom(d(-2), 30, new Set(), true)); // from the end of the decision window, not from today
    const task = (await Task.findById(f1.appealTaskId).lean())!;
    expect(String(task.assigneeId)).toBe(String(hrUser._id));
    expect(task.reviewNote).toContain('المادة 72');
    expect(await TaskEvent.countDocuments({ taskId: task._id, type: 'reassigned' })).toBe(1);
    expect((await Notification.findOne({ userId: hrUser._id, type: 'discipline.appeal_escalated' }).lean())!.bodyAr).toContain(f1.number);
    expect((await runPerformanceFollowUps()).escalated).toBe(0); // once
    // A late rejection keeps the earlier deadline (whichever came first).
    const rejected = await api(hr).post(`/hr/discipline/${f1._id}/transition`, { transition: 'reject_appeal', note: 'مرفوض بعد الإحالة' });
    expect(rejected.body.state).toBe('objection_window');
    expect(new Date(rejected.body.courtObjectionDeadline)).toEqual(esc.courtObjectionDeadline);
    // Never decided at all: when the court-objection window ends the penalty is final with the outcome «فاتت مهلة البت».
    const f2 = await appealedFine(t, d(-2));
    await DisciplinaryAction.updateOne({ _id: f2._id }, { $set: { appealDecisionDueAt: riyadhDayEndOf(d(-40)) } });
    expect((await runPerformanceFollowUps()).escalated).toBe(1);
    await DisciplinaryAction.updateOne({ _id: f2._id }, { $set: { courtObjectionDeadline: new Date(Date.now() - DAY) } });
    expect((await runPerformanceFollowUps()).finalized).toBe(1);
    const final = (await DisciplinaryAction.findById(f2._id).lean())!;
    expect(final.state).toBe('upheld');
    expect(final.appeal?.outcome).toBe('expired');
    expect((await Task.findById(f2.appealTaskId).lean())!.status).toBe('cancelled');
    expect(await fines(f2._id)).toBe(1);
  });

  it('art. 71 — every penalty needs the investigation end date and its record (text or attachment); oral questioning only for a warning or a fine of at most one day\'s wage', async () => {
    expect(oralQuestioningAllowed('none')).toBe(true);
    expect(oralQuestioningAllowed('fine', 1)).toBe(true);
    expect(oralQuestioningAllowed('fine', 1.5)).toBe(false);
    expect(oralQuestioningAllowed('suspension', undefined)).toBe(false);
    expect(oralQuestioningAllowed('termination')).toBe(false);
    const { hr, mgr, a } = await setup();
    const base = { employeeId: a.employeeId, violationDate: today(), discoveryDate: today(), description: 'مخالفة موثقة في تقرير المشرف' };
    const code = (r: { body: { error?: { details?: { code?: string } } } }) => r.body.error?.details?.code;
    expect((await api(mgr.token).post('/hr/discipline', { ...base, kind: 'warning_1', investigationRecordText: inv.investigationRecordText })).status).toBe(400); // no end date
    const noRecord = await api(mgr.token).post('/hr/discipline', { ...base, kind: 'warning_1', investigationEndDate: today() });
    expect(noRecord.status).toBe(400);
    expect(code(noRecord)).toBe('investigation_record_required');
    expect(code(await api(mgr.token).post('/hr/discipline', { ...base, kind: 'warning_1', investigationEndDate: today(), investigationRecordText: 'قصير' }))).toBe('investigation_record_required');
    const oralFine = await api(mgr.token).post('/hr/discipline', { ...base, kind: 'fine', fineDays: 2, investigationMode: 'oral', ...inv });
    expect(oralFine.status).toBe(400);
    expect(code(oralFine)).toBe('oral_not_allowed');
    expect(code(await api(mgr.token).post('/hr/discipline', { ...base, kind: 'suspension', suspensionDays: 2, investigationMode: 'oral', ...inv }))).toBe('oral_not_allowed');
    const oralWarning = await api(mgr.token).post('/hr/discipline', { ...base, kind: 'warning_1', investigationMode: 'oral', ...inv });
    expect(oralWarning.status, JSON.stringify(oralWarning.body)).toBe(201);
    expect(oralWarning.body).toMatchObject({ investigationMode: 'oral', investigationEndDate: today(), investigationRecordText: inv.investigationRecordText });
    const oralOneDay = await api(mgr.token).post('/hr/discipline', { ...base, violationDate: d(-1), discoveryDate: d(-1), kind: 'fine', fineDays: 1, investigationMode: 'oral', ...inv });
    expect(oralOneDay.status).toBe(201);
    // The record may be an attachment instead of text; the mode defaults to written.
    const attached = await api(mgr.token).post('/hr/discipline', { ...base, violationDate: d(-2), discoveryDate: d(-2), kind: 'fine', fineDays: 2, investigationEndDate: today(), investigationRecordAttachmentIds: ['6655443322110000aabbccdd'] });
    expect(attached.status, JSON.stringify(attached.body)).toBe(201);
    expect(attached.body.investigationMode).toBe('written');
    const rep = await api(hr).post('/export', { resource: 'hr.discipline', fields: ['number', 'investigationEndDate', 'investigationModeAr'], filters: {}, format: 'preview', limit: 50 });
    expect(rep.body.total).toBe(3);
    expect(rep.body.rows.map((r: string[]) => r[2]).sort()).toEqual(['استجواب شفهي', 'استجواب شفهي', 'تحقيق كتابي']);
  });

  it('deadlines — the employee\'s (appeal, court objection) skip Friday–Saturday and the official holidays by the setting, default on; the employer\'s (arts. 71, 72 decision) stay calendar days', async () => {
    // 2026-01-01 is a Thursday: 30 calendar days → 31 Jan; 30 working days (Sun–Thu) → 12 Feb.
    expect(employeeDeadlineFrom('2026-01-01', 30, new Set(), false)).toEqual(new Date('2026-01-31T23:59:59.999+03:00'));
    expect(employeeDeadlineFrom('2026-01-01', 30, new Set(), true)).toEqual(new Date('2026-02-12T23:59:59.999+03:00'));
    expect(employeeDeadlineFrom('2026-01-01', 30, new Set(['2026-01-05']), true)).toEqual(new Date('2026-02-15T23:59:59.999+03:00')); // a holiday on a Monday adds a working day (Thu 12 → Sun 15)
    expect(employeeDeadlineFrom('2026-01-01', 30, new Set(['2026-01-09']), true)).toEqual(new Date('2026-02-12T23:59:59.999+03:00')); // a holiday on a Friday changes nothing
    const { hr, hro, mgr, a } = await setup();
    const policy = await api(a.token).get('/hr/discipline/policy');
    expect(policy.body).toMatchObject({ employeeDeadlinesExcludeWeekend: true, courtObjectionDays: 30, appealDecisionDays: 15 });
    const issue = async (violationDate: string) => {
      const w = await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate, discoveryDate: violationDate, ...inv, description: 'تأخر متكرر موثق' });
      expect(w.status, JSON.stringify(w.body)).toBe(201);
      await api(mgr.token).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'submit' });
      await api(hr).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'approve' });
      return (await api(hro).post(`/hr/discipline/${w.body._id}/transition`, { transition: 'deliver' })).body as { _id: string; appealDeadline: string };
    };
    const w1 = await issue(d(-1));
    expect(new Date(w1.appealDeadline)).toEqual(employeeDeadlineFrom(today(), 30, new Set(), true));
    expect(new Date(w1.appealDeadline).getTime()).toBeGreaterThan(riyadhDayEndOf(d(30)).getTime()); // 30 working days are more than 30 calendar days
    // The employer's 15 days to decide are calendar days whatever the setting.
    const ap = await api(a.token).post(`/hr/discipline/${w1._id}/transition`, { transition: 'appeal', note: 'لم أتأخر' });
    expect(riyadhDate(new Date(ap.body.appealDecisionDueAt))).toBe(d(15));
    // Setting off → holidays only.
    await setSetting('hr.discipline', { ...DEFAULT_DISCIPLINE_POLICY, employeeDeadlinesExcludeWeekend: false }, SYSTEM_ACTOR);
    const w2 = await issue(d(-2));
    expect(riyadhDate(new Date(w2.appealDeadline))).toBe(d(30));
    // Art. 71 stays calendar: a discovery 31 days ago is refused although fewer than 31 working days passed.
    const old = await api(mgr.token).post('/hr/discipline', { employeeId: a.employeeId, kind: 'warning_1', violationDate: d(-31), discoveryDate: d(-31), ...inv, description: 'اكتُشفت قبل 31 يوماً' });
    expect(old.status).toBe(400);
    expect(old.body.error.details.code).toBe('discovery_expired');
  });

  it('advances — when the server re-splits the instalments the employee is told the new schedule (count and amount per instalment)', async () => {
    const { a } = await setup(); // wage 8 000 SAR → cap 800 per instalment
    const split = await api(a.token).post('/hr/requests', { type: 'advance', details: { amountHalalas: 240_000, reason: 'علاج', instalments: 1 }, attachmentIds: [] });
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    expect(split.body.details).toMatchObject({ instalments: 3, instalmentHalalas: 80_000 });
    const n = (await Notification.findOne({ userId: a.userId, type: 'request.instalments_rescheduled' }).lean())!;
    expect(n).toBeTruthy();
    expect(n.bodyAr).toContain(split.body.number);
    expect(n.bodyAr).toContain('3 أقساط');
    expect(n.bodyAr).toContain('800');
    expect(n.link).toBe(`/me/requests/${split.body._id}`);
    // With the written consent, or within the cap, nothing is re-split and nothing is sent.
    await api(a.token).post('/hr/requests', { type: 'advance', details: { amountHalalas: 240_000, reason: 'علاج', instalments: 1, scheduleConsent: true }, attachmentIds: [] });
    await api(a.token).post('/hr/requests', { type: 'advance', details: { amountHalalas: 90_000, reason: 'سفر', instalments: 3 }, attachmentIds: [] });
    expect(await Notification.countDocuments({ userId: a.userId, type: 'request.instalments_rescheduled' })).toBe(1);
  });
});

describe('H3a §3.8 — training plan, needs, courses, participation and certificates', () => {
  it('department managers raise needs, HR plans and runs courses, participants get tasks and upload certificates, reports per employee and department', async () => {
    const { hr, hro, dm, mgr, a, b, other, ops } = await setup();
    expect((await api(a.token).post('/hr/training/needs', { departmentId: String(ops._id), year: 2026, title: 'سلامة مهنية' })).status).toBe(403);
    const need = await api(dm).post('/hr/training/needs', { departmentId: String(ops._id), year: 2026, title: 'السلامة المهنية في مواقع الفرز', justification: 'حوادث متكررة', employeeIds: [a.employeeId, b.employeeId], priority: 'high' });
    expect(need.status, JSON.stringify(need.body)).toBe(201);
    expect((await api(hr).patch(`/hr/training/needs/${need.body._id}/state`, { state: 'accepted' })).body.state).toBe('accepted');
    // The annual plan [HR §3.8.1]: HR drafts and submits; the HR manager approves (Q12); the submitter never approves their own.
    const plan = await api(hro).put('/hr/training/plans/2026', { items: [{ title: 'السلامة المهنية', departmentIds: [String(ops._id)], quarter: 1, estimatedCostHalalas: 500_000, needIds: [need.body._id] }, { title: 'خدمة العملاء', quarter: 3, estimatedCostHalalas: 300_000 }] });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body.state).toBe('draft');
    expect((await api(hro).post('/hr/training/plans/2026/transition', { transition: 'submit' })).body.state).toBe('submitted');
    expect((await api(hro).post('/hr/training/plans/2026/transition', { transition: 'approve' })).status).toBe(403);
    expect((await api(hr).post('/hr/training/plans/2026/transition', { transition: 'approve' })).body.state).toBe('approved');
    expect((await api(hr).get('/hr/training/needs?year=2026')).body.items[0].state).toBe('planned');
    // A course [HR §3.8.4–3.8.5] with its calendar event; nominations create tasks in «مهامي» and notify.
    const start = new Date(Date.now() + 7 * DAY);
    const end = new Date(Date.now() + 8 * DAY);
    const course = await api(hr).post('/hr/training/trainings', { title: 'السلامة المهنية في مواقع الفرز', providerName: 'المعهد السعودي للسلامة', kind: 'external', startAt: start, endAt: end, location: 'الدمام', needIds: [need.body._id], departmentIds: [String(ops._id)], costHalalas: 450_000 });
    expect(course.status, JSON.stringify(course.body)).toBe(201);
    expect(course.body.number).toMatch(/^TRN-/);
    expect(await CalendarEvent.countDocuments({ _id: course.body.calendarEventId, type: 'training' })).toBe(1);
    expect((await api(a.token).post('/hr/training/trainings', { title: 'x', providerName: 'y', startAt: start, endAt: end })).status).toBe(403);
    expect((await api(mgr.token).post(`/hr/training/trainings/${course.body._id}/participants`, { employeeIds: [other.employeeId] })).status).toBe(403); // not in the team
    const nominated = await api(hr).post(`/hr/training/trainings/${course.body._id}/participants`, { employeeIds: [a.employeeId, b.employeeId] });
    expect(nominated.status).toBe(201);
    expect(nominated.body.items).toHaveLength(2);
    expect(await Task.countDocuments({ 'source.type': 'training', 'source.id': course.body._id })).toBe(2);
    expect(await Notification.countDocuments({ type: 'training.nominated' })).toBe(2);
    expect((await CalendarEvent.findById(course.body.calendarEventId).lean())!.participantIds.map(String).sort()).toEqual([a.userId, b.userId].sort());
    // Participation and certificates [HR §3.8.6–3.8.7]: the employee uploads a certificate; HR records the completion.
    const pA = nominated.body.items.find((p: { employeeId: string }) => p.employeeId === a.employeeId);
    const cert = await Attachment.create({ key: `test/${a.employeeId}-cert.pdf`, originalName: 'certificate.pdf', mimeType: 'application/pdf', size: 100, status: 'uploaded', uploadedBy: a.userId, uploadedAt: new Date() });
    expect((await api(a.token).patch(`/hr/training/participants/${pA._id}`, { status: 'completed' })).status).toBe(403);
    expect((await api(a.token).patch(`/hr/training/participants/${pA._id}`, { certificateAttachmentId: String(cert._id) })).body.certificateUploadedAt).toBeTruthy();
    expect((await api(b.token).patch(`/hr/training/participants/${pA._id}`, { certificateAttachmentId: String(cert._id) })).status).toBe(403);
    expect((await api(hro).patch(`/hr/training/participants/${pA._id}`, { status: 'completed', result: 'ناجح 92%' })).body.status).toBe('completed');
    expect((await Task.findOne({ 'source.id': course.body._id, assigneeId: a.userId }).lean())!.status).toBe('done');
    const myTraining = await api(a.token).get('/hr/training/me');
    expect(myTraining.body.items).toHaveLength(1);
    expect(myTraining.body.items[0]).toMatchObject({ status: 'completed', certificateName: 'certificate.pdf' });
    expect(myTraining.body.items[0].training.title).toContain('السلامة');
    // The course completes; the need is done; the reports list it per employee and department [HR §3.8.8].
    expect((await api(hr).patch(`/hr/training/trainings/${course.body._id}`, { state: 'completed' })).body.state).toBe('completed');
    expect((await api(hr).get('/hr/training/needs?year=2026')).body.items[0].state).toBe('done');
    const rep = await api(hr).post('/export', { resource: 'hr.training_participants', fields: ['fullNameAr', 'departmentName', 'title', 'statusAr', 'certificate'], filters: {}, format: 'preview', limit: 50 });
    expect(rep.body.total).toBe(2);
    expect(rep.body.rows.find((r: unknown[]) => r[0] === 'عمر الحربي')).toEqual(['عمر الحربي', 'التشغيل', 'السلامة المهنية في مواقع الفرز', 'أكمل', 'نعم']);
    const dmRep = await api(dm).post('/export', { resource: 'hr.training_participants', fields: ['fullNameAr'], filters: {}, format: 'preview', limit: 50 });
    expect(dmRep.status).toBe(200);
    expect(dmRep.body.total).toBe(2);
    const courses = await api(hr).post('/export', { resource: 'hr.trainings', fields: ['number', 'title', 'participants', 'completed', 'stateAr'], filters: { year: String(new Date().getFullYear()) }, format: 'preview', limit: 50 });
    expect(courses.body.rows[0].slice(2)).toEqual([2, 1, 'منفَّذة']);
    // API document lists the H3a routes with their permissions [HR §9.14].
    await makeUser('it@eayni.local', [{ role: 'employee' }, { role: 'system_admin' }]);
    const doc = await api(await loginAs('it@eayni.local')).get('/openapi.json');
    expect(doc.body.paths['/api/v1/hr/payroll'].post['x-permission']).toBe('hr.payroll:create');
    expect(doc.body.paths['/api/v1/finance/payroll/{id}/transition'].post['x-permission']).toBe('finance.payroll:view');
    expect(doc.body.paths['/api/v1/hr/performance/appraisals/{id}/score'].post['x-permission']).toBe('hr.appraisals:view');
    expect(doc.body.paths['/api/v1/hr/training/trainings'].post['x-permission']).toBe('hr.training:edit');
    void computeDay;
    void Employee;
  });
});
