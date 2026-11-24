import type { ClientSession } from 'mongoose';
import {
  LEAVE_TYPE_AR,
  PAYSLIP_LINE_AR,
  type DisciplinePolicy,
  type GosiGroup,
  type GosiRateRow,
  type LeaveType,
  type OvertimePolicy,
  type PayrollPolicy,
} from '@eayni/shared';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors';
import { SYSTEM_ACTOR, type Actor } from '../../core/http/context';
import { recordAudit } from '../../core/audit/service';
import { nextNumber } from '../../core/numbering/service';
import { notify } from '../../core/notifications/service';
import { publish } from '../../core/outbox/service';
import { getSetting, getSettingMeta } from '../../core/settings/service';
import { applyTransition, availableTransitions, getWorkflow, initWorkflow } from '../../core/workflow/engine';
import { riyadhDate } from '../../core/dates/businessDays';
import { User, type UserDoc } from '../../core/auth/model';
import { Department } from '../../core/org/model';
import { withTransaction } from '../../db';
import { Employee, type EmployeeDoc } from './model';
import { HrRequest } from './requests.model';
import { AttendanceDay } from './attendance.model';
import { addDays, ensureDaysComputed, summarizeDays } from './attendance.service';
import { leavePolicies } from './leave.service';
import { hrUserIds, ON_DUTY_STATUSES } from './service';
import { AdvanceSchedule, PayrollAdjustment, PayrollRun, Payslip, type PayrollRunDoc, type PayslipDoc } from './payroll.model';

const HR_ROLES = ['hr_officer', 'hr_manager'];
const FINANCE_ROLES = ['finance_staff', 'finance_manager'];
const round = (n: number) => Math.round(n);
const pad = (n: number) => String(n).padStart(2, '0');

// ---------- periods ----------
export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}
export function nextPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}
export const currentPeriod = (now = new Date()) => riyadhDate(now).slice(0, 7);
/** Attendance window of a period: the day after last month's cut-off → this month's cut-off (Q8: 25th). */
export function attendanceWindow(period: string, cutoffDay: number): { from: string; to: string } {
  return { from: addDays(`${previousPeriod(period)}-${pad(cutoffDay)}`, 1), to: `${period}-${pad(cutoffDay)}` };
}
const lastDayOf = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return `${period}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};

// ---------- GOSI ----------
export function gosiGroupOf(employee: Pick<EmployeeDoc, 'nationality' | 'gosiJoinDate' | 'hireDate'>, policy: PayrollPolicy): { group: GosiGroup; flag?: string } {
  const saudi = policy.saudiNationalityValues.map((v) => v.trim()).includes((employee.nationality ?? '').trim());
  if (!saudi) return { group: 'non_saudi' };
  const joined = employee.gosiJoinDate ?? null;
  if (!joined) {
    // No GOSI join date on the file: the hire date stands in, and the reviewer sees the flag.
    return { group: riyadhDate(employee.hireDate) < '2024-07-03' ? 'saudi_before_2024_07_03' : 'saudi_from_2024_07_03', flag: 'gosi_join_date_missing' };
  }
  return { group: riyadhDate(joined) < '2024-07-03' ? 'saudi_before_2024_07_03' : 'saudi_from_2024_07_03' };
}
export function gosiRateFor(group: GosiGroup, periodEndDay: string, rates: GosiRateRow[]): GosiRateRow | null {
  const rows = rates.filter((r) => r.group === group && r.effectiveFrom <= periodEndDay).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return rows[0] ?? null;
}

/**
 * GOSI contribution wage (owner decisions 2026-11-24): basic + the housing-type allowances + the monthly commissions
 * (when `gosiIncludeCommissions`), then bounded to [gosiWageMinHalalas, gosiWageMaxHalalas] (1 500 – 45 000 SAR).
 */
export function gosiWageOf(basic: number, allowances: { type: string; amountHalalas: number }[], policy: PayrollPolicy): { wage: number; bounded: 'min' | 'max' | null } {
  let wage = basic + allowances.filter((a) => policy.gosiWageAllowanceTypes.includes(a.type)).reduce((s, a) => s + a.amountHalalas, 0);
  if (policy.gosiIncludeCommissions) wage += allowances.filter((a) => policy.gosiCommissionAllowanceTypes.includes(a.type)).reduce((s, a) => s + a.amountHalalas, 0);
  if (policy.gosiWageMaxHalalas !== null && wage > policy.gosiWageMaxHalalas) return { wage: policy.gosiWageMaxHalalas, bounded: 'max' };
  if (policy.gosiWageMinHalalas !== null && wage > 0 && wage < policy.gosiWageMinHalalas) return { wage: policy.gosiWageMinHalalas, bounded: 'min' };
  return { wage, bounded: null };
}

/**
 * The overtime hour (art. 107, owner decision 2026-11-24): the hour of the actual wage (basic + allowances) ÷ 30 ÷ daily
 * hours, plus the premium (rateBp − 100 %, i.e. 50 %) of the hour of the *basic* wage — never actual × 1.5.
 * Example: basic 4 000 + allowances 2 000, 8 h → 25 + 8.33 = 33.33 SAR.
 */
export function overtimeHourHalalas(basic: number, total: number, dailyHours: number, rateBp: number): number {
  const actualHour = total / 30 / dailyHours;
  const basicHour = basic / 30 / dailyHours;
  return actualHour + basicHour * ((rateBp - 10_000) / 10_000);
}

// ---------- computation ----------
interface Ctx {
  policy: PayrollPolicy;
  gosiRates: GosiRateRow[];
  overtime: OvertimePolicy;
  discipline: DisciplinePolicy;
  leave: Awaited<ReturnType<typeof leavePolicies>>['policies'];
  provisional: boolean;
  window: { from: string; to: string };
  period: string;
}
async function computeCtx(period: string): Promise<Ctx> {
  const [policyMeta, gosiRates, overtime, discipline, leave] = await Promise.all([
    getSettingMeta('hr.payroll.policy'),
    getSetting('hr.payroll.gosiRates'),
    getSetting('hr.overtime'),
    getSetting('hr.discipline'),
    leavePolicies(),
  ]);
  return {
    policy: policyMeta.value,
    gosiRates,
    overtime,
    discipline,
    leave: leave.policies,
    provisional: policyMeta.provisional || leave.provisional,
    window: attendanceWindow(period, policyMeta.value.cutoffDay),
    period,
  };
}

interface Line {
  code: string;
  labelAr: string;
  amountHalalas: number;
  days?: number;
  minutes?: number;
  rateBp?: number;
  sourceType?: string;
  sourceId?: string;
  note?: string;
}

/** One employee's payslip for a run [HR §3.6.1–3.6.5]: salary master + the attendance of the window + approvals. */
export async function computePayslip(employee: EmployeeDoc, run: PayrollRunDoc, ctx: Ctx) {
  const flags: string[] = [];
  const basic = employee.basicSalaryHalalas ?? 0;
  if (!employee.basicSalaryHalalas) flags.push('no_salary');
  const allowances = (employee.allowances ?? []).map((a) => ({ type: a.type ?? 'أخرى', amountHalalas: a.amountHalalas ?? 0 }));
  const total = basic + allowances.reduce((s, a) => s + a.amountHalalas, 0);
  const earnings: Line[] = [{ code: 'basic', labelAr: PAYSLIP_LINE_AR.basic, amountHalalas: basic }];
  for (const a of allowances) earnings.push({ code: `allowance:${a.type}`, labelAr: `${PAYSLIP_LINE_AR.allowance} ${a.type}`, amountHalalas: a.amountHalalas });
  const deductions: Line[] = [];

  // Attendance of the window [HR §3.6.4]: absence (never a missing check-out — DECISIONS §21), lateness, overtime, unpaid leave.
  await ensureDaysComputed([employee._id], ctx.window.from, ctx.window.to);
  const days = await AttendanceDay.find({ employeeId: employee._id, day: { $gte: ctx.window.from, $lte: ctx.window.to } }).lean();
  const s = summarizeDays(days as never);
  const workingDays = days.filter((d) => d.scheduled).length || 22;
  const dayBase = ctx.policy.absenceBase === 'basic' ? basic : total;
  const dayRate = ctx.policy.absenceDayFormula === 'monthly_over_30' ? dayBase / 30 : dayBase / workingDays;
  const absentDays = days.filter((d) => d.status === 'absent').length;
  if (absentDays) deductions.push({ code: 'absence', labelAr: PAYSLIP_LINE_AR.absence, amountHalalas: round(absentDays * dayRate), days: absentDays });
  // Unpaid or partly paid leave per the leave policy (paidPercent).
  let unpaidLeaveDays = 0;
  for (const d of days.filter((x) => x.status === 'on_leave')) {
    const p = ctx.leave[(d.leaveType ?? 'other') as LeaveType];
    const pct = p ? p.paidPercent : 100;
    if (pct < 100) unpaidLeaveDays += (100 - pct) / 100;
  }
  if (unpaidLeaveDays > 0)
    deductions.push({ code: 'unpaid_leave', labelAr: PAYSLIP_LINE_AR.unpaid_leave, amountHalalas: round(unpaidLeaveDays * dayRate), days: Math.round(unpaidLeaveDays * 100) / 100 });
  if (ctx.policy.latenessDeduction === 'per_minute' && s.lateMinutes > 0)
    deductions.push({ code: 'lateness', labelAr: PAYSLIP_LINE_AR.lateness, amountHalalas: round((s.lateMinutes / 60) * (total / 30 / ctx.policy.dailyHours)), minutes: s.lateMinutes });
  // Overtime [HR §3.6.5, art. 107]: approved minutes actually worked × (actual hour + 50 % of the basic hour) — unless compensated with leave.
  const otRequests = await HrRequest.find({
    employeeId: employee._id,
    type: 'overtime',
    deletedAt: null,
    $or: [{ state: 'approved' }, { state: 'closed', 'decision.outcome': 'approved' }],
    'details.day': { $gte: ctx.window.from, $lte: ctx.window.to },
  })
    .select('details')
    .lean();
  const compByDay = new Map(otRequests.map((r) => [(r.details as { day: string }).day, (r.details as { compensation?: string }).compensation ?? ctx.overtime.compensation]));
  let paidOtMinutes = 0;
  for (const d of days) {
    if (!d.overtimeApprovedMinutes) continue;
    const comp = compByDay.get(d.day) ?? ctx.overtime.compensation;
    if (comp === 'pay' || comp === 'employee_choice') paidOtMinutes += d.overtimeApprovedMinutes;
  }
  const otHour = overtimeHourHalalas(basic, total, ctx.policy.dailyHours, ctx.overtime.rateBp);
  const otHalalas = round((paidOtMinutes / 60) * otHour);
  if (paidOtMinutes) earnings.push({ code: 'overtime', labelAr: PAYSLIP_LINE_AR.overtime, amountHalalas: otHalalas, minutes: paidOtMinutes, rateBp: ctx.overtime.rateBp });
  // Advance instalment due this period [HR §3.5.6, Q8].
  const schedules = await AdvanceSchedule.find({ employeeId: employee._id, 'instalments.period': ctx.period });
  for (const sch of schedules) {
    const inst = sch.instalments.find((i) => i.period === ctx.period && (!i.runId || String(i.runId) === String(run._id)));
    if (inst) deductions.push({ code: 'advance_instalment', labelAr: `${PAYSLIP_LINE_AR.advance_instalment} ${sch.requestNumber ?? ''}`.trim(), amountHalalas: inst.amountHalalas, sourceType: 'hr_request', sourceId: String(sch.requestId) });
  }
  // Adjustments not consumed yet (or consumed by this very run on a recompute).
  const adjustments = await PayrollAdjustment.find({ employeeId: employee._id, $or: [{ consumedByRunId: null }, { consumedByRunId: run._id }] });
  for (const a of adjustments) {
    const line: Line = { code: a.kind === 'earning' ? 'adjustment' : a.sourceType === 'disciplinary' ? 'fine' : 'adjustment', labelAr: a.sourceType === 'disciplinary' ? `${PAYSLIP_LINE_AR.fine}: ${a.reason}` : `${PAYSLIP_LINE_AR.adjustment}: ${a.reason}`, amountHalalas: a.amountHalalas, sourceType: 'payroll_adjustment', sourceId: String(a._id) };
    (a.kind === 'earning' ? earnings : deductions).push(line);
  }
  // GOSI [HR §3.6.3, DECISIONS §21 Q8].
  const { group, flag } = gosiGroupOf(employee, ctx.policy);
  if (flag) flags.push(flag);
  const rate = gosiRateFor(group, lastDayOf(ctx.period), ctx.gosiRates);
  const { wage: gosiWage, bounded } = gosiWageOf(basic, allowances, ctx.policy);
  if (bounded) flags.push('gosi_wage_bounded');
  const gosiEmployee = rate ? round((gosiWage * rate.employeeBp) / 10_000) : 0;
  const gosiEmployer = rate ? round((gosiWage * rate.employerBp) / 10_000) : 0;
  if (!rate) flags.push('gosi_rate_missing');
  if (gosiEmployee) deductions.push({ code: 'gosi_employee', labelAr: PAYSLIP_LINE_AR.gosi_employee, amountHalalas: gosiEmployee, rateBp: rate!.employeeBp });
  // Fines of the month (art. 70, owner decision 2026-11-24): ≤ maxFineDaysPerMonth days of wage; the excess rolls into the next run as a fine.
  const fineLines = deductions.filter((d) => d.code === 'fine');
  const fineCap = round((ctx.discipline.maxFineDaysPerMonth * total) / 30);
  let fineDeferred = 0;
  let fineSum = fineLines.reduce((x, d) => x + d.amountHalalas, 0);
  if (fineLines.length && fineSum > fineCap) {
    fineDeferred = fineSum - fineCap;
    flags.push('fine_capped');
    for (let i = fineLines.length - 1; i >= 0 && fineSum > fineCap; i--) {
      const cut = Math.min(fineLines[i].amountHalalas, fineSum - fineCap);
      fineLines[i].amountHalalas -= cut;
      fineLines[i].note = `${fineLines[i].note ?? ''} خُصم جزئياً؛ ${cut} هللة مرحّلة للمسير التالي (حد غرامات الشهر ${ctx.discipline.maxFineDaysPerMonth} أيام — المادة 70)`.trim();
      fineSum -= cut;
    }
  }
  // Deduction cap (art. 92): everything but GOSI ≤ cap; the excess rolls into the next run as an adjustment (at freeze).
  const capped = deductions.filter((d) => d.code !== 'gosi_employee');
  const cap = round((total * ctx.policy.deductionCapBp) / 10_000);
  let deferred = 0;
  let sum = capped.reduce((x, d) => x + d.amountHalalas, 0);
  if (sum > cap) {
    deferred = sum - cap;
    flags.push('deduction_capped');
    // Trim from the last lines backwards (advance instalments and adjustments first, absence last).
    for (let i = capped.length - 1; i >= 0 && sum > cap; i--) {
      const cut = Math.min(capped[i].amountHalalas, sum - cap);
      capped[i].amountHalalas -= cut;
      capped[i].note = `${capped[i].note ?? ''} خُصم جزئياً؛ المتبقي ${cut} هللة مرحّل للمسير التالي (حد الاستقطاع ${ctx.policy.deductionCapBp / 100}%)`.trim();
      sum -= cut;
    }
  }
  if (ctx.provisional) flags.push('provisional_policy');
  const gross = earnings.reduce((x, e) => x + e.amountHalalas, 0);
  const ded = deductions.reduce((x, d) => x + d.amountHalalas, 0);
  return {
    runId: run._id,
    period: ctx.period,
    employeeId: employee._id,
    employeeNumber: employee.employeeNumber,
    fullNameAr: employee.fullNameAr,
    departmentId: employee.departmentId,
    branchId: employee.branchId,
    nationality: employee.nationality,
    gosiGroup: group,
    basicHalalas: basic,
    earnings,
    deductions,
    grossHalalas: gross,
    deductionsHalalas: ded,
    netHalalas: gross - ded,
    gosiWageHalalas: gosiWage,
    gosiEmployeeHalalas: gosiEmployee,
    gosiEmployerHalalas: gosiEmployer,
    attendance: {
      scheduledDays: s.scheduledDays,
      presentDays: s.presentDays,
      absentDays,
      lateMinutes: s.lateMinutes,
      overtimeApprovedMinutes: s.overtimeApprovedMinutes,
      leaveDays: s.leaveDays,
      unpaidLeaveDays: Math.round(unpaidLeaveDays * 100) / 100,
      missingPunchDays: s.missingPunchDays,
    },
    bankName: employee.bank?.bankName,
    bankLast4: employee.bank?.ibanLast4,
    flags,
    deferredHalalas: deferred,
    fineDeferredHalalas: fineDeferred,
    adjustmentIds: adjustments.map((a) => a._id),
    scheduleIds: schedules.map((x) => x._id),
  };
}

/** Employees inside a run (Q18: one run for everyone; contractors excluded; leavers whose last day is before the window too). */
async function eligibleEmployees(ctx: Ctx) {
  const windowStart = new Date(`${ctx.window.from}T00:00:00+03:00`);
  return Employee.find({
    deletedAt: null,
    employmentType: { $nin: ctx.policy.excludeEmploymentTypes },
    hireDate: { $lte: new Date(`${ctx.window.to}T23:59:59+03:00`) },
    $or: [{ status: { $in: [...ON_DUTY_STATUSES, 'suspended'] } }, { status: { $in: ['resigned', 'terminated'] }, endDate: { $gte: windowStart } }],
  }).sort({ employeeNumber: 1 });
}

// ---------- runs ----------
export async function createRun(period: string, user: UserDoc, actor: Actor, notes?: string): Promise<PayrollRunDoc> {
  if (await PayrollRun.exists({ period, state: { $ne: 'cancelled' }, deletedAt: null })) throw conflict(`يوجد مسير رواتب للفترة ${period}`);
  const ctx = await computeCtx(period);
  const def = await getWorkflow('hr_payroll_run');
  const wf = await initWorkflow(def);
  const run = await PayrollRun.create({
    number: await nextNumber('payrollRun'),
    period,
    cutoff: { attendanceFrom: ctx.window.from, attendanceTo: ctx.window.to },
    ...wf,
    preparedBy: user._id,
    notes,
    policySnapshot: { policy: ctx.policy, overtime: ctx.overtime, gosiRates: ctx.gosiRates, provisional: ctx.provisional },
  });
  await recordAudit(actor, { action: 'create', resource: 'hr.payroll', resourceId: String(run._id), after: { number: run.number, period } });
  await prepareRun(run, actor);
  return (await PayrollRun.findById(run._id))!;
}

/** Compute (or recompute) every payslip of a draft / returned run [HR §3.6.2]. */
export async function prepareRun(run: PayrollRunDoc, actor: Actor): Promise<PayrollRunDoc> {
  if (!['draft', 'returned'].includes(run.state)) throw badRequest('لا يمكن إعادة احتساب مسير بعد رفعه للمراجعة');
  if (run.frozenAt) throw badRequest('المسير مجمّد بعد اعتماده');
  const ctx = await computeCtx(run.period);
  const employees = await eligibleEmployees(ctx);
  // Release what a previous computation of this run took, then recompute from scratch.
  await PayrollAdjustment.updateMany({ consumedByRunId: run._id }, { $set: { consumedByRunId: null, consumedAt: null } });
  await AdvanceSchedule.updateMany({ 'instalments.runId': run._id }, { $set: { 'instalments.$[i].runId': null } }, { arrayFilters: [{ 'i.runId': run._id }] });
  await Payslip.deleteMany({ runId: run._id });
  const totals = { employeeCount: 0, grossHalalas: 0, deductionsHalalas: 0, netHalalas: 0, gosiEmployeeHalalas: 0, gosiEmployerHalalas: 0, overtimeHalalas: 0 };
  const runFlags = new Set<string>();
  for (const e of employees) {
    const p = await computePayslip(e, run, ctx);
    const { adjustmentIds, scheduleIds, deferredHalalas, fineDeferredHalalas, ...doc } = p;
    await Payslip.create({ ...doc, flags: [...doc.flags, ...(deferredHalalas ? [`deferred:${deferredHalalas}`] : []), ...(fineDeferredHalalas ? [`fine_deferred:${fineDeferredHalalas}`] : [])] });
    if (adjustmentIds.length) await PayrollAdjustment.updateMany({ _id: { $in: adjustmentIds } }, { $set: { consumedByRunId: run._id, consumedAt: new Date() } });
    for (const sid of scheduleIds)
      await AdvanceSchedule.updateOne({ _id: sid }, { $set: { 'instalments.$[i].runId': run._id } }, { arrayFilters: [{ 'i.period': run.period, 'i.runId': null }] });
    totals.employeeCount++;
    totals.grossHalalas += p.grossHalalas;
    totals.deductionsHalalas += p.deductionsHalalas;
    totals.netHalalas += p.netHalalas;
    totals.gosiEmployeeHalalas += p.gosiEmployeeHalalas;
    totals.gosiEmployerHalalas += p.gosiEmployerHalalas;
    totals.overtimeHalalas += p.earnings.filter((l) => l.code === 'overtime').reduce((x, l) => x + l.amountHalalas, 0);
    for (const f of p.flags) runFlags.add(f);
  }
  run.totals = totals as never;
  run.flags = [...runFlags];
  run.preparedAt = new Date();
  run.cutoff = { attendanceFrom: ctx.window.from, attendanceTo: ctx.window.to } as never;
  await run.save();
  await recordAudit(actor, { action: 'update', resource: 'hr.payroll', resourceId: String(run._id), meta: { prepared: totals.employeeCount, totals }, sensitive: true });
  return run;
}

export function relationsFor(user: UserDoc, run: PayrollRunDoc): string[] {
  const rel = new Set<string>(user.roles.map((r) => r.role));
  if (run.preparedBy && String(run.preparedBy) === String(user._id)) rel.add('preparer');
  return [...rel];
}

export async function availableActions(user: UserDoc, run: PayrollRunDoc): Promise<string[]> {
  const def = await getWorkflow('hr_payroll_run');
  const rel = relationsFor(user, run);
  // `send_to_finance` runs by itself after the HR approval; HR resends by hand only after a Finance return.
  const codes = availableTransitions(def, run.state, rel).map((t) => t.code).filter((c) => c !== 'send_to_finance' || run.state === 'finance_returned');
  // FIN §12 on top of the workflow: the preparer never approves, the Finance approver never records the payment.
  return codes.filter((c) => {
    if (c === 'hr_approve' && String(run.preparedBy) === String(user._id)) return false;
    if (c === 'record_payment' && run.finance?.by && String(run.finance.by) === String(user._id)) return false;
    return true;
  });
}

export interface RunTransitionOpts {
  user: UserDoc;
  actor: Actor;
  reason?: string;
  payment?: { paidAt?: Date; paymentRef?: string; proofAttachmentId?: string };
}

/** One transition of a run with the FIN §12 rules, inside one transaction with the stage log, audit and events. */
export async function transitionRun(run: PayrollRunDoc, code: string, opts: RunTransitionOpts): Promise<PayrollRunDoc> {
  const def = await getWorkflow('hr_payroll_run');
  const uid = String(opts.user._id);
  const relations = relationsFor(opts.user, run);
  if (code === 'hr_approve' && run.preparedBy && String(run.preparedBy) === uid) throw forbidden('لا يمكن لمن أعدّ المسير اعتماده (فصل المهام)');
  if (code === 'record_payment') {
    if (run.finance?.by && String(run.finance.by) === uid) throw forbidden('لا يمكن لمن اعتمد المسير في المالية تسجيل صرفه (فصل المهام)');
    if (run.approvedBy && String(run.approvedBy) === uid) throw forbidden('لا يمكن لمن اعتمد المسير تسجيل صرفه');
    if (!opts.payment?.paidAt) throw badRequest('تاريخ الصرف مطلوب');
  }
  if (code === 'finance_approve' && run.preparedBy && String(run.preparedBy) === uid) throw forbidden('لا يمكن لمن أعدّ المسير اعتماده مالياً');
  const now = new Date();
  const fromState = run.state;
  const policy = (run.policySnapshot as { policy?: PayrollPolicy } | undefined)?.policy ?? (await getSetting('hr.payroll.policy'));
  let visibleNow = false;
  const result = await withTransaction(async (session) => {
    const r = await applyTransition({
      def,
      record: run.toObject() as never,
      recordType: 'hr_payroll_run',
      transition: code,
      actor: opts.actor,
      actorRelations: relations,
      reason: opts.reason,
      now,
      session,
      persist: async (fields) => {
        const set: Record<string, unknown> = { ...fields };
        if (code === 'submit_for_review') set.submittedBy = opts.user._id;
        if (code === 'return') set.reviewedBy = opts.user._id;
        if (code === 'hr_approve') Object.assign(set, { approvedBy: opts.user._id, approvedAt: now, frozenAt: now, reviewedBy: opts.user._id });
        if (code === 'finance_approve') Object.assign(set, { 'finance.decision': 'approved', 'finance.by': opts.user._id, 'finance.at': now, 'finance.note': opts.reason });
        if (code === 'finance_return') Object.assign(set, { 'finance.decision': 'returned', 'finance.by': opts.user._id, 'finance.at': now, 'finance.note': opts.reason });
        if (code === 'record_payment')
          Object.assign(set, { 'finance.paidAt': opts.payment!.paidAt, 'finance.paidBy': opts.user._id, 'finance.paymentRef': opts.payment!.paymentRef, 'finance.proofAttachmentId': opts.payment!.proofAttachmentId });
        if ((code === 'record_payment' && policy.payslipVisibleAt === 'paid') || (code === 'finance_approve' && policy.payslipVisibleAt === 'finance_approved')) {
          set.payslipsVisibleAt = now;
          visibleNow = true;
        }
        const u = await PayrollRun.updateOne({ _id: run._id, state: fromState }, { $set: set }, { session });
        return u.modifiedCount === 1;
      },
    });
    // Side effects inside the transaction.
    const employeeIds = (await Payslip.find({ runId: run._id }).select('employeeId').session(session ?? null).lean()).map((p) => p.employeeId);
    if (code === 'submit_for_review') {
      // «ربط بيانات الحضور … بالمسير» [HR §3.6.4]: the window's days are locked for the run (HR_PLAN §4.5).
      await AttendanceDay.updateMany(
        { employeeId: { $in: employeeIds }, day: { $gte: run.cutoff!.attendanceFrom!, $lte: run.cutoff!.attendanceTo! }, lockedByPayrollRunId: null },
        { $set: { lockedByPayrollRunId: run._id } },
        { session },
      );
    }
    if (code === 'cancel') {
      await AttendanceDay.updateMany({ lockedByPayrollRunId: run._id }, { $set: { lockedByPayrollRunId: null } }, { session });
      await PayrollAdjustment.updateMany({ consumedByRunId: run._id }, { $set: { consumedByRunId: null, consumedAt: null } }, { session });
      await AdvanceSchedule.updateMany({ 'instalments.runId': run._id }, { $set: { 'instalments.$[i].runId': null, 'instalments.$[i].payslipId': null } }, { arrayFilters: [{ 'i.runId': run._id }], session });
    }
    if (code === 'hr_approve') {
      // Deferred deductions (art. 92 cap) and deferred fines (art. 70 monthly cap) become next-run adjustments, once, at the freeze.
      const slips = await Payslip.find({ runId: run._id, flags: { $in: ['deduction_capped', 'fine_capped'] } }).session(session ?? null);
      for (const p of slips) {
        const deferred = Number(p.flags.find((f) => f.startsWith('deferred:'))?.split(':')[1] ?? 0);
        if (deferred > 0)
          await PayrollAdjustment.create(
            [{ employeeId: p.employeeId, kind: 'deduction', amountHalalas: deferred, reason: `مرحّل من مسير ${run.number} (تجاوز حد الاستقطاع)`, sourceType: 'payroll_cap', sourceId: String(p._id), sourceRunId: run._id, createdByEmail: 'system' }],
            { session },
          );
        const fineDeferred = Number(p.flags.find((f) => f.startsWith('fine_deferred:'))?.split(':')[1] ?? 0);
        if (fineDeferred > 0)
          // Kept a fine (sourceType disciplinary) so it counts against next month's fine cap too.
          await PayrollAdjustment.create(
            [{ employeeId: p.employeeId, kind: 'deduction', amountHalalas: fineDeferred, reason: `جزاء مرحّل من مسير ${run.number} (حد غرامات الشهر — المادة 70)`, sourceType: 'disciplinary', sourceId: String(p._id), sourceRunId: run._id, createdByEmail: 'system' }],
            { session },
          );
      }
    }
    if (code === 'record_payment') {
      const slips = await Payslip.find({ runId: run._id }).select('_id employeeId').session(session ?? null).lean();
      for (const p of slips)
        await AdvanceSchedule.updateMany({ employeeId: p.employeeId, 'instalments.runId': run._id }, { $set: { 'instalments.$[i].payslipId': p._id } }, { arrayFilters: [{ 'i.runId': run._id }], session });
    }
    if (visibleNow) await Payslip.updateMany({ runId: run._id }, { $set: { visibleToEmployeeAt: now } }, { session });
    await recordAudit(opts.actor, { action: 'transition', resource: 'hr.payroll', resourceId: String(run._id), before: { state: fromState }, after: { state: r.to }, meta: { transition: code, reason: opts.reason }, sensitive: true }, session);
    const eventType = code === 'hr_approve' ? null : code === 'finance_approve' || code === 'finance_return' ? 'hr.payroll.finance_decided' : code === 'record_payment' ? 'hr.payroll.paid' : null;
    if (eventType)
      await publish({ type: eventType, aggregateType: 'hr_payroll_run', aggregateId: String(run._id), payload: { number: run.number, period: run.period, decision: code, totals: run.totals }, actorUserId: opts.actor.userId }, session);
    return { to: r.to, employeeIds };
  });

  let doc = (await PayrollRun.findById(run._id))!;
  // HR approval hands the run to Finance at once on the same record (HR_PLAN §4.5, golden rule 6).
  if (code === 'hr_approve') {
    doc = await withTransaction(async (session) => {
      const r2 = await applyTransition({
        def,
        record: doc.toObject() as never,
        recordType: 'hr_payroll_run',
        transition: 'send_to_finance',
        actor: SYSTEM_ACTOR,
        actorRelations: ['system'],
        now,
        session,
        persist: async (fields) => (await PayrollRun.updateOne({ _id: doc._id, state: 'hr_approved' }, { $set: fields }, { session })).modifiedCount === 1,
      });
      await publish({ type: 'hr.payroll.sent_to_finance', aggregateType: 'hr_payroll_run', aggregateId: String(doc._id), payload: { number: doc.number, period: doc.period, totals: doc.totals, employeeCount: doc.totals?.employeeCount }, actorUserId: opts.actor.userId }, session);
      void r2;
      return (await PayrollRun.findById(doc._id).session(session ?? null))!;
    });
  }
  await notifyRun(doc, code, opts, result.employeeIds, visibleNow);
  return doc;
}

async function notifyRun(run: PayrollRunDoc, code: string, opts: RunTransitionOpts, employeeIds: unknown[], visibleNow: boolean) {
  const label = `مسير الرواتب ${run.number} — ${run.period}`;
  const link = `/hr/payroll/${run._id}`;
  const hrManagers = (await User.find({ 'roles.role': 'hr_manager', status: 'active' }).select('_id').lean()).map((u) => String(u._id));
  const finance = (await User.find({ 'roles.role': { $in: FINANCE_ROLES }, status: 'active' }).select('_id').lean()).map((u) => String(u._id));
  if (code === 'submit_for_review') await notify({ userIds: hrManagers, type: 'payroll.submitted', bodyAr: label, link });
  if (code === 'return' || code === 'finance_return')
    await notify({ userIds: run.preparedBy ? [String(run.preparedBy), ...hrManagers] : hrManagers, type: 'payroll.returned', bodyAr: `${label}: ${opts.reason ?? ''}`, link });
  if (code === 'hr_approve') await notify({ userIds: finance, type: 'payroll.at_finance', bodyAr: `${label} — ${run.totals?.employeeCount ?? 0} موظفاً، صافي ${((run.totals?.netHalalas ?? 0) / 100).toLocaleString('en-US')} ر.س`, link: `/finance/payroll/${run._id}` });
  if (code === 'finance_approve') await notify({ userIds: hrManagers, type: 'payroll.finance_decided', bodyAr: `${label}: اعتمدته المالية`, link });
  if (code === 'record_payment') await notify({ userIds: [...hrManagers, ...(await hrUserIds())], type: 'payroll.paid', bodyAr: `${label}: تم الصرف`, link });
  if (visibleNow) {
    const users = await Employee.find({ _id: { $in: employeeIds }, userId: { $ne: null } }).select('userId').lean();
    await notify({ userIds: users.map((e) => String(e.userId)), type: 'payslip.available', bodyAr: `قسيمة راتب ${run.period}`, link: '/me/payslips' });
  }
}

// ---------- payslips ----------
export function isHrUser(user: UserDoc): boolean {
  return user.roles.some((r) => HR_ROLES.includes(r.role));
}
export function isFinanceUser(user: UserDoc): boolean {
  return user.roles.some((r) => FINANCE_ROLES.includes(r.role));
}

/** Who may read a payslip: HR and Finance (audited), the employee once visible. The system admin never (HR_PLAN §10.8). */
export async function canReadPayslip(user: UserDoc, payslip: PayslipDoc): Promise<'full' | 'own' | null> {
  if (isHrUser(user) || isFinanceUser(user)) return 'full';
  const me = await Employee.findOne({ userId: user._id, deletedAt: null }).select('_id').lean();
  if (me && String(me._id) === String(payslip.employeeId) && payslip.visibleToEmployeeAt) return 'own';
  return null;
}

/** RTL HTML payslip (the PDF renderer, when configured, prints the same HTML — DECISIONS §1.11). */
export async function payslipHtml(p: PayslipDoc, run: PayrollRunDoc): Promise<string> {
  const { htmlDocument, escapeHtml } = await import('../../core/templates/render');
  const orgName = await getSetting('general.organizationNameAr');
  const dept = p.departmentId ? await Department.findById(p.departmentId).select('nameAr').lean() : null;
  const money = (h: number) => `${(h / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ر.س`;
  const rows = (lines: { labelAr: string; amountHalalas: number; days?: number; minutes?: number }[]) =>
    lines.map((l) => `<tr><td>${escapeHtml(l.labelAr)}${l.days ? ` (${l.days} يوم)` : ''}${l.minutes ? ` (${l.minutes} د)` : ''}</td><td dir="ltr">${money(l.amountHalalas)}</td></tr>`).join('');
  const body = `<div style="text-align:center"><h2>${escapeHtml(orgName)}</h2><h3>قسيمة راتب ${escapeHtml(p.period)}</h3><p>${escapeHtml(run.number)}</p></div>
<table><tbody>
<tr><td>الموظف</td><td>${escapeHtml(p.fullNameAr)} · ${escapeHtml(p.employeeNumber)}</td></tr>
<tr><td>القسم</td><td>${escapeHtml(dept?.nameAr ?? '')}</td></tr>
<tr><td>فترة الحضور</td><td dir="ltr">${escapeHtml(run.cutoff?.attendanceFrom ?? '')} → ${escapeHtml(run.cutoff?.attendanceTo ?? '')}</td></tr>
<tr><td>الحضور</td><td>حضور ${p.attendance?.presentDays ?? 0} · غياب ${p.attendance?.absentDays ?? 0} · إجازة ${p.attendance?.leaveDays ?? 0} · تأخير ${p.attendance?.lateMinutes ?? 0} د · إضافي معتمد ${p.attendance?.overtimeApprovedMinutes ?? 0} د</td></tr>
</tbody></table>
<h4>الاستحقاقات</h4><table><tbody>${rows(p.earnings as never)}<tr><th>الإجمالي</th><th dir="ltr">${money(p.grossHalalas)}</th></tr></tbody></table>
<h4>الاستقطاعات</h4><table><tbody>${rows(p.deductions as never)}<tr><th>الإجمالي</th><th dir="ltr">${money(p.deductionsHalalas)}</th></tr></tbody></table>
<h3 style="text-align:end">صافي الراتب: <span dir="ltr">${money(p.netHalalas)}</span></h3>
<p style="color:#555">حصة صاحب العمل في التأمينات الاجتماعية: <span dir="ltr">${money(p.gosiEmployerHalalas)}</span>${p.bankLast4 ? ` · الحساب البنكي: ${escapeHtml(p.bankName ?? '')} ****${escapeHtml(p.bankLast4)}` : ''}</p>
${p.flags.includes('provisional_policy') ? '<p style="color:#92400e">احتُسبت القسيمة على سياسات مؤقتة حتى اعتماد الموارد البشرية.</p>' : ''}`;
  return htmlDocument(body, `قسيمة راتب ${p.period} — ${p.fullNameAr}`);
}

// ---------- adjustments and advances ----------
export async function addAdjustment(input: { employeeId: string; kind: 'earning' | 'deduction'; amountHalalas: number; reason: string; sourceRunId?: string }, actor: Actor) {
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null }).select('_id').lean();
  if (!employee) throw notFound('الموظف غير موجود');
  const row = await PayrollAdjustment.create({ ...input, createdBy: actor.userId, createdByEmail: actor.email });
  await recordAudit(actor, { action: 'create', resource: 'hr.payroll', resourceId: String(row._id), after: { adjustment: input }, sensitive: true });
  return row;
}

/**
 * The instalment count an advance must have (owner decision 2026-11-24): the monthly instalment may not exceed
 * `advanceInstalmentCapBp` (10 %) of the monthly wage unless the employee gave written consent on the request; without
 * consent the advance is split so no instalment exceeds the cap (36 at most).
 */
export function advanceInstalmentPlan(amountHalalas: number, requested: number, wageHalalas: number, consent: boolean, capBp: number): { instalments: number; capHalalas: number; flag: 'instalment_consent_given' | 'instalments_rescheduled' | null } {
  const n = Math.max(1, requested);
  const capHalalas = Math.floor((wageHalalas * capBp) / 10_000);
  if (capHalalas <= 0 || Math.ceil(amountHalalas / n) <= capHalalas) return { instalments: n, capHalalas, flag: null };
  if (consent) return { instalments: n, capHalalas, flag: 'instalment_consent_given' };
  return { instalments: Math.min(36, Math.max(n, Math.ceil(amountHalalas / capHalalas))), capHalalas, flag: 'instalments_rescheduled' };
}

/** On an approved advance (Finance's final step): the instalment plan, from the next period, equal amounts (Q8). */
export async function onAdvanceApproved(request: { _id: unknown; number: string; employeeId: unknown; details: Record<string, unknown> }, session: ClientSession | undefined, now = new Date()): Promise<void> {
  if (await AdvanceSchedule.exists({ requestId: request._id }).session(session ?? null)) return;
  const total = Number(request.details.amountHalalas ?? 0);
  const n = Math.max(1, Number(request.details.instalments ?? 1));
  const each = Math.floor(total / n);
  let period = nextPeriod(currentPeriod(now));
  const instalments = [];
  for (let i = 0; i < n; i++) {
    instalments.push({ period, amountHalalas: i === n - 1 ? total - each * (n - 1) : each });
    period = nextPeriod(period);
  }
  await AdvanceSchedule.create([{ requestId: request._id, requestNumber: request.number, employeeId: request.employeeId, totalHalalas: total, instalments }], { session });
}

/** Daily: on the cut-off day remind HR to prepare the period's run [HR §3.6.2]. */
export async function runPayrollCutoffReminder(now = new Date()): Promise<number> {
  const policy = await getSetting('hr.payroll.policy');
  const today = riyadhDate(now);
  if (Number(today.slice(8, 10)) !== policy.cutoffDay) return 0;
  const period = today.slice(0, 7);
  if (await PayrollRun.exists({ period, state: { $ne: 'cancelled' } })) return 0;
  const ids = await hrUserIds();
  await notify({ userIds: ids, type: 'payroll.submitted', titleAr: 'موعد إعداد مسير الرواتب', bodyAr: `حلّ يوم القطع (${policy.cutoffDay}) ولم يُعدّ مسير ${period} بعد`, link: '/hr/payroll' });
  return ids.length;
}

export { LEAVE_TYPE_AR };
