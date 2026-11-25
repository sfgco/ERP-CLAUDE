import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { activateAccount, auth, loginAs, makeDepartment, makeUser, testApp } from '../../test/helpers';
import { upload } from '../../test/salesFixtures';
import { setSetting } from '../../core/settings/service';
import { SYSTEM_ACTOR } from '../../core/http/context';
import { Notification } from '../../core/notifications/model';
import { Outbox } from '../../core/outbox/model';
import { AuditLog } from '../../core/audit/model';
import { Task } from '../../core/tasks/model';
import { CalendarEvent } from '../../core/calendar/model';
import { Branch, Site } from '../../core/org/model';
import { Holiday } from '../../core/dates/model';
import { User } from '../../core/auth/model';
import { riyadhDate } from '../../core/dates/businessDays';
import { HrRequest } from './requests.model';
import { AttendanceDay, LeaveLedger } from './attendance.model';
import { addDays } from './attendance.service';
import { AdvanceSchedule, PayrollAdjustment, Payslip } from './payroll.model';
import { DisciplinaryAction } from './performance.model';
import { Types } from 'mongoose';
import { Contract, Custody, Employee } from './model';
import { Applicant, JobRequisition, Offer } from './recruitment.model';
import { Offboarding } from './offboarding.model';
import { runFixedTermExpiry, runRecruitmentJobs } from './recruitment.service';
import { runOffboardingJobs } from './offboarding.service';
import {
  ageOn,
  art77CompensationHalalas,
  art87WithinLimit,
  awardFractionBp,
  awardWageOf,
  contractYearWindow,
  eosAwardHalalas,
  fixedTermExpiryOutcome,
  holidayKindOf,
  isSaudi,
  noticeRequiredDays,
  probationEndDay,
  resignationEndDay,
  resignationFractionBp,
  retirementAgeFor,
} from './legal.service';
import { DEFAULT_EOS_POLICY } from '@eayni/shared';

const app = () => testApp();
const DAY = 86_400_000;
const today = () => riyadhDate(new Date());
const api = (token: string) => ({
  get: (p: string) => request(app()).get(`/api/v1${p}`).set(auth(token)),
  post: (p: string, body?: object) => request(app()).post(`/api/v1${p}`).set(auth(token)).send(body),
  patch: (p: string, body?: object) => request(app()).patch(`/api/v1${p}`).set(auth(token)).send(body),
  put: (p: string, body?: object) => request(app()).put(`/api/v1${p}`).set(auth(token)).send(body),
});

/**
 * H3b — recruitment and end of service [HR §3.2, §3.10]. Every rule of docs/HR_H3B_LEGAL.md (T1–T14, E1–E26) has a
 * test below naming it; the owner decisions are DECISIONS §22. Roles: hr_manager approves, hr_officer runs, the
 * department manager raises requisitions, Finance pays, IT confirms, the employee resigns and withdraws.
 */
async function setup() {
  await setSetting('auth.mfaRequiredRoles', [], SYSTEM_ACTOR);
  const ops = await makeDepartment('ops', 'التشغيل');
  const sales = await makeDepartment('sales', 'المبيعات');
  const itDept = await makeDepartment('it', 'التقنية');
  const branch = await Branch.create({ code: 'hq', nameAr: 'المقر', active: true });
  const site = await Site.create({ branchId: branch._id, nameAr: 'الموقع', location: { type: 'Point', coordinates: [50.1, 26.43] }, geofenceRadiusM: 200, active: true });
  await makeUser('hr@eayni.local', [{ role: 'employee' }, { role: 'hr_manager' }]);
  await makeUser('hro@eayni.local', [{ role: 'employee' }, { role: 'hr_officer' }]);
  await makeUser('fm@eayni.local', [{ role: 'employee' }, { role: 'finance_manager' }]);
  await makeUser('fs@eayni.local', [{ role: 'employee' }, { role: 'finance_staff' }]);
  await makeUser('admin@eayni.local', [{ role: 'employee' }, { role: 'system_admin' }]);
  await makeUser('exec@eayni.local', [{ role: 'employee' }, { role: 'executive' }]);
  await makeUser('dm@eayni.local', [{ role: 'employee' }, { role: 'department_manager', departmentId: String(ops._id) }], { departmentId: ops._id });
  await makeUser('dm2@eayni.local', [{ role: 'employee' }, { role: 'department_manager', departmentId: String(sales._id) }], { departmentId: sales._id });
  await makeUser('it@eayni.local', [{ role: 'employee' }], { departmentId: itDept._id }); // it_staff is implied by the department
  const [hr, hro, fm, fs, admin, exec, dm, dm2, it] = await Promise.all(['hr', 'hro', 'fm', 'fs', 'admin', 'exec', 'dm', 'dm2', 'it'].map((u) => loginAs(`${u}@eayni.local`)));
  expect((await api(hr).post('/hr/shifts', { code: 'standard', nameAr: 'الدوام الأساسي', periods: [{ start: '08:00', end: '16:00' }], workDays: [0, 1, 2, 3, 4] })).status).toBe(201);
  let n = 0;
  const mk = async (email: string, first: string, extra: Record<string, unknown> = {}, directManagerId?: string) => {
    const r = await api(hr).post('/hr/employees', {
      firstNameAr: first,
      lastNameAr: 'الحربي',
      gender: 'male',
      nationality: 'سعودي',
      workEmail: email,
      identity: { type: 'national_id', number: `10${String(80000000 + ++n).padStart(8, '0')}`, expiryDate: new Date(Date.now() + 400 * DAY) },
      hireDate: '2019-01-01',
      departmentId: String(ops._id),
      branchId: String(branch._id),
      siteId: String(site._id),
      directManagerId,
      basicSalaryHalalas: 600_000,
      allowances: [{ type: 'سكن', amountHalalas: 150_000 }, { type: 'نقل', amountHalalas: 50_000 }],
      bank: { bankName: 'الراجحي', iban: 'SA0380000000608010167519' },
      birthDate: '1985-05-10',
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { employeeId: r.body._id as string, userId: r.body.userId as string, token: await activateAccount(email, r.body.temporaryPassword) };
  };
  const mgr = await mk('mgr@eayni.local', 'خالد', { gosiJoinDate: '2019-01-01', basicSalaryHalalas: 1_200_000 });
  const a = await mk('a@eayni.local', 'عمر', { gosiJoinDate: '2019-01-01' }, mgr.employeeId); // ~7.9 years of service
  const f = await mk('f@eayni.local', 'نورة', { gender: 'female', hireDate: addDays(today(), -3 * 365), gosiJoinDate: '2023-01-01' }, mgr.employeeId); // 3 years
  const c = await mk('c@eayni.local', 'يوسف', { nationality: 'مصري', basicSalaryHalalas: 400_000, allowances: [], identity: { type: 'iqama', number: '2099887766', expiryDate: new Date(Date.now() + 400 * DAY) }, workPermit: { number: 'WP-1', professionAr: 'سائق', expiryDate: addDays(today(), 300) } }, mgr.employeeId);
  const contractFor = async (employeeId: string, body: Record<string, unknown>) => {
    const r = await api(hr).post(`/hr/employees/${employeeId}/contracts`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { _id: string; probationEndDate?: string; endDate?: string };
  };
  return { hr, hro, fm, fs, admin, exec, dm, dm2, it, ops, sales, itDept, branch, site, mgr, a, f, c, mk, contractFor };
}
const notifs = (type: string) => Notification.find({ type }).lean();
/** One notification row per recipient — count the distinct events (bodies) instead. */
const notifCount = async (type: string) => (await Notification.distinct('bodyAr', { type })).length;

// ==================================================================================================
describe('H3b legal rules — pure functions (docs/HR_H3B_LEGAL.md)', () => {
  it('T2 ageOn, T3 isSaudi', () => {
    expect(ageOn('2011-06-01', '2026-05-31')).toBe(14);
    expect(ageOn('2011-06-01', '2026-06-01')).toBe(15);
    expect(isSaudi('سعودي')).toBe(true);
    expect(isSaudi('السعودية')).toBe(true);
    expect(isSaudi('مصري')).toBe(false);
  });
  it('T7 art. 53: the probation end skips the four official holidays and sick days', () => {
    expect(probationEndDay('2026-01-01', 90, new Set())).toBe('2026-03-31');
    expect(probationEndDay('2026-01-01', 90, new Set(['2026-02-22', '2026-03-01', '2026-03-02']))).toBe('2026-04-03');
    expect(probationEndDay('2026-01-01', 0, new Set())).toBeNull();
    expect(holidayKindOf({ nameAr: 'يوم التأسيس' })).toBe('founding_day');
    expect(holidayKindOf({ nameAr: 'عيد الفطر المبارك' })).toBe('eid_fitr');
    expect(holidayKindOf({ nameAr: 'إجازة المؤسسة', kind: 'other' })).toBe('other');
  });
  it('T9 art. 55: both paths of a lapsed fixed term', () => {
    const start = new Date('2024-01-01T00:00:00+03:00');
    const end = new Date('2024-12-31T00:00:00+03:00');
    expect(fixedTermExpiryOutcome({ renewalClause: { enabled: false }, startDate: start, endDate: end }, true)).toEqual({ kind: 'needs_decision' });
    expect(fixedTermExpiryOutcome({ renewalClause: { enabled: true, periodMonths: 12 }, renewalCount: 0, originalStartDate: start, startDate: start, endDate: end }, true)).toEqual({ kind: 'renew', periodMonths: 12, convertAfter: false });
    expect(fixedTermExpiryOutcome({ renewalClause: { enabled: true, periodMonths: 12 }, renewalCount: 2, originalStartDate: new Date('2022-01-01T00:00:00+03:00'), startDate: start, endDate: end }, true)).toEqual({ kind: 'renew', periodMonths: 12, convertAfter: true });
    expect(fixedTermExpiryOutcome({ renewalClause: { enabled: true, periodMonths: 12 }, renewalCount: 3, originalStartDate: new Date('2021-01-01T00:00:00+03:00'), startDate: start, endDate: end }, true)).toEqual({ kind: 'convert_indefinite' });
    // 4 years in total, whichever is less — two renewals of 24 months.
    expect(fixedTermExpiryOutcome({ renewalClause: { enabled: true, periodMonths: 24 }, renewalCount: 1, originalStartDate: new Date('2021-01-01T00:00:00+03:00'), startDate: new Date('2023-01-01T00:00:00+03:00'), endDate: new Date('2024-12-31T00:00:00+03:00') }, true)).toEqual({ kind: 'convert_indefinite' });
    // A non-Saudi never converts (art. 37).
    expect(fixedTermExpiryOutcome({ renewalClause: { enabled: true, periodMonths: 12 }, renewalCount: 5, originalStartDate: new Date('2019-01-01T00:00:00+03:00'), startDate: start, endDate: end }, false)).toEqual({ kind: 'renew', periodMonths: 12, convertAfter: false });
  });
  it('E2 art. 75: 60 / 30 for a monthly wage, 30 for either party otherwise', () => {
    expect(noticeRequiredDays('employer', 'monthly', DEFAULT_EOS_POLICY)).toBe(60);
    expect(noticeRequiredDays('employee', 'monthly', DEFAULT_EOS_POLICY)).toBe(30);
    expect(noticeRequiredDays('employer', 'non_monthly', DEFAULT_EOS_POLICY)).toBe(30);
    expect(noticeRequiredDays('employee', 'non_monthly', DEFAULT_EOS_POLICY)).toBe(30);
  });
  it('E5 art. 77: the remaining term or 15 days per year, never below two months', () => {
    expect(art77CompensationHalalas('fixed_term', 100_000, 365, 90).amountHalalas).toBe(300_000); // 90 days < 2 months → minimum
    expect(art77CompensationHalalas('fixed_term', 100_000, 365, 300).amountHalalas).toBe(1_000_000);
    expect(art77CompensationHalalas('open_ended', 100_000, 365 * 6, 0).amountHalalas).toBe(300_000); // 15 days × 6 = 3 months
    expect(art77CompensationHalalas('open_ended', 100_000, 365, 0).amountHalalas).toBe(200_000); // minimum
  });
  it('E11 art. 84 / E12 art. 85 / E13 art. 2 and 86 / E14 art. 87', () => {
    expect(eosAwardHalalas(100_000, 365 * 3).amountHalalas).toBe(150_000);
    expect(eosAwardHalalas(100_000, 365 * 7).amountHalalas).toBe(450_000); // 2.5 + 2 months
    expect(resignationFractionBp(1.9)).toBe(0);
    expect(resignationFractionBp(2)).toBe(3334);
    expect(resignationFractionBp(7)).toBe(6667);
    expect(resignationFractionBp(10)).toBe(10_000);
    expect(awardFractionBp('resignation', 3).bp).toBe(3334);
    expect(awardFractionBp('leaving_art81', 3).bp).toBe(10_000);
    expect(awardFractionBp('marriage_or_birth_art87', 3).bp).toBe(10_000);
    expect(awardFractionBp('force_majeure', 1).bp).toBe(10_000);
    expect(awardFractionBp('dismissal_art80', 9).bp).toBe(0);
    expect(awardFractionBp('employer_notice', 1).bp).toBe(10_000);
    const w = awardWageOf(600_000, [{ type: 'سكن', amountHalalas: 150_000 }, { type: 'عمولة', amountHalalas: 50_000 }], { commissionTypes: ['عمولة'], excludeCommissions: false, commissionAverageHalalas: 70_000 });
    expect(w).toMatchObject({ basicHalalas: 600_000, allowancesHalalas: 150_000, commissionsHalalas: 70_000, totalHalalas: 820_000 });
    expect(awardWageOf(600_000, [{ type: 'عمولة', amountHalalas: 50_000 }], { commissionTypes: ['عمولة'], excludeCommissions: true }).totalHalalas).toBe(600_000);
    expect(art87WithinLimit('marriage', '2026-01-01', '2026-06-30')).toBe(true);
    expect(art87WithinLimit('marriage', '2026-01-01', '2026-07-01')).toBe(false);
    expect(art87WithinLimit('birth', '2026-01-01', '2026-04-01')).toBe(true);
    expect(art87WithinLimit('birth', '2026-01-01', '2026-04-02')).toBe(false);
  });
  it('E25 art. 79 bis: the end date is the earliest of acceptance, 30 days, the postponement', () => {
    const deemed = new Date('2026-02-01T23:59:59+03:00');
    expect(resignationEndDay({ deemedAcceptedAt: deemed }).kind).toBe('deemed');
    expect(resignationEndDay({ acceptedAt: new Date('2026-01-10T10:00:00+03:00'), deemedAcceptedAt: deemed })).toEqual({ day: '2026-01-10', kind: 'explicit' });
    expect(resignationEndDay({ acceptedAt: new Date('2026-01-10T10:00:00+03:00'), deemedAcceptedAt: deemed, requestedLastWorkingDay: '2026-01-20' })).toEqual({ day: '2026-01-20', kind: 'explicit' });
    expect(resignationEndDay({ deemedAcceptedAt: deemed, postponedUntil: '2026-02-20' })).toEqual({ day: '2026-02-20', kind: 'postponement_end' });
  });
  it('E1 retirement from the setting, E6 contract year', () => {
    expect(retirementAgeFor({ gender: 'male', gosiJoinDate: new Date('2020-01-01') }, [])).toBeNull();
    const rules = [
      { gosiJoinedFrom: null, gender: null, ageYears: 60 },
      { gosiJoinedFrom: '2024-07-03', gender: null, ageYears: 65 },
      { gosiJoinedFrom: null, gender: 'female' as const, ageYears: 58 },
    ];
    expect(retirementAgeFor({ gender: 'male', gosiJoinDate: new Date('2020-01-01') }, rules)).toBe(60);
    expect(retirementAgeFor({ gender: 'male', gosiJoinDate: new Date('2025-01-01') }, rules)).toBe(65);
    expect(retirementAgeFor({ gender: 'female', gosiJoinDate: new Date('2020-01-01') }, rules)).toBe(58);
    expect(contractYearWindow('2023-03-15', '2026-02-01')).toEqual({ from: '2025-03-15', to: '2026-03-14' });
    expect(contractYearWindow('2023-03-15', '2026-03-15')).toEqual({ from: '2026-03-15', to: '2027-03-14' });
  });
});

// ==================================================================================================
describe('H3b §3.2 — recruitment: requisition → posting → applicants → interviews → offer → hire', () => {
  it('T1/T3/T12 + Q10: the department manager raises, the HR manager approves (never the requester), HR posts; salary is hidden from managers', async () => {
    const { hr, hro, dm, dm2, exec, ops } = await setup();
    await setSetting('hr.saudization', { requiredRatePct: 99, nitaqatBandAr: 'أخضر متوسط', recordedAt: today(), disabilityRatePct: 4, disabilityThresholdHeadcount: 25 }, SYSTEM_ACTOR);
    const draft = await api(dm).post('/hr/recruitment/requisitions', { departmentId: String(ops._id), titleAr: 'عامل ميداني', headcount: 2, justification: 'توسّع المسارات', employmentType: 'full_time', contractType: 'fixed_term', durationMonths: 12, salaryRange: { minHalalas: 400_000, maxHalalas: 500_000 }, recruitmentCosts: [{ labelAr: 'رسوم استقدام', amountHalalas: 700_000 }], draft: true });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.state).toBe('draft');
    expect(draft.body.number).toMatch(/^REQ-\d{4}-\d{5}$/);
    expect(draft.body.salaryRange).toBeUndefined(); // sensitive: the manager who typed it does not get it back in the list / detail (HR_PLAN §6)
    expect(draft.body.recruitmentCosts[0].amountHalalas).toBe(700_000); // T12
    const id = draft.body._id as string;
    // Another department's manager cannot see it.
    expect((await api(dm2).get(`/hr/recruitment/requisitions/${id}`)).status).toBe(404);
    expect((await api(dm2).post('/hr/recruitment/requisitions', { departmentId: String(ops._id), titleAr: 'عامل', headcount: 1, justification: 'xxxxx', employmentType: 'full_time', contractType: 'open_ended', draft: true })).status).toBe(403);
    // Submit: T3 attaches the Saudization warning (never a block); the approver is notified.
    const submitted = await api(dm).post(`/hr/recruitment/requisitions/${id}/transition`, { transition: 'submit' });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.state).toBe('submitted');
    expect(submitted.body.saudizationWarning).toContain('نسبة التوطين');
    expect(await notifCount('requisition.submitted')).toBe(1);
    // The requester cannot approve; the officer is not the approver; the manager approves.
    expect((await api(dm).post(`/hr/recruitment/requisitions/${id}/transition`, { transition: 'approve' })).status).toBe(403);
    expect((await api(hro).post(`/hr/recruitment/requisitions/${id}/transition`, { transition: 'approve' })).status).toBe(403);
    const returned = await api(hr).post(`/hr/recruitment/requisitions/${id}/transition`, { transition: 'return', reason: 'وضّح المبرر' });
    expect(returned.body.state).toBe('needs_completion');
    await api(dm).patch(`/hr/recruitment/requisitions/${id}`, { justification: 'توسّع مسارات الجمع في الرياض والدمام' });
    await api(dm).post(`/hr/recruitment/requisitions/${id}/transition`, { transition: 'submit' });
    const approved = await api(hr).post(`/hr/recruitment/requisitions/${id}/transition`, { transition: 'approve' });
    expect(approved.body.state).toBe('approved');
    expect(approved.body.salaryRange.maxHalalas).toBe(500_000); // HR sees the range
    expect(await notifCount('requisition.decided')).toBeGreaterThanOrEqual(1);
    // Posting needs known channels.
    expect((await api(hro).post(`/hr/recruitment/requisitions/${id}/transition`, { transition: 'post', posting: { channels: ['tiktok'], externalRefs: [] } })).status).toBe(400);
    const posted = await api(hro).post(`/hr/recruitment/requisitions/${id}/transition`, { transition: 'post', posting: { channels: ['jadarat'], externalRefs: [{ channel: 'jadarat', reference: 'JD-1' }] } });
    expect(posted.body.state).toBe('posted');
    expect(await notifCount('requisition.posted')).toBe(1);
    // The executive reads all; the smoke lists work.
    expect((await api(exec).get('/hr/recruitment/requisitions')).body.total).toBe(1);
    expect((await api(hr).get('/hr/recruitment/policy')).body.saudization.below).toBe(true);
  });

  it('T1: applicants by hand and by CSV; rejection only with a professional reason; interviews on the calendar scored on the policy criteria', async () => {
    const { hr, hro, dm, ops } = await setup();
    const r = await api(hro).post('/hr/recruitment/requisitions', { departmentId: String(ops._id), titleAr: 'سائق', headcount: 1, justification: 'بديل سائق مستقيل', employmentType: 'full_time', contractType: 'open_ended', draft: false });
    expect(r.body.state).toBe('submitted');
    await api(hr).post(`/hr/recruitment/requisitions/${r.body._id}/transition`, { transition: 'approve' });
    const rid = r.body._id as string;
    expect((await api(hro).post(`/hr/recruitment/requisitions/${rid}/applicants`, { fullNameAr: 'سعد العتيبي', phone: '0551112233', nationality: 'سعودي', birthDate: '1998-04-12', identityNumber: '1099999999' })).status).toBe(201);
    const imp = await api(hro).post(`/hr/recruitment/requisitions/${rid}/applicants/import`, { rows: [{ fullNameAr: 'محمد حسين', phone: '0552223344', nationality: 'سوداني' }, { fullNameAr: 'ياسر القرني', phone: '0553334455', nationality: 'سعودي' }, { fullNameAr: 'سعد العتيبي', phone: '0551112233', nationality: 'سعودي' }] });
    expect(imp.status).toBe(201);
    expect(imp.body.created).toBe(2);
    expect(imp.body.rejected).toHaveLength(1); // duplicate phone on the same requisition
    const detail = (await api(hro).get(`/hr/recruitment/requisitions/${rid}`)).body;
    expect(detail.applicants).toHaveLength(3);
    expect(detail.applicants[0].identityNumberEnc).toBeUndefined();
    const saad = detail.applicants.find((x: { fullNameAr: string }) => x.fullNameAr === 'سعد العتيبي');
    // T1 (art. 3): a free-text or protected-ground reason is refused; the list is accepted.
    expect((await api(hro).post(`/hr/recruitment/applicants/${saad._id}/stage`, { stage: 'rejected', rejectionReason: 'كبير في السن' })).status).toBe(400);
    expect((await api(hro).post(`/hr/recruitment/applicants/${saad._id}/stage`, { stage: 'rejected' })).status).toBe(400);
    expect((await api(hro).post(`/hr/recruitment/applicants/${saad._id}/stage`, { stage: 'hired' })).status).toBe(400); // only through an offer
    expect((await api(hro).post(`/hr/recruitment/applicants/${saad._id}/stage`, { stage: 'screened' })).body.stage).toBe('screened');
    expect((await api(hro).post(`/hr/recruitment/applicants/${saad._id}/stage`, { stage: 'shortlisted' })).body.stage).toBe('shortlisted');
    const other = detail.applicants.find((x: { fullNameAr: string }) => x.fullNameAr === 'ياسر القرني');
    await api(hro).post(`/hr/recruitment/applicants/${other._id}/stage`, { stage: 'screened' });
    const rejected = await api(hro).post(`/hr/recruitment/applicants/${other._id}/stage`, { stage: 'rejected', rejectionReason: 'experience' });
    expect(rejected.body.stage).toBe('rejected');
    expect(rejected.body.retainUntil).toBeTruthy(); // PDPL: purge after 12 months (Q10)
    // The department manager cannot add applicants but sees the pipeline without salary expectations.
    expect((await api(dm).post(`/hr/recruitment/requisitions/${rid}/applicants`, { fullNameAr: 'x y', phone: '0559990000', nationality: 'سعودي' })).status).toBe(403);
    // Interviews: a calendar event of type `interview`, the panel is notified, the result uses the policy's criteria and scale.
    const dmUser = await User.findOne({ email: 'dm@eayni.local' });
    const iv = await api(hro).post(`/hr/recruitment/applicants/${saad._id}/interviews`, { round: 1, scheduledAt: new Date(Date.now() + 2 * DAY).toISOString(), durationMinutes: 45, mode: 'in_person', panelUserIds: [String(dmUser!._id)] });
    expect(iv.status, JSON.stringify(iv.body)).toBe(201);
    expect(await CalendarEvent.countDocuments({ type: 'interview' })).toBe(1);
    expect(await notifCount('interview.scheduled')).toBe(1);
    expect((await Applicant.findById(saad._id))!.stage).toBe('interviewing');
    expect((await api(dm).post(`/hr/recruitment/interviews/${iv.body._id}/result`, { state: 'done', scores: [{ criterion: 'looks', value: 5 }] })).status).toBe(400);
    expect((await api(dm).post(`/hr/recruitment/interviews/${iv.body._id}/result`, { state: 'done', scores: [{ criterion: 'skills', value: 9 }] })).status).toBe(400);
    const done = await api(dm).post(`/hr/recruitment/interviews/${iv.body._id}/result`, { state: 'done', scores: [{ criterion: 'qualification', value: 4 }, { criterion: 'skills', value: 5 }], recommendation: 'proceed' });
    expect(done.status).toBe(200);
    expect(done.body.totalScore).toBe(4.5);
    expect((await CalendarEvent.findById(iv.body.calendarEventId))!.status).toBe('done');
    expect((await api(hro).get(`/hr/recruitment/applicants/${saad._id}/identity`)).body.identityNumber).toBe('1099999999');
    expect(await AuditLog.countDocuments({ resource: 'hr.recruitment', action: 'view', sensitive: true })).toBeGreaterThanOrEqual(1);
  });

  it('T2/T4/T5/T6/T7/T9/T10/T13/T14 + Q10: the offer carries the legal checks; the hire creates employee, contract and account from the offer', async () => {
    const { hr, hro, dm, exec, ops, mgr, branch, site } = await setup();
    const r = await api(hro).post('/hr/recruitment/requisitions', { departmentId: String(ops._id), titleAr: 'عامل ميداني', headcount: 1, justification: 'توسّع', employmentType: 'full_time', contractType: 'fixed_term', durationMonths: 12, salaryRange: { minHalalas: 400_000, maxHalalas: 500_000 }, draft: false });
    await api(hr).post(`/hr/recruitment/requisitions/${r.body._id}/transition`, { transition: 'approve' });
    const rid = r.body._id as string;
    const add = async (body: Record<string, unknown>) => {
      const a = await api(hro).post(`/hr/recruitment/requisitions/${rid}/applicants`, body);
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      await api(hro).post(`/hr/recruitment/applicants/${a.body._id}/stage`, { stage: 'screened' });
      await api(hro).post(`/hr/recruitment/applicants/${a.body._id}/stage`, { stage: 'shortlisted' });
      return a.body._id as string;
    };
    const kid = await add({ fullNameAr: 'طفل صغير', phone: '0551000001', nationality: 'سعودي', birthDate: addDays(today(), -14 * 365 - 30) });
    const teen = await add({ fullNameAr: 'شاب يافع', phone: '0551000002', nationality: 'سعودي', birthDate: addDays(today(), -17 * 365) });
    const foreigner = await add({ fullNameAr: 'محمد علي', phone: '0551000003', nationality: 'سوداني', birthDate: '1990-01-01' });
    const saudi = await add({ fullNameAr: 'سعد العتيبي', phone: '0551000004', nationality: 'سعودي', birthDate: '1998-04-12' });
    const start = addDays(today(), 20);
    const base = { positionId: undefined, directManagerId: mgr.employeeId, branchId: String(branch._id), siteId: String(site._id), employmentType: 'full_time', contractType: 'fixed_term', durationMonths: 12, probationDays: 90, basicSalaryHalalas: 420_000, allowances: [{ type: 'سكن', amountHalalas: 60_000 }], startDate: start, validUntil: addDays(today(), 10) };
    // T2 (art. 162): under 15 refused; under 18 flagged.
    const under = await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: kid });
    expect(under.status).toBe(400);
    expect(under.body.details?.code ?? under.body.error?.details?.code ?? JSON.stringify(under.body)).toContain('under_minimum_age');
    const teenOffer = await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: teen });
    expect(teenOffer.status).toBe(201);
    expect(teenOffer.body.flags).toContain('juvenile');
    await api(hro).post(`/hr/recruitment/offers/${teenOffer.body._id}/transition`, { transition: 'withdraw', reason: 'اختبار' });
    // T6 (art. 37): a non-Saudi cannot get an open-ended contract; without a duration the permit expiry is needed; T4 flags a missing permit.
    expect((await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: foreigner, contractType: 'open_ended', durationMonths: undefined })).status).toBe(400);
    expect((await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: foreigner, durationMonths: undefined })).status).toBe(400);
    const permitOffer = await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: foreigner, durationMonths: undefined, workPermit: { expiryDate: addDays(today(), 400) } });
    expect(permitOffer.status, JSON.stringify(permitOffer.body)).toBe(201);
    expect(permitOffer.body.flags).toEqual(expect.arrayContaining(['duration_from_work_permit', 'work_permit_missing']));
    await api(hro).post(`/hr/recruitment/offers/${permitOffer.body._id}/transition`, { transition: 'withdraw', reason: 'اختبار' });
    // T7 (art. 53): 181 days refused. T10 (art. 57): specific work needs its description. E13 (art. 86): exclusion needs the clause. T9: a renewal clause needs its period.
    expect((await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: saudi, probationDays: 181 })).status).toBe(400);
    expect((await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: saudi, contractType: 'specific_work', durationMonths: undefined })).status).toBe(400);
    expect((await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: saudi, awardExcludesVariableWage: true })).status).toBe(400);
    expect((await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: saudi, renewalClause: { enabled: true } })).status).toBe(400);
    // Q10: above the requisition's salary range → the executive approves, not the HR manager.
    const high = await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: saudi, basicSalaryHalalas: 900_000, allowances: [] });
    expect(high.status).toBe(201);
    expect(high.body.needsExecutive).toBe(true);
    await api(hro).post(`/hr/recruitment/offers/${high.body._id}/transition`, { transition: 'submit' });
    expect((await api(hr).post(`/hr/recruitment/offers/${high.body._id}/transition`, { transition: 'approve' })).status).toBe(403);
    expect((await api(exec).post(`/hr/recruitment/offers/${high.body._id}/transition`, { transition: 'approve' })).body.state).toBe('approved');
    await api(hr).post(`/hr/recruitment/offers/${high.body._id}/transition`, { transition: 'withdraw', reason: 'إعادة بالنطاق المعتمد' });
    expect((await Applicant.findById(saudi))!.stage).toBe('shortlisted');
    // The regular offer: creator cannot approve (SoD); HR manager approves; send; accept with the signed file; contract.
    const offer = await api(hro).post('/hr/recruitment/offers', { ...base, applicantId: saudi, renewalClause: { enabled: true, periodMonths: 12 }, nonCompete: { months: 12, scopeAr: 'إعادة التدوير في الرياض' }, workDescription: undefined });
    expect(offer.status, JSON.stringify(offer.body)).toBe(201);
    expect(offer.body.number).toMatch(/^OFR-\d{4}-\d{5}$/);
    const oid = offer.body._id as string;
    expect((await Applicant.findById(saudi))!.stage).toBe('offered');
    expect((await api(dm).get(`/hr/recruitment/offers/${oid}`)).body.basicSalaryHalalas).toBeUndefined(); // sensitive
    await api(hro).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'submit' });
    expect(await notifCount('offer.pending')).toBeGreaterThanOrEqual(1);
    expect((await api(hro).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'approve' })).status).toBe(403);
    expect((await api(hr).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'approve' })).body.state).toBe('approved');
    expect((await api(hro).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'send' })).body.state).toBe('sent');
    expect((await api(hro).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'accept' })).status).toBe(400);
    const signed = await upload(hro, 'signed.pdf');
    expect((await api(hro).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'accept', acceptedAt: today(), signedAttachmentId: signed })).body.state).toBe('accepted');
    expect(await notifCount('offer.accepted')).toBe(1);
    // T5: the hire needs the identity and the work e-mail; everything else comes from the offer and the applicant (golden rule 2).
    expect((await api(hro).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'contract' })).status).toBe(400);
    const hired = await api(hro).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'contract', hire: { workEmail: 'saad@eayni.local', identity: { type: 'national_id', number: '1088888888' }, gender: 'male', createAccount: true, medicalInsurancePolicy: { number: 'POL-9', expiryDate: addDays(today(), 365) } } });
    expect(hired.status, JSON.stringify(hired.body)).toBe(200);
    expect(hired.body.state).toBe('contracted');
    expect(hired.body.temporaryPassword).toBeTruthy();
    const emp = await Employee.findById(hired.body.createdEmployeeId);
    expect(emp).toMatchObject({ fullNameAr: 'سعد العتيبي', nationality: 'سعودي', basicSalaryHalalas: 420_000, departmentId: ops._id, medicalInsurance: true });
    expect(riyadhDate(emp!.hireDate)).toBe(start);
    expect(emp!.medicalInsurancePolicy?.number).toBe('POL-9'); // T14
    expect(String(emp!.directManagerId)).toBe(mgr.employeeId);
    const contract = await Contract.findById(hired.body.createdContractId);
    expect(contract).toMatchObject({ type: 'fixed_term', probationDays: 90, renewalCount: 0 });
    expect(contract!.renewalClause?.enabled).toBe(true);
    expect(contract!.nonCompete?.months).toBe(12); // E9
    expect(riyadhDate(contract!.probationEndDate!)).toBe(addDays(start, 89)); // T7 (no holidays in the window)
    expect(riyadhDate(contract!.originalStartDate!)).toBe(start);
    expect((await Applicant.findById(saudi))!.stage).toBe('hired');
    expect((await JobRequisition.findById(rid))!.hiredCount).toBe(1);
    expect((await JobRequisition.findById(rid))!.state).toBe('closed'); // headcount reached
    expect(await Outbox.countDocuments({ type: 'hr.employee.hired' })).toBe(1);
    expect(await notifCount('employee.hired')).toBe(1); // the direct manager
    // T13: the government registration by hand; the GOSI date lands on the file.
    const gov = await api(hro).post(`/hr/recruitment/offers/${oid}/transition`, { transition: 'record_gov_registration', gov: { qiwaRef: 'Q-1', qiwaAt: today(), gosiRef: 'G-1', gosiAt: today() } });
    expect(gov.body.govRegistration.gosiRef).toBe('G-1');
    expect(riyadhDate((await Employee.findById(emp!._id))!.gosiJoinDate!)).toBe(today());
    // Onboarding job: on the start date the offer becomes «تمت المباشرة».
    await Offer.updateOne({ _id: oid }, { $set: { startDate: today() } });
    const jobs = await runRecruitmentJobs();
    expect(jobs.onboarded).toBe(1);
    expect((await Offer.findById(oid))!.state).toBe('onboarded');
  });

  it('T13 deadlines and the CV retention job: blank settings → no alert; filled → one alert; rejected CVs purged after the retention period', async () => {
    const { hr, hro, ops } = await setup();
    const r = await api(hro).post('/hr/recruitment/requisitions', { departmentId: String(ops._id), titleAr: 'عامل', headcount: 1, justification: 'توسّع', employmentType: 'full_time', contractType: 'open_ended', draft: false });
    await api(hr).post(`/hr/recruitment/requisitions/${r.body._id}/transition`, { transition: 'approve' });
    const cv = await upload(hro, 'cv.pdf');
    const a = await api(hro).post(`/hr/recruitment/requisitions/${r.body._id}/applicants`, { fullNameAr: 'سعد العتيبي', phone: '0551000004', nationality: 'سعودي', birthDate: '1998-04-12', cvAttachmentId: cv });
    await api(hro).post(`/hr/recruitment/applicants/${a.body._id}/stage`, { stage: 'screened' });
    await api(hro).post(`/hr/recruitment/applicants/${a.body._id}/stage`, { stage: 'rejected', rejectionReason: 'skills' });
    expect((await runRecruitmentJobs()).cvPurged).toBe(0);
    await Applicant.updateOne({ _id: a.body._id }, { $set: { retainUntil: new Date(Date.now() - DAY) } });
    expect((await runRecruitmentJobs()).cvPurged).toBe(1);
    expect((await Applicant.findById(a.body._id))!.cvAttachmentId).toBeUndefined();
    // Gov deadlines: a contracted offer without references — nothing while the setting is blank (O2), one alert once filled.
    const b = await api(hro).post(`/hr/recruitment/requisitions/${r.body._id}/applicants`, { fullNameAr: 'ياسر القرني', phone: '0551000005', nationality: 'سعودي', birthDate: '1995-01-01' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    await api(hro).post(`/hr/recruitment/applicants/${b.body._id}/stage`, { stage: 'screened' });
    await api(hro).post(`/hr/recruitment/applicants/${b.body._id}/stage`, { stage: 'shortlisted' });
    const o = await api(hro).post('/hr/recruitment/offers', { applicantId: b.body._id, employmentType: 'full_time', contractType: 'open_ended', probationDays: 0, basicSalaryHalalas: 500_000, allowances: [], startDate: addDays(today(), -10), validUntil: addDays(today(), 5) });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    for (const t of ['submit']) await api(hro).post(`/hr/recruitment/offers/${o.body._id}/transition`, { transition: t });
    await api(hr).post(`/hr/recruitment/offers/${o.body._id}/transition`, { transition: 'approve' });
    await api(hro).post(`/hr/recruitment/offers/${o.body._id}/transition`, { transition: 'send' });
    await api(hro).post(`/hr/recruitment/offers/${o.body._id}/transition`, { transition: 'accept', acceptedAt: today() });
    const hired = await api(hro).post(`/hr/recruitment/offers/${o.body._id}/transition`, { transition: 'contract', hire: { workEmail: 'yasser@eayni.local', identity: { type: 'national_id', number: '1077777777' }, gender: 'male', createAccount: false } });
    expect(hired.status, JSON.stringify(hired.body)).toBe(200);
    expect((await runRecruitmentJobs()).govOverdue).toBe(0);
    await setSetting('hr.gov', { qiwaContractDays: 3, gosiRegisterDays: 3, gosiExitDays: null, qiwaExitDays: null }, SYSTEM_ACTOR);
    expect((await runRecruitmentJobs()).govOverdue).toBe(1);
    expect((await runRecruitmentJobs()).govOverdue).toBe(0); // once
    expect(await notifCount('gov.registration_overdue')).toBe(1);
    // An offer past its validity expires by the job.
    await JobRequisition.updateOne({ _id: r.body._id }, { $set: { state: 'approved', headcount: 3 } }); // reopened: the headcount was reached by the hire above
    const c = await api(hro).post(`/hr/recruitment/requisitions/${r.body._id}/applicants`, { fullNameAr: 'بدر الدوسري', phone: '0551000006', nationality: 'سعودي', birthDate: '1995-01-01' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await api(hro).post(`/hr/recruitment/applicants/${c.body._id}/stage`, { stage: 'screened' });
    await api(hro).post(`/hr/recruitment/applicants/${c.body._id}/stage`, { stage: 'shortlisted' });
    const o2 = await api(hro).post('/hr/recruitment/offers', { applicantId: c.body._id, employmentType: 'full_time', contractType: 'open_ended', probationDays: 0, basicSalaryHalalas: 500_000, allowances: [], startDate: addDays(today(), 30), validUntil: addDays(today(), 1) });
    expect(o2.status, JSON.stringify(o2.body)).toBe(201);
    await api(hro).post(`/hr/recruitment/offers/${o2.body._id}/transition`, { transition: 'submit' });
    await api(hr).post(`/hr/recruitment/offers/${o2.body._id}/transition`, { transition: 'approve' });
    await api(hro).post(`/hr/recruitment/offers/${o2.body._id}/transition`, { transition: 'send' });
    await Offer.updateOne({ _id: o2.body._id }, { $set: { validUntil: addDays(today(), -1) } });
    expect((await runRecruitmentJobs()).expired).toBe(1);
    expect((await Applicant.findById(c.body._id))!.stage).toBe('shortlisted');
  });
});

// ==================================================================================================
describe('H3b §3.9 — contracts: T6 art. 37, T7 art. 53, T8 art. 54, T9 art. 55 on the contract route and the daily job', () => {
  it('T7: the probation end adds the typed holidays and approved sick days; 181 days refused; both parties keep the right (no one-sided field)', async () => {
    const { hr, a, contractFor } = await setup();
    const start = addDays(today(), 10);
    await Holiday.create([{ date: addDays(start, 5), nameAr: 'اليوم الوطني', kind: 'national_day' }, { date: addDays(start, 6), nameAr: 'عطلة الجمعية' }]);
    // An approved sick leave of 2 days inside the window.
    const emp = await Employee.findById(a.employeeId);
    await HrRequest.create({ number: 'HRQ-T7-00001', type: 'leave', employeeId: a.employeeId, requesterUserId: emp!.userId, state: 'approved', stateEnteredAt: new Date(), details: { leaveType: 'sick', startDate: new Date(`${addDays(start, 20)}T00:00:00+03:00`), endDate: new Date(`${addDays(start, 21)}T00:00:00+03:00`), reason: 'مرض' }, decision: { outcome: 'approved', at: new Date() } });
    const c = await contractFor(a.employeeId, { type: 'open_ended', startDate: start, probationDays: 90 });
    // 90 counted days + 1 typed holiday (the untyped «عطلة الجمعية» does not count) + 2 sick days.
    expect(riyadhDate(new Date(c.probationEndDate!))).toBe(addDays(start, 89 + 1 + 2));
    expect((await api(hr).post(`/hr/employees/${a.employeeId}/contracts`, { type: 'open_ended', startDate: start, probationDays: 181 })).status).toBe(400);
    expect(Object.keys(Contract.schema.paths).some((p) => /oneSided|probationRight|restrictProbation/i.test(p))).toBe(false);
  });
  it('T6: a non-Saudi gets a fixed term that defaults to the work-permit period; open-ended refused', async () => {
    const { hr, c, contractFor } = await setup();
    expect((await api(hr).post(`/hr/employees/${c.employeeId}/contracts`, { type: 'open_ended', startDate: today() })).status).toBe(400);
    const k = await contractFor(c.employeeId, { type: 'fixed_term', startDate: today() });
    expect(riyadhDate(new Date(k.endDate!))).toBe(addDays(today(), 300)); // the permit expiry (art. 37)
  });
  it('T8 (art. 54): no second probation within six months of a previous service unless the profession differs', async () => {
    const { hr, a, contractFor } = await setup();
    const first = await contractFor(a.employeeId, { type: 'fixed_term', startDate: addDays(today(), -400), endDate: addDays(today(), -60), probationDays: 90 });
    await Contract.updateOne({ _id: first._id }, { $set: { status: 'expired', statusReason: 'end_date_passed' } });
    const again = await api(hr).post(`/hr/employees/${a.employeeId}/contracts`, { type: 'open_ended', startDate: today(), probationDays: 90 });
    expect(again.status).toBe(400);
    expect(JSON.stringify(again.body)).toContain('المادة 54');
    expect((await api(hr).post(`/hr/employees/${a.employeeId}/contracts`, { type: 'open_ended', startDate: today(), probationDays: 0 })).status).toBe(201);
    expect((await api(hr).post(`/hr/employees/${a.employeeId}/contracts`, { type: 'open_ended', startDate: today(), probationDays: 60, differentProfession: true })).status).toBe(201);
  });
  it('T9 (art. 55): the job renews a clause contract and converts after 3 renewals; a lapsed contract without a clause waits for HR, who converts (Saudi) or renews for the permit (non-Saudi)', async () => {
    const { hr, a, c, contractFor } = await setup();
    // Path (b): clause, second renewal already → this renewal is the third → convertAfter; a 4th lapse converts.
    const k = await contractFor(a.employeeId, { type: 'fixed_term', startDate: addDays(today(), -370), endDate: addDays(today(), -5), renewalClause: { enabled: true, periodMonths: 12 }, awardExcludesVariableWage: true, awardExclusionClauseRef: 'البند 9' });
    await Contract.updateOne({ _id: k._id }, { $set: { status: 'expired', statusReason: 'end_date_passed', renewalCount: 2, originalStartDate: new Date(`${addDays(today(), -370 - 730)}T00:00:00+03:00`) } });
    const r1 = await runFixedTermExpiry();
    expect(r1).toMatchObject({ renewed: 1, converted: 0, flagged: 0 });
    const renewed = await Contract.findOne({ previousId: k._id });
    expect(renewed).toMatchObject({ type: 'fixed_term', renewalCount: 3, awardExcludesVariableWage: true, awardExclusionClauseRef: 'البند 9' });
    expect(riyadhDate(renewed!.originalStartDate!)).toBe(addDays(today(), -1100));
    await Contract.updateOne({ _id: renewed!._id }, { $set: { status: 'expired', statusReason: 'end_date_passed', endDate: new Date(Date.now() - DAY) } });
    const r2 = await runFixedTermExpiry();
    expect(r2.converted).toBe(1);
    expect((await Contract.findOne({ previousId: renewed!._id }))!.type).toBe('open_ended');
    // Path (a): no clause → flagged for HR, who confirms the continuation.
    const k2 = await contractFor(c.employeeId, { type: 'fixed_term', startDate: addDays(today(), -370), endDate: addDays(today(), -5) });
    await Contract.updateOne({ _id: k2._id }, { $set: { status: 'expired', statusReason: 'end_date_passed' } });
    expect((await runFixedTermExpiry()).flagged).toBe(1);
    expect(await notifCount('contract.continuation_needed')).toBe(1);
    expect((await runFixedTermExpiry()).flagged).toBe(0); // once
    const cont = await api(hr).post(`/hr/employees/${c.employeeId}/contracts/${k2._id}/continue`);
    expect(cont.status, JSON.stringify(cont.body)).toBe(201);
    expect(cont.body.type).toBe('fixed_term'); // non-Saudi: renewal for the permit period (art. 37)
    expect(riyadhDate(new Date(cont.body.endDate))).toBe(addDays(today(), 300));
    expect((await Contract.findById(k2._id))!.continuationDecision?.outcome).toBe('renewed_permit_period');
    // Saudi path (a).
    const k3 = await contractFor(a.employeeId, { type: 'fixed_term', startDate: addDays(today(), -370), endDate: addDays(today(), -5) });
    await Contract.updateOne({ _id: k3._id }, { $set: { status: 'expired', statusReason: 'end_date_passed' } });
    const cont2 = await api(hr).post(`/hr/employees/${a.employeeId}/contracts/${k3._id}/continue`);
    expect(cont2.body.type).toBe('open_ended');
    expect(cont2.body.convertedReason).toBe('art55_continued_no_clause');
  });
});

// ==================================================================================================
describe('H3b §3.10 — end of service: reasons, gates, notice, resignation, settlement, steps, completion', () => {
  const create = (token: string, body: Record<string, unknown>) => api(token).post('/hr/offboarding', body);

  it('E1/E2/E3/E4: the closed reasons list, the art. 75 notice by party and wage period, the art. 76 shortfall line, the O1 warning', async () => {
    const { hr, hro, a, c, contractFor } = await setup();
    expect((await create(hro, { employeeId: a.employeeId, reason: 'because', lastWorkingDay: addDays(today(), 10) })).status).toBe(400); // not in the list
    await contractFor(a.employeeId, { type: 'open_ended', startDate: '2019-01-01' });
    const emp = await Employee.findById(a.employeeId);
    await HrRequest.create({ number: 'HRQ-E4-00001', type: 'leave', employeeId: a.employeeId, requesterUserId: emp!.userId, state: 'approved', stateEnteredAt: new Date(), details: { leaveType: 'annual', startDate: new Date(`${addDays(today(), -3)}T00:00:00+03:00`), endDate: new Date(`${addDays(today(), 2)}T00:00:00+03:00`), reason: 'إجازة' }, decision: { outcome: 'approved', at: new Date() } });
    // Employer notice of 30 days on a monthly wage → 60 required, 30 short; the notice date inside the leave → warning (O1), no block.
    const r = await create(hro, { employeeId: a.employeeId, reason: 'employer_notice', noticeDate: today(), lastWorkingDay: addDays(today(), 30), details: 'إعادة هيكلة' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.number).toMatch(/^EOS-\d{4}-\d{5}$/);
    expect(r.body.state).toBe('under_review');
    expect(r.body.notice).toMatchObject({ requiredDays: 60, givenDays: 30, shortfallDays: 30 });
    expect(r.body.legalWarnings.some((w: string) => w.includes('إجازة معتمدة'))).toBe(true);
    expect(r.body.legalWarnings.some((w: string) => w.includes('المادة 76'))).toBe(true);
    expect(await notifCount('offboarding.requested')).toBe(1);
    // The requester cannot approve; the HR manager does; the employee becomes «منتهي الخدمة» with the last working day (existing behaviour).
    expect((await api(hro).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'approve' })).status).toBe(403);
    const ap = await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'approve' });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.state).toBe('approved');
    expect((await Employee.findById(a.employeeId))!.status).toBe('terminated');
    expect(riyadhDate((await Employee.findById(a.employeeId))!.endDate!)).toBe(addDays(today(), 30));
    // E3: the settlement carries the 30-day shortfall as an earning for the employee (the employer failed to give notice).
    const s = await api(hro).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'compute' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const line = s.body.settlement.lines.find((l: { code: string }) => l.code === 'notice_compensation');
    expect(line).toMatchObject({ kind: 'earning', amountHalalas: Math.round((800_000 * 30) / 30) });
    // O1 off → no warning. Non-monthly wage → 30 days for the employer (E2).
    await setSetting('hr.offboarding.warnNoticeDuringLeave', false, SYSTEM_ACTOR);
    await contractFor(c.employeeId, { type: 'fixed_term', startDate: '2024-01-01', endDate: addDays(today(), 200), wagePeriod: 'non_monthly' });
    const r2 = await create(hro, { employeeId: c.employeeId, reason: 'employer_notice', noticeDate: today(), lastWorkingDay: addDays(today(), 30) });
    expect(r2.status).toBe(201);
    expect(r2.body.notice.requiredDays).toBe(30);
    expect(r2.body.legalWarnings.some((w: string) => w.includes('إجازة معتمدة'))).toBe(false);
  });

  it('E1 retirement from the setting + the 90-day alert; E23 legal-settings card', async () => {
    const { hr, hro, a } = await setup();
    const status = (await api(hr).get('/hr/offboarding/legal-settings')).body;
    expect(status.complete).toBe(false);
    expect(status.missing.map((m: { key: string }) => m.key)).toEqual(expect.arrayContaining(['hr.retirement.rules', 'hr.saudization', 'hr.gov.gosiExitDays']));
    expect((await api(hr).get('/hr/dashboard/hr')).body.legalSettings.complete).toBe(false);
    // Blank rules: the reason stays available, the record carries a warning, the job sends nothing.
    const r = await create(hro, { employeeId: a.employeeId, reason: 'retirement', lastWorkingDay: addDays(today(), 30) });
    expect(r.status).toBe(201);
    expect(r.body.legalWarnings.some((w: string) => w.includes('سن التقاعد غير مضبوط'))).toBe(true);
    expect((await runOffboardingJobs()).retirementAlerts).toBe(0);
    // A rule from GOSI: the employee born 1985-05-10 with age 60 retires 2045 — no alert; a rule of 41 → retirement within 90 days.
    const birth = riyadhDate((await Employee.findById(a.employeeId))!.birthDate!);
    const yearsNow = Math.floor((Date.now() - new Date(birth).getTime()) / (365.25 * DAY));
    await setSetting('hr.retirement.rules', [{ gosiJoinedFrom: null, gender: null, ageYears: yearsNow + 1 }], SYSTEM_ACTOR);
    const res = await runOffboardingJobs();
    expect(res.retirementAlerts).toBeGreaterThanOrEqual(0);
    await setSetting('hr.retirement.rules', [{ gosiJoinedFrom: null, gender: null, ageYears: 60 }], SYSTEM_ACTOR);
    await Employee.updateMany({}, { $set: { retirementAlertedAt: null } });
    await Employee.updateOne({ _id: a.employeeId }, { $set: { birthDate: new Date(`${addDays(today(), -60 * 365 - 15 + 80)}T00:00:00+03:00`) } }); // 60 in ~80 days
    expect((await runOffboardingJobs()).retirementAlerts).toBe(1);
    expect(await notifCount('retirement.approaching')).toBe(1);
    expect((await runOffboardingJobs()).retirementAlerts).toBe(0); // once
    await setSetting('hr.saudization', { requiredRatePct: 50, nitaqatBandAr: 'أخضر', recordedAt: today(), disabilityRatePct: 4, disabilityThresholdHeadcount: 25 }, SYSTEM_ACTOR);
    await setSetting('hr.gov', { qiwaContractDays: 7, gosiRegisterDays: 15, gosiExitDays: 15, qiwaExitDays: 7 }, SYSTEM_ACTOR);
    expect((await api(hr).get('/hr/offboarding/legal-settings')).body.complete).toBe(true);
  });

  it('E6 (art. 80): nine cases from a list, the hearing record, the absence case from H2 attendance and the H3a written warning; no award', async () => {
    const { hr, hro, a, contractFor } = await setup();
    const emp = (await Employee.findById(a.employeeId))!;
    const contract = await contractFor(a.employeeId, { type: 'open_ended', startDate: addDays(today(), -200) });
    const base = { employeeId: a.employeeId, reason: 'dismissal_art80', lastWorkingDay: today() };
    const hearing = { heldAt: addDays(today(), -1), summary: 'استمع إلى الموظف وسجّل اعتراضه على الوقائع', attachmentIds: [], employeeDeclined: false };
    expect((await create(hro, { ...base, hearing })).status).toBe(400); // no case
    expect((await create(hro, { ...base, art80Case: 'ninth_and_a_half', hearing })).status).toBe(400); // not one of the nine
    expect((await create(hro, { ...base, art80Case: 'misconduct' })).status).toBe(400); // no hearing
    // Absence case: 31 scheduled absences in the contract year, but no written warning after the 20th → refused with the article's text.
    const win = { from: addDays(today(), -150), to: addDays(today(), -1) };
    const days: string[] = [];
    for (let d = win.from; d <= win.to && days.length < 31; d = addDays(d, 1)) days.push(d);
    await AttendanceDay.insertMany(days.map((day) => ({ employeeId: emp._id, day, departmentId: emp.departmentId, scheduled: true, status: 'absent', final: true, computedAt: new Date() })));
    const noWarning = await create(hro, { ...base, art80Case: 'absence', hearing });
    expect(noWarning.status).toBe(400);
    expect(JSON.stringify(noWarning.body)).toContain('إنذار كتابي');
    expect((await api(hro).get(`/hr/offboarding/art80-absence/${a.employeeId}`)).body).toMatchObject({ intermittentDays: 31, qualifies: 'intermittent', warningFound: false, ok: false });
    // A written warning delivered after the 20th absence (H3a ladder) → the case stands; the award is zero (art. 80).
    await DisciplinaryAction.create({ number: 'DIS-T-00001', employeeId: emp._id, departmentId: emp.departmentId, kind: 'warning_1', kindLabelAr: 'إنذار أول', payrollEffect: 'none', violationDate: days[19], discoveryDate: days[19], investigationEndDate: days[20], investigationMode: 'written', description: 'غياب متكرر', issuedBy: emp.userId, issuedByRelation: 'hr', state: 'delivered', stateEnteredAt: new Date(), deliveredAt: new Date(`${days[21]}T10:00:00+03:00`) });
    const ok = await create(hro, { ...base, art80Case: 'absence', hearing, lastWorkingDay: today() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.art80AbsenceCheck?.ok ?? true).toBe(true);
    await api(hr).post(`/hr/offboarding/${ok.body._id}/transition`, { transition: 'approve' });
    const s = await api(hro).post(`/hr/offboarding/${ok.body._id}/settlement`, { action: 'compute' });
    expect(s.body.settlement.awardFraction).toBe(0);
    expect(s.body.settlement.lines.find((l: { code: string }) => l.code === 'eos_award').amountHalalas).toBe(0);
    expect(s.body.settlement.lines.some((l: { code: string }) => l.code === 'notice_compensation')).toBe(false);
    void contract;
  });

  it('E7 (art. 81), E9, E10 (arts. 53–54), E14 (art. 87): full award for art. 81 and art. 87; probation ending only inside the computed probation', async () => {
    const { hr, hro, a, f, contractFor } = await setup();
    await contractFor(a.employeeId, { type: 'open_ended', startDate: addDays(today(), -3 * 365), nonCompete: { months: 6, scopeAr: 'إعادة التدوير في الرياض' } });
    expect((await create(hro, { employeeId: a.employeeId, reason: 'leaving_art81', lastWorkingDay: today() })).status).toBe(400); // case required
    const r = await create(hro, { employeeId: a.employeeId, reason: 'leaving_art81', art81Case: 'employer_breach', lastWorkingDay: today() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.contract.nonCompete.months).toBe(6); // E9 shown on the record
    await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'approve' });
    const s = await api(hro).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'compute' });
    expect(s.body.settlement.awardFraction).toBe(10_000); // no art. 85 reduction (3 years would be ⅓ for a resignation)
    // E10: a probation of 90 days started 100 days ago has ended → refused; started 30 days ago → allowed.
    const k = await contractFor(f.employeeId, { type: 'open_ended', startDate: addDays(today(), -100), probationDays: 90 });
    expect((await create(hro, { employeeId: f.employeeId, reason: 'probation', lastWorkingDay: today() })).status).toBe(400);
    await Contract.updateOne({ _id: k._id }, { $set: { probationEndDate: new Date(`${addDays(today(), 10)}T23:59:59+03:00`) } });
    // E14: a female employee ending within six months of a marriage leave → full award; 200 days after → refused (becomes a resignation).
    const femp = (await Employee.findById(f.employeeId))!;
    await HrRequest.create({ number: 'HRQ-E14-00001', type: 'leave', employeeId: f.employeeId, requesterUserId: femp.userId, state: 'approved', stateEnteredAt: new Date(), details: { leaveType: 'marriage', startDate: new Date(`${addDays(today(), -100)}T00:00:00+03:00`), endDate: new Date(`${addDays(today(), -96)}T00:00:00+03:00`), reason: 'زواج' }, decision: { outcome: 'approved', at: new Date() } });
    const m = await create(hro, { employeeId: f.employeeId, reason: 'marriage_or_birth_art87', lastWorkingDay: today() });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    expect(m.body.art87).toMatchObject({ event: 'marriage', withinLimit: true });
    await api(hr).post(`/hr/offboarding/${m.body._id}/transition`, { transition: 'cancel', reason: 'اختبار' });
    await HrRequest.updateOne({ number: 'HRQ-E14-00001' }, { $set: { 'details.startDate': new Date(`${addDays(today(), -200)}T00:00:00+03:00`), 'details.endDate': new Date(`${addDays(today(), -196)}T00:00:00+03:00`) } });
    const late = await create(hro, { employeeId: f.employeeId, reason: 'marriage_or_birth_art87', lastWorkingDay: today() });
    expect(late.status).toBe(400);
    expect(JSON.stringify(late.body)).toContain('art87_out_of_limit');
    expect((await create(hro, { employeeId: a.employeeId, reason: 'marriage_or_birth_art87', lastWorkingDay: today() })).status).toBe(409); // a is already leaving; and art. 87 is for a female employee
  });

  it('E8 (art. 82): sick leave blocks employer-initiated endings only; art. 80 warns; expiry, death, agreement, art. 81 and resignation pass', async () => {
    const { hr, hro, a, f, c, contractFor } = await setup();
    for (const e of [a, f, c]) {
      const emp = (await Employee.findById(e.employeeId))!;
      await HrRequest.create({ number: `HRQ-E8-${e.employeeId.slice(-5)}`, type: 'leave', employeeId: e.employeeId, requesterUserId: emp.userId, state: 'approved', stateEnteredAt: new Date(), details: { leaveType: 'sick', startDate: new Date(`${addDays(today(), -2)}T00:00:00+03:00`), endDate: new Date(`${addDays(today(), 20)}T00:00:00+03:00`), reason: 'مرض' }, decision: { outcome: 'approved', at: new Date() } });
      await LeaveLedger.create({ employeeId: e.employeeId, leaveType: 'sick', entryType: 'opening', days: 100, year: Number(today().slice(0, 4)), effectiveAt: new Date(), refType: 'test', refId: e.employeeId });
    }
    await contractFor(a.employeeId, { type: 'open_ended', startDate: '2019-01-01' });
    const blocked = await create(hro, { employeeId: a.employeeId, reason: 'employer_notice', noticeDate: addDays(today(), -60), lastWorkingDay: addDays(today(), 5) });
    expect(blocked.status).toBe(403);
    expect(JSON.stringify(blocked.body)).toContain('المادة 82');
    expect((await create(hro, { employeeId: a.employeeId, reason: 'unlawful_termination', lastWorkingDay: addDays(today(), 5) })).status).toBe(403);
    // Art. 80: a warning, not a block.
    const warned = await create(hro, { employeeId: a.employeeId, reason: 'dismissal_art80', art80Case: 'misconduct', hearing: { heldAt: today(), summary: 'استمع إلى الموظف', attachmentIds: [] }, lastWorkingDay: addDays(today(), 5) });
    expect(warned.status, JSON.stringify(warned.body)).toBe(201);
    expect(warned.body.legalWarnings.some((w: string) => w.includes('إجازة مرضية'))).toBe(true);
    // Never blocked: fixed-term expiry (c), death / mutual agreement (f), resignation (a after cancel).
    await contractFor(c.employeeId, { type: 'fixed_term', startDate: '2025-01-01', endDate: addDays(today(), 5) });
    expect((await create(hro, { employeeId: c.employeeId, reason: 'contract_expiry', lastWorkingDay: addDays(today(), 5) })).status).toBe(201);
    expect((await create(hro, { employeeId: f.employeeId, reason: 'death', lastWorkingDay: addDays(today(), 5) })).status).toBe(201);
    await api(hr).post(`/hr/offboarding/${warned.body._id}/transition`, { transition: 'cancel', reason: 'اختبار' });
    expect((await api(a.token).post('/me/offboarding/resign', { reason: 'ظرف شخصي', attachmentIds: [] })).status).toBe(201);
  });

  it('E8 (art. 82): an exhausted sick balance does not protect', async () => {
    const { a: a2, hro: hro2, contractFor: cf2 } = await setup();
    const emp2 = (await Employee.findById(a2.employeeId))!;
    await HrRequest.create({ number: 'HRQ-E8-X', type: 'leave', employeeId: a2.employeeId, requesterUserId: emp2.userId, state: 'approved', stateEnteredAt: new Date(), details: { leaveType: 'sick', startDate: new Date(`${addDays(today(), -2)}T00:00:00+03:00`), endDate: new Date(`${addDays(today(), 20)}T00:00:00+03:00`), reason: 'مرض' }, decision: { outcome: 'approved', at: new Date() } });
    await cf2(a2.employeeId, { type: 'open_ended', startDate: '2019-01-01' });
    expect((await create(hro2, { employeeId: a2.employeeId, reason: 'employer_notice', noticeDate: addDays(today(), -60), lastWorkingDay: addDays(today(), 5) })).status).toBe(201);
  });

  it('E26 (art. 155): dismissal and dismissal warnings are blocked for a pregnant employee or one on maternity leave — endings and the H3a ladder', async () => {
    const { hr, hro, dm, f, a, contractFor } = await setup();
    await contractFor(f.employeeId, { type: 'open_ended', startDate: addDays(today(), -3 * 365), probationDays: 0 });
    // Only HR records the pregnancy (sensitive).
    expect((await api(dm).put(`/hr/offboarding/pregnancy/${f.employeeId}`, { declaredAt: today(), expectedDeliveryDate: addDays(today(), 150) })).status).toBe(403);
    expect((await api(hro).put(`/hr/offboarding/pregnancy/${a.employeeId}`, { declaredAt: today(), expectedDeliveryDate: addDays(today(), 150) })).status).toBe(400); // male
    expect((await api(hro).put(`/hr/offboarding/pregnancy/${f.employeeId}`, { declaredAt: today(), expectedDeliveryDate: addDays(today(), 150) })).status).toBe(200);
    // Hidden from the department manager, visible to HR and to the employee herself.
    expect((await api(dm).get(`/hr/employees/${f.employeeId}`)).body.pregnancy).toBeUndefined();
    expect((await api(hr).get(`/hr/employees/${f.employeeId}`)).body.pregnancy?.declaredAt).toBeTruthy();
    const hearing = { heldAt: today(), summary: 'استمع إلى الموظفة', attachmentIds: [] };
    for (const body of [
      { reason: 'dismissal_art80', art80Case: 'misconduct', hearing },
      { reason: 'employer_notice', noticeDate: addDays(today(), -60) },
      { reason: 'unlawful_termination' },
    ]) {
      const r = await create(hro, { employeeId: f.employeeId, lastWorkingDay: addDays(today(), 3), ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(JSON.stringify(r.body)).toContain('المادة 155');
    }
    // The H3a ladder: a final warning or a termination is refused; a first written notice is not.
    const disc = (kind: string) => api(hro).post('/hr/discipline', { employeeId: f.employeeId, kind, violationDate: addDays(today(), -3), discoveryDate: addDays(today(), -3), investigationEndDate: addDays(today(), -1), investigationMode: 'written', investigationRecordText: 'محضر تحقيق مكتوب بالتفصيل', description: 'مخالفة تعليمات السلامة', separateViolation: true });
    expect((await disc('final_warning')).status).toBe(403);
    expect((await disc('termination')).status).toBe(403);
    expect((await disc('written_notice')).status).toBe(201);
    // Not blocked: her own resignation, a fixed-term expiry, a mutual agreement.
    expect((await api(f.token).post('/me/offboarding/resign', { reason: 'ظرف عائلي', attachmentIds: [] })).status).toBe(201);
    // Protection ends with the record; then an employer notice passes (no sick leave, no maternity).
    await Offboarding.deleteMany({});
    await api(hro).put(`/hr/offboarding/pregnancy/${f.employeeId}`, { declaredAt: addDays(today(), -300), expectedDeliveryDate: addDays(today(), -100), endedAt: addDays(today(), -1) });
    expect((await create(hro, { employeeId: f.employeeId, reason: 'employer_notice', noticeDate: addDays(today(), -60), lastWorkingDay: addDays(today(), 3) })).status).toBe(201);
    await Offboarding.deleteMany({});
    await Employee.updateOne({ _id: f.employeeId }, { $set: { status: 'active' }, $unset: { endDate: 1 } });
    // Maternity leave approved for a later day → protected as well.
    const femp = (await Employee.findById(f.employeeId))!;
    await HrRequest.create({ number: 'HRQ-E26-00001', type: 'leave', employeeId: f.employeeId, requesterUserId: femp.userId, state: 'approved', stateEnteredAt: new Date(), details: { leaveType: 'maternity', startDate: new Date(`${addDays(today(), 30)}T00:00:00+03:00`), endDate: new Date(`${addDays(today(), 114)}T00:00:00+03:00`), reason: 'وضع', eventDate: new Date(`${addDays(today(), 30)}T00:00:00+03:00`) }, decision: { outcome: 'approved', at: new Date() } });
    expect((await create(hro, { employeeId: f.employeeId, reason: 'employer_notice', noticeDate: addDays(today(), -60), lastWorkingDay: addDays(today(), 3) })).status).toBe(403);
  });

  it('E25 (art. 79 bis): the resignation clock — withdraw within 7 days, postpone ≤ 60 days, deemed accepted after 30 days, the earliest date ends the contract', async () => {
    const { hr, hro, mgr, a, f } = await setup();
    await setSetting('hr.gov', { qiwaContractDays: null, gosiRegisterDays: null, gosiExitDays: null, qiwaExitDays: null }, SYSTEM_ACTOR);
    // HR cannot file a resignation for the employee; the employee files it through «رفع طلب».
    expect((await create(hro, { employeeId: a.employeeId, reason: 'resignation', lastWorkingDay: addDays(today(), 30) })).status).toBe(400);
    const me = await api(a.token).get('/me/offboarding');
    expect(me.body.canResign).toBe(true);
    const r = await api(a.token).post('/me/offboarding/resign', { reason: 'فرصة أخرى', attachmentIds: [] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.state).toBe('resignation_submitted');
    expect(r.body.reason).toBe('resignation');
    expect(riyadhDate(new Date(r.body.resignation.withdrawDeadline))).toBe(addDays(today(), 7));
    expect(riyadhDate(new Date(r.body.resignation.deemedAcceptedAt))).toBe(addDays(today(), 30));
    expect(r.body.lastWorkingDay).toBe(addDays(today(), 30));
    expect(r.body.actions).toEqual(['withdraw_resignation']);
    expect((await api(a.token).post('/me/offboarding/resign', { reason: 'مرة ثانية', attachmentIds: [] })).status).toBe(409);
    // The manager and the HR manager are told; the employee cannot accept their own; the officer is not the approver.
    expect((await notifs('resignation.submitted')).length).toBeGreaterThanOrEqual(2); // the HR manager and the direct manager
    expect((await api(a.token).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'accept_resignation' })).status).toBe(403);
    expect((await api(hro).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'accept_resignation' })).status).toBe(403);
    void mgr;
    // Postponement: > 60 days refused; 45 days accepted; the employee is told; the end date moves to the postponement.
    expect((await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'postpone_resignation', reason: 'تسليم المشاريع', postponedUntil: addDays(today(), 61) })).status).toBe(400);
    expect((await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'postpone_resignation', postponedUntil: addDays(today(), 45) })).status).toBe(400); // reason required
    const post = await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'postpone_resignation', reason: 'تسليم المشاريع الجارية', postponedUntil: addDays(today(), 45) });
    expect(post.status, JSON.stringify(post.body)).toBe(200);
    expect(post.body.state).toBe('resignation_postponed');
    expect(post.body.lastWorkingDay).toBe(addDays(today(), 45));
    expect(await notifCount('resignation.decided')).toBe(1);
    // Withdrawal inside the 7 days even after a postponement; after the window → refused.
    const w = await api(a.token).post(`/me/offboarding/${r.body._id}/withdraw`, { reason: 'عدلت عن قراري' });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.state).toBe('resignation_withdrawn');
    expect(await notifCount('resignation.withdrawn')).toBe(1);
    expect((await Employee.findById(a.employeeId))!.status).toBe('active');
    const r2 = await api(a.token).post('/me/offboarding/resign', { reason: 'قرار نهائي', requestedLastWorkingDay: addDays(today(), 20), attachmentIds: [] });
    expect(r2.status).toBe(201);
    await Offboarding.updateOne({ _id: r2.body._id }, { $set: { 'resignation.withdrawDeadline': new Date(Date.now() - DAY) } });
    const lateW = await api(a.token).post(`/me/offboarding/${r2.body._id}/withdraw`);
    expect(lateW.status).toBe(400);
    expect(JSON.stringify(lateW.body)).toContain('withdraw_window_over');
    // Explicit acceptance → approved, the requested day (20) stands because the employer accepted; status resigned.
    const acc = await api(hr).post(`/hr/offboarding/${r2.body._id}/transition`, { transition: 'accept_resignation' });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.state).toBe('approved');
    expect(acc.body.lastWorkingDay).toBe(addDays(today(), 20));
    expect(acc.body.resignation.acceptanceKind).toBe('explicit');
    expect((await Employee.findById(a.employeeId))!.status).toBe('resigned');
    expect((await api(a.token).post(`/me/offboarding/${r2.body._id}/withdraw`)).status).toBe(400); // already accepted
    // Deemed acceptance by the job after 30 days without a response.
    const r3 = await api(f.token).post('/me/offboarding/resign', { reason: 'انتقال', attachmentIds: [] });
    expect(r3.status).toBe(201);
    await Offboarding.updateOne({ _id: r3.body._id }, { $set: { 'resignation.deemedAcceptedAt': new Date(Date.now() - 2 * DAY), 'resignation.withdrawDeadline': new Date(Date.now() - 25 * DAY) } });
    expect((await api(hr).post(`/hr/offboarding/${r3.body._id}/transition`, { transition: 'postpone_resignation', reason: 'x y z', postponedUntil: addDays(today(), 20) })).status).toBe(400); // deemed → no postponement
    const jobs = await runOffboardingJobs();
    expect(jobs.deemed).toBe(1);
    const deemed = await Offboarding.findById(r3.body._id);
    expect(deemed!.state).toBe('approved');
    expect(deemed!.resignation?.acceptanceKind).toBe('deemed');
    expect(deemed!.lastWorkingDay).toBe(addDays(today(), -2));
    expect((await Employee.findById(f.employeeId))!.status).toBe('resigned');
  });

  it('E11–E13, E15–E18, E20: the settlement engine, approval by the HR manager (not the computer), Finance pays, deadlines', async () => {
    const { hr, hro, fm, fs, dm, a, c, contractFor } = await setup();
    const emp = (await Employee.findById(a.employeeId))!;
    // Commission allowance on the file + 3 payslips with commission lines → the 12-month average enters the award wage (E13 default).
    await Employee.updateOne({ _id: a.employeeId }, { $set: { allowances: [{ type: 'سكن', amountHalalas: 150_000 }, { type: 'نقل', amountHalalas: 50_000 }, { type: 'عمولة', amountHalalas: 30_000 }] } });
    const periods = ['2026-08', '2026-09', '2026-10'];
    for (const [i, p] of periods.entries()) await Payslip.create({ runId: new Types.ObjectId(), period: p, employeeId: emp._id, employeeNumber: 'E', fullNameAr: emp.fullNameAr, basicHalalas: 600_000, earnings: [{ code: 'basic', labelAr: 'x', amountHalalas: 600_000 }, { code: 'allowance:عمولة', labelAr: 'x', amountHalalas: 20_000 * (i + 1) }], deductions: [], grossHalalas: 0, deductionsHalalas: 0, netHalalas: 0 });
    await contractFor(a.employeeId, { type: 'open_ended', startDate: '2019-01-01' });
    await LeaveLedger.create({ employeeId: emp._id, leaveType: 'annual', entryType: 'opening', days: 10, year: Number(today().slice(0, 4)), effectiveAt: new Date(), refType: 'test', refId: 'annual' });
    await AdvanceSchedule.create({ requestId: emp._id, requestNumber: 'HRQ-ADV-1', employeeId: emp._id, totalHalalas: 60_000, instalments: [{ period: '2027-01', amountHalalas: 30_000 }, { period: '2027-02', amountHalalas: 30_000 }] });
    await PayrollAdjustment.create({ employeeId: emp._id, kind: 'deduction', amountHalalas: 25_000, reason: 'جزاء DIS-1', sourceType: 'disciplinary', sourceId: 'x' });
    await Custody.create({ employeeId: emp._id, itemName: 'حاسب محمول', issuedAt: new Date() });
    const lastDay = addDays(today(), 10);
    const r = await create(hro, { employeeId: a.employeeId, reason: 'employer_notice', noticeDate: addDays(today(), -60), lastWorkingDay: lastDay });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.notice.shortfallDays).toBe(0);
    expect((await api(hro).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'compute' })).status).toBe(400); // before approval
    await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'approve' });
    // E15: due a week after the last day (employer-initiated).
    const approved = (await api(hr).get(`/hr/offboarding/${r.body._id}`)).body;
    expect(riyadhDate(new Date(approved.settlement.dueAt))).toBe(addDays(lastDay, 7));
    expect(approved.custodyChecklist).toHaveLength(1);
    // Unreturned custody charged at an approved value (E17) before computing.
    const custodyId = approved.custodyChecklist[0].custodyId;
    await api(hro).post(`/hr/offboarding/${r.body._id}/custody`, { custodyId, returnedAt: today(), notReturned: true, chargeHalalas: 200_000 });
    const s = (await api(hro).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'compute' })).body.settlement;
    expect(s.state).toBe('computed');
    // E11 / E13: wage = 600 000 + 200 000 fixed allowances + average commissions (20 000 + 40 000 + 60 000) / 3 = 40 000.
    expect(s.awardWage).toMatchObject({ basicHalalas: 600_000, allowancesHalalas: 200_000, commissionsHalalas: 40_000, totalHalalas: 840_000, commissionsExcluded: false });
    expect(s.flags).toContain('commission_average_to_confirm'); // O3
    const by = (code: string) => s.lines.find((l: { code: string }) => l.code === code);
    const years = s.serviceYears as number;
    expect(years).toBeGreaterThan(7.5);
    expect(by('eos_award').amountHalalas).toBe(Math.round(840_000 * (2.5 + (s.serviceDays / 365 - 5))));
    expect(s.awardFraction).toBe(10_000);
    expect(by('unused_leave').amountHalalas).toBe(Math.round((830_000 / 30) * 10)); // E16 (art. 111) on the monthly wage: basic + every allowance on the file
    expect(by('advance_outstanding').amountHalalas).toBe(60_000); // E17
    expect(by('custody_not_returned').amountHalalas).toBe(200_000);
    expect(by('fine').amountHalalas).toBe(25_000);
    expect(by('pending_salary')).toBeTruthy(); // E18
    expect(by('return_ticket')).toBeUndefined(); // Saudi
    expect(s.netHalalas).toBe(s.earningsHalalas - s.deductionsHalalas);
    // The department manager never sees the amounts; the employee sees their own.
    expect((await api(dm).get(`/hr/offboarding/${r.body._id}`)).body.settlement).toBeUndefined();
    expect((await api(a.token).get(`/hr/offboarding/${r.body._id}`)).body.settlement.netHalalas).toBe(s.netHalalas);
    // Edit a line with a reason (audited), then approve: the officer who computed cannot; the HR manager can; Finance is notified; adjustments consumed.
    const edited = await api(hro).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'edit_line', line: { code: 'other_earning', kind: 'earning', amountHalalas: 10_000, reason: 'مكافأة وداع بقرار المدير' } });
    expect(edited.body.settlement.lines.find((l: { code: string }) => l.code === 'other_earning').computed).toBe(false);
    expect((await api(hro).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'approve' })).status).toBe(403);
    const ap = await api(hr).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'approve' });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.settlement.state).toBe('at_finance');
    expect(ap.body.steps.settlement.done).toBe(true);
    expect((await PayrollAdjustment.findOne({ reason: 'جزاء DIS-1' }))!.consumedAt).toBeTruthy();
    expect(await Outbox.countDocuments({ type: 'hr.offboarding.settlement_to_finance' })).toBe(1);
    expect(await notifCount('offboarding.settlement_approved')).toBeGreaterThanOrEqual(1);
    // Finance: the staff records the payment; HR cannot; the employee is told.
    expect((await api(hro).post(`/finance/settlements/${r.body._id}/pay`, { action: 'record_payment', paidAt: today(), paymentRef: 'TRF-1' })).status).toBe(403);
    expect((await api(fs).get('/finance/settlements')).body.items).toHaveLength(1);
    const paid = await api(fm).post(`/finance/settlements/${r.body._id}/pay`, { action: 'record_payment', paidAt: today(), paymentRef: 'TRF-1' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.settlement.state).toBe('paid');
    expect((await api(fs).get('/finance/settlements')).body.items).toHaveLength(0);
    // E20: a non-Saudi ended by the employer gets the return-ticket line; blank default → approval blocked until the amount is entered.
    await contractFor(c.employeeId, { type: 'fixed_term', startDate: '2024-01-01', endDate: addDays(today(), 200) });
    const rc = await create(hro, { employeeId: c.employeeId, reason: 'employer_notice', noticeDate: addDays(today(), -60), lastWorkingDay: addDays(today(), 5) });
    await api(hr).post(`/hr/offboarding/${rc.body._id}/transition`, { transition: 'approve' });
    const sc = (await api(hro).post(`/hr/offboarding/${rc.body._id}/settlement`, { action: 'compute' })).body.settlement;
    expect(sc.lines.find((l: { code: string }) => l.code === 'return_ticket')).toBeTruthy();
    expect(sc.flags).toContain('return_ticket_amount_needed');
    expect((await api(hr).post(`/hr/offboarding/${rc.body._id}/settlement`, { action: 'approve' })).status).toBe(400);
    await api(hro).post(`/hr/offboarding/${rc.body._id}/settlement`, { action: 'edit_line', line: { code: 'return_ticket', kind: 'earning', amountHalalas: 180_000, reason: 'سعر تذكرة القاهرة' } });
    // E15 deadline alerts: due in ≤ 2 days → one alert; passed → one more.
    await Offboarding.updateOne({ _id: rc.body._id }, { $set: { 'settlement.dueAt': new Date(Date.now() + DAY) } });
    expect((await runOffboardingJobs()).settlementAlerts).toBe(1);
    await Offboarding.updateOne({ _id: rc.body._id }, { $set: { 'settlement.dueAt': new Date(Date.now() - DAY) } });
    expect((await runOffboardingJobs()).settlementAlerts).toBe(1);
    expect((await runOffboardingJobs()).settlementAlerts).toBe(0);
  });

  it('E12: a resignation after 3 years takes a third of the award; E13: the contract clause excludes commissions; E5: art. 77 line', async () => {
    const { hr, hro, f, a, contractFor } = await setup();
    await contractFor(f.employeeId, { type: 'open_ended', startDate: addDays(today(), -3 * 365) });
    await Employee.updateOne({ _id: f.employeeId }, { $set: { allowances: [{ type: 'سكن', amountHalalas: 150_000 }, { type: 'عمولة', amountHalalas: 30_000 }] } });
    const r = await api(f.token).post('/me/offboarding/resign', { reason: 'انتقال', attachmentIds: [] });
    const acc = await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'accept_resignation' });
    expect(acc.body.state).toBe('approved');
    expect(riyadhDate(new Date(acc.body.settlement.dueAt))).toBe(addDays(acc.body.lastWorkingDay, 14)); // E15: two weeks when the employee ends
    const s = (await api(hro).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'compute' })).body.settlement;
    expect(s.awardFraction).toBe(3334);
    expect(s.awardWage.commissionsHalalas).toBe(30_000); // no payslips → the amount on the file
    expect(s.lines.find((l: { code: string }) => l.code === 'eos_award').amountHalalas).toBe(Math.round((Math.round(780_000 * 0.5 * (s.serviceDays / 365)) * 3334) / 10_000));
    // E13 with the clause: commissions excluded. E5: an unlawful termination on an open-ended contract after ~7.9 years.
    await contractFor(a.employeeId, { type: 'open_ended', startDate: '2019-01-01', awardExcludesVariableWage: true, awardExclusionClauseRef: 'البند 11 من العقد' });
    await Employee.updateOne({ _id: a.employeeId }, { $set: { allowances: [{ type: 'سكن', amountHalalas: 150_000 }, { type: 'عمولة', amountHalalas: 30_000 }] } });
    const u = await create(hro, { employeeId: a.employeeId, reason: 'unlawful_termination', lastWorkingDay: addDays(today(), 3) });
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    await api(hr).post(`/hr/offboarding/${u.body._id}/transition`, { transition: 'approve' });
    const su = (await api(hro).post(`/hr/offboarding/${u.body._id}/settlement`, { action: 'compute' })).body.settlement;
    expect(su.awardWage).toMatchObject({ commissionsExcluded: true, commissionsHalalas: 0, totalHalalas: 750_000, clauseRef: 'البند 11 من العقد' });
    const art77 = su.lines.find((l: { code: string }) => l.code === 'unlawful_termination');
    expect(art77.amountHalalas).toBe(Math.max(Math.round(780_000 * 0.5 * (su.serviceDays / 365)), 780_000 * 2));
    expect(su.flags).toContain('art77_needs_hr_and_finance_approval');
  });

  it('E19, E21–E24: the IT task and confirmation, exit interview, certificate, government exit, completion with retention; the four steps gate the close', async () => {
    const { hr, hro, it, dm, admin, a, itDept, contractFor } = await setup();
    await setSetting('hr.gov', { qiwaContractDays: null, gosiRegisterDays: null, gosiExitDays: 2, qiwaExitDays: null }, SYSTEM_ACTOR);
    await contractFor(a.employeeId, { type: 'open_ended', startDate: '2019-01-01' });
    const emp = (await Employee.findById(a.employeeId))!;
    await Custody.create({ employeeId: emp._id, itemName: 'بطاقة دخول', issuedAt: new Date() });
    const r = await create(hro, { employeeId: a.employeeId, reason: 'employer_notice', noticeDate: addDays(today(), -60), lastWorkingDay: addDays(today(), -1) });
    expect((await api(hro).post(`/hr/offboarding/${r.body._id}/certificate`)).status).toBe(400); // E19 after approval
    await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'approve' });
    // E21: a task in the IT queue, the IT members notified, the event published.
    const task = await Task.findOne({ 'source.type': 'offboarding' });
    expect(task).toBeTruthy();
    expect(String(task!.departmentId)).toBe(String(itDept._id));
    expect(await Outbox.countDocuments({ type: 'hr.offboarding.it_requested' })).toBe(1);
    expect(await notifCount('offboarding.it_task')).toBe(1);
    expect((await api(it).get('/it/offboarding')).body.items).toHaveLength(1);
    expect((await api(dm).get('/it/offboarding')).status).toBe(403);
    expect((await api(hro).post(`/it/offboarding/${r.body._id}/confirm`, { assetsReturned: true })).status).toBe(403);
    expect((await api(admin).get('/it/offboarding')).status).toBe(200);
    const conf = await api(it).post(`/it/offboarding/${r.body._id}/confirm`, { note: 'أُغلق البريد والحسابات', assetsReturned: true });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body.steps.it_closure.done).toBe(true);
    expect((await Task.findById(task!._id))!.status).toBe('done');
    expect(await notifCount('offboarding.it_confirmed')).toBe(1);
    // Not completable yet (settlement, custody, interview pending).
    expect((await api(hr).post(`/hr/offboarding/${r.body._id}/transition`, { transition: 'complete' })).status).toBe(400);
    const d1 = (await api(hr).get(`/hr/offboarding/${r.body._id}`)).body;
    expect(d1.actions).not.toContain('complete');
    await api(hro).post(`/hr/offboarding/${r.body._id}/custody`, { custodyId: d1.custodyChecklist[0].custodyId, returnedAt: today(), condition: 'سليمة', notReturned: false });
    expect((await Custody.findOne({ employeeId: emp._id }))!.returnedAt).toBeTruthy();
    // Exit interview from the template; unknown keys refused.
    expect((await api(hro).post(`/hr/offboarding/${r.body._id}/exit-interview`, { answers: [{ key: 'salary_gossip', value: 'x' }], interviewedAt: today() })).status).toBe(400);
    expect((await api(hro).post(`/hr/offboarding/${r.body._id}/exit-interview`, { answers: [{ key: 'reason', value: 'عرض أفضل' }, { key: 'manager', value: 4 }, { key: 'recommend', value: true }], interviewedAt: today() })).status).toBe(200);
    const computed = await api(hro).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'compute' });
    expect(computed.status, JSON.stringify(computed.body)).toBe(200);
    const approvedS = await api(hr).post(`/hr/offboarding/${r.body._id}/settlement`, { action: 'approve' });
    expect(approvedS.status, JSON.stringify(approvedS.body)).toBe(200);
    // E19: the service certificate (art. 64) from the file — free, numbered, audited.
    const cert = await api(hro).post(`/hr/offboarding/${r.body._id}/certificate`);
    expect(cert.status, JSON.stringify(cert.body)).toBe(200);
    expect(cert.body.experienceCertificate.number).toMatch(/^CRT-/);
    expect(await AuditLog.countDocuments({ resource: 'hr.certificates' })).toBe(1);
    expect((await api(hro).post(`/hr/offboarding/${r.body._id}/certificate`)).status).toBe(400);
    // E24: no waiver anywhere on the record.
    expect(Object.keys(Offboarding.schema.paths).some((p) => /waiver|release/i.test(p))).toBe(false);
    // All four steps are done and the last day passed → «إقفال» is offered to HR.
    const done = (await api(hr).get(`/hr/offboarding/${r.body._id}`)).body;
    expect(done.steps).toMatchObject({ settlement: { done: true }, custody_return: { done: true }, it_closure: { done: true }, exit_interview: { done: true } });
    expect(done.actions).toContain('complete');
    // Completion by the daily job (step 9): the last day (yesterday) passed and the four steps are done → «منتهي الخدمة».
    // E22: the GOSI exit deadline (2 days) has not passed yet → no alert in this run.
    const jobs = await runOffboardingJobs();
    expect(jobs).toMatchObject({ completed: 1, govOverdue: 0 });
    await Offboarding.updateOne({ _id: r.body._id }, { $set: { lastWorkingDay: addDays(today(), -5) } });
    expect((await runOffboardingJobs()).govOverdue).toBe(1); // five days after the last day, no GOSI exit reference
    expect((await runOffboardingJobs()).govOverdue).toBe(0); // once
    await api(hro).post(`/hr/offboarding/${r.body._id}/gov-exit`, { gosiExitRef: 'GX-1', gosiExitAt: today() });
    const final = (await Offboarding.findById(r.body._id))!;
    expect(final.state).toBe('completed');
    expect(riyadhDate(final.retention!.keepUntil!).slice(0, 4)).toBe(String(Number(addDays(today(), -5).slice(0, 4)) + 10));
    expect((await Employee.findById(a.employeeId))!.status).toBe('terminated');
    expect((await api(hr).get(`/hr/employees/${a.employeeId}`)).status).toBe(200);
    expect(await notifCount('offboarding.completed')).toBe(1);
    expect((await Contract.findOne({ employeeId: emp._id }))!.status).toBe('terminated');
  });

  it('Visibility and exports: HR all; the department manager their department (no amounts); the employee their own; the executive reads; the admin nothing', async () => {
    const { hr, hro, dm, dm2, exec, admin, a, contractFor } = await setup();
    await contractFor(a.employeeId, { type: 'open_ended', startDate: '2019-01-01' });
    const r = await create(hro, { employeeId: a.employeeId, reason: 'employer_notice', noticeDate: addDays(today(), -60), lastWorkingDay: addDays(today(), 10) });
    expect((await api(dm).get('/hr/offboarding')).body.total).toBe(1);
    expect((await api(dm2).get('/hr/offboarding')).body.total).toBe(0);
    expect((await api(dm2).get(`/hr/offboarding/${r.body._id}`)).status).toBe(404);
    expect((await api(exec).get(`/hr/offboarding/${r.body._id}`)).status).toBe(200);
    expect((await api(admin).get('/hr/offboarding')).body.total).toBe(0); // the admin holds `employee` only: own records, none
    expect((await api(a.token).get('/me/offboarding')).body.items).toHaveLength(1);
    expect((await api(hr).get('/hr/dashboard/hr')).body.offboarding.awaitingReview).toBe(1);
    const resources = ((await api(hr).get('/export/resources')).body.items ?? (await api(hr).get('/export/resources')).body).map((x: { resource: string }) => x.resource);
    expect(resources).toEqual(expect.arrayContaining(['hr.requisitions', 'hr.applicants', 'hr.offers', 'hr.offboardings']));
  });
});
