import type { ClientSession } from 'mongoose';
import {
  EOS_ART155_BLOCKED_REASONS,
  EOS_ART82_BLOCKED_REASONS,
  EOS_REASON_AR,
  SETTLEMENT_LINE_AR,
  type CreateOffboardingInput,
  type EosPolicy,
  type EosReason,
  type PregnancyRecordInput,
  type ResignInput,
  type SettlementLineCode,
} from '@eayni/shared';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors';
import { SYSTEM_ACTOR, type Actor } from '../../core/http/context';
import { recordAudit } from '../../core/audit/service';
import { nextNumber } from '../../core/numbering/service';
import { notify } from '../../core/notifications/service';
import { publish } from '../../core/outbox/service';
import { getSetting, getSettingMeta } from '../../core/settings/service';
import { applyTransition, availableTransitions, getWorkflow, initWorkflow } from '../../core/workflow/engine';
import { StageLog } from '../../core/workflow/model';
import { User, type UserDoc } from '../../core/auth/model';
import { Task } from '../../core/tasks/model';
import { Department } from '../../core/org/model';
import { claimAttachments } from '../../core/files/service';
import { addBusinessDays, loadHolidaySet, riyadhDate, riyadhDayEndOf, riyadhDayStartOf } from '../../core/dates/businessDays';
import { withTransaction } from '../../db';
import { visibilityFilter } from './h3b.visibility';
export { visibilityFilter };
import { Contract, Custody, Employee, type EmployeeDoc } from './model';
import { Offboarding, OffboardingEvent, type OffboardingDoc } from './offboarding.model';
import { AttendanceDay } from './attendance.model';
import { AdvanceSchedule, PayrollAdjustment, Payslip } from './payroll.model';
import { HrRequest } from './requests.model';
import { changeStatus, hrUserIds, ON_DUTY_STATUSES } from './service';
import { addDays, ensureDaysComputed, summarizeDays } from './attendance.service';
import { balance } from './leave.service';
import { overtimeHourHalalas } from './payroll.service';
import { issueCertificate } from './certificates';
import {
  ART155_MESSAGE,
  art77CompensationHalalas,
  art80AbsenceCheck,
  art87WithinLimit,
  awardFractionBp,
  awardWageOf,
  daysDiff,
  eosAwardHalalas,
  initiatedByOf,
  isSaudi,
  NOTICE_REASONS,
  noticeCompensationHalalas,
  noticeInsideApprovedLeave,
  noticeRequiredDays,
  noticeShortfallDays,
  pregnancyProtection,
  resignationDeadlines,
  resignationEndDay,
  retirementAgeFor,
  retirementDay,
  settlementDueDay,
  sickLeaveProtection,
} from './legal.service';

/**
 * End of service [HR §3.10] — request → reason and date → approval → (settlement ‖ custody ‖ IT ‖ exit interview) →
 * experience certificate → «منتهي الخدمة» → retention. Every rule of docs/HR_H3B_LEGAL.md §ثانياً is applied here or in
 * `legal.service.ts`, and every blocked action names its article. Owner decisions: DECISIONS §22.
 */
const HR_ROLES = ['hr_officer', 'hr_manager'];
const FINANCE_ROLES = ['finance_staff', 'finance_manager'];
const IT_ROLES = ['it_staff', 'system_admin']; // notification recipients of the thin IT stage
const DAY = 86_400_000;
const round = (n: number) => Math.round(n);
const roleCodes = (u: UserDoc) => u.roles.map((r) => r.role);
const hasRole = (u: UserDoc, roles: readonly string[]) => roleCodes(u).some((r) => roles.includes(r));
const usersWithRole = async (roles: readonly string[]) => (await User.find({ 'roles.role': { $in: roles }, status: 'active' }).select('_id').lean()).map((u) => String(u._id));

export async function eosPolicy(): Promise<{ policy: EosPolicy; provisional: boolean }> {
  const m = await getSettingMeta('hr.eos');
  return { policy: m.value, provisional: m.provisional };
}
async function event(o: { _id: unknown }, type: string, actor: Actor, data: Record<string, unknown> = {}, session?: ClientSession) {
  await OffboardingEvent.create([{ offboardingId: o._id, type, actorUserId: actor.userId, actorEmail: actor.email, ...data }], { session });
}
async function managerUserIdOf(employee: EmployeeDoc): Promise<string | undefined> {
  if (!employee.directManagerId) return undefined;
  const m = await Employee.findById(employee.directManagerId).select('userId').lean();
  return m?.userId ? String(m.userId) : undefined;
}
async function activeContract(employee: EmployeeDoc) {
  return (await Contract.findOne({ employeeId: employee._id, status: { $in: ['active', 'renewing'] } }).sort({ version: -1 })) ?? (await Contract.findOne({ employeeId: employee._id }).sort({ version: -1 }));
}
const monthlyWageOf = (e: EmployeeDoc) => (e.basicSalaryHalalas ?? 0) + (e.allowances ?? []).reduce((s, a) => s + (a.amountHalalas ?? 0), 0);

// ==================================================================================================
// Legal gates shared by HR endings, resignations and the H3a discipline ladder (E6, E8, E26)
// ==================================================================================================
/** E26 (art. 155): throws when a dismissal / dismissal warning targets a pregnant employee or one on maternity leave. */
export async function assertNotPregnancyProtected(employee: EmployeeDoc, day: string): Promise<void> {
  const p = await pregnancyProtection(employee, day);
  if (p.protected) throw forbidden(`${ART155_MESSAGE} — ${p.reasonAr}`, 'art155_protected');
}
export async function legalChecks(employee: EmployeeDoc, reason: EosReason, lastWorkingDay: string, noticeDate?: string): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const party = initiatedByOf(reason);
  if (EOS_ART155_BLOCKED_REASONS.includes(reason)) await assertNotPregnancyProtected(employee, lastWorkingDay);
  // E8 (art. 82): employer-initiated endings only; art. 80 warns.
  const sickBalance = await balance(employee._id, 'sick', Number(lastWorkingDay.slice(0, 4)));
  const sick = await sickLeaveProtection(employee, lastWorkingDay, sickBalance);
  if (sick.protected && EOS_ART82_BLOCKED_REASONS.includes(reason)) throw forbidden(`لا يجوز إنهاء عقد العامل بسبب المرض قبل استنفاد إجازته المرضية — ${sick.reasonAr}`, 'art82_protected');
  if (sick.protected && reason === 'dismissal_art80') warnings.push(`تاريخ الفصل داخل إجازة مرضية: ${sick.reasonAr}`);
  // E4 / O1: a notice dated inside an approved leave — warning only (no article; owner decision).
  if (noticeDate && party !== 'law' && (await getSetting('hr.offboarding.warnNoticeDuringLeave'))) {
    const n = await noticeInsideApprovedLeave(employee._id, noticeDate);
    if (n) warnings.push(`تاريخ الإشعار يقع داخل إجازة معتمدة (${n}) — سياسة داخلية، لا سند نظامي`);
  }
  return { warnings };
}

// ==================================================================================================
// Create: HR-initiated endings (E1–E10, E14) and the employee's resignation (E25)
// ==================================================================================================
async function assertNoOpenEnding(employeeId: unknown) {
  const open = await Offboarding.findOne({ employeeId, deletedAt: null, state: { $in: ['resignation_submitted', 'resignation_postponed', 'requested', 'under_review', 'approved'] } }).select('number state').lean();
  if (open) throw conflict(`يوجد إجراء إنهاء خدمة قائم لهذا الموظف (${open.number})`, { offboardingId: String(open._id), state: open.state });
}
export async function createOffboarding(input: CreateOffboardingInput, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  const { policy } = await eosPolicy();
  if (!hasRole(user, HR_ROLES)) throw forbidden('طلب إنهاء الخدمة من الموارد البشرية؛ الموظف يستقيل عبر «رفع طلب»');
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null });
  if (!employee) throw notFound('الموظف غير موجود');
  if (employee.userId && String(employee.userId) === String(user._id)) throw forbidden('لا يُنهي الموظف خدمة نفسه من هنا — استخدم «رفع طلب» للاستقالة');
  if (input.reason === 'resignation') throw badRequest('الاستقالة يقدّمها الموظف نفسه عبر «رفع طلب» (المادة 79 مكرر)');
  await assertNoOpenEnding(employee._id);
  const contract = await activeContract(employee);
  const today = riyadhDate(new Date());
  const warnings: string[] = [];
  const party = initiatedByOf(input.reason);
  const extra: Record<string, unknown> = {};
  // E6 (art. 80): fixed list + hearing (schema) + the absence or probation case checked against the records.
  if (input.reason === 'dismissal_art80') {
    if (input.art80Case === 'absence') {
      const check = await art80AbsenceCheck(employee, contract?.originalStartDate ?? contract?.startDate ?? employee.hireDate, input.lastWorkingDay);
      if (!check.ok) throw badRequest(check.messageAr, { code: 'art80_absence_not_met', check });
      extra.art80AbsenceCheck = check;
    }
    if (input.art80Case === 'probation' && !(contract?.probationEndDate && riyadhDate(contract.probationEndDate) >= input.lastWorkingDay)) throw badRequest('فترة التجربة انتهت؛ لا يُستند إلى البند 6 من المادة 80', { code: 'probation_over' });
    if (input.hearing && input.hearing.heldAt > input.lastWorkingDay) throw badRequest('جلسة إبداء أسباب المعارضة تسبق الفصل (المادة 80)');
  }
  // E10 (arts. 53–54): only inside the computed probation (with the excluded days of T7).
  if (input.reason === 'probation') {
    if (!contract?.probationEndDate) throw badRequest('لا فترة تجربة في العقد الساري', { code: 'no_probation' });
    if (riyadhDate(contract.probationEndDate) < input.lastWorkingDay) throw badRequest(`انتهت فترة التجربة في ${riyadhDate(contract.probationEndDate)} (بعد إضافة الأيام المستثناة) — لا إنهاء بالتجربة بعدها (المادة 53)`, { code: 'probation_over' });
  }
  // E14 (art. 87): a female employee, within 6 months of the marriage or 3 of the birth.
  if (input.reason === 'marriage_or_birth_art87') {
    if (employee.gender !== 'female') throw badRequest('المادة 87 خاصة بالعاملة');
    const ev = await art87Event(employee, input.eventDate, input.eventAttachmentId);
    if (!ev) throw badRequest('حدّد تاريخ عقد الزواج أو الوضع (من طلب إجازة معتمد أو يدوياً بمرفق)', { code: 'event_date_required' });
    if (!art87WithinLimit(ev.event, ev.eventDate, input.lastWorkingDay)) throw badRequest(`خارج المهلة: الإنهاء خلال ستة أشهر من الزواج أو ثلاثة أشهر من الوضع (المادة 87) — الحدث في ${ev.eventDate}؛ يُسجَّل كاستقالة بمعامل المادة 85`, { code: 'art87_out_of_limit', suggestedReason: 'resignation' });
    extra.art87 = { ...ev, withinLimit: true };
  }
  // E1 (art. 74 → Social Insurance Law): the age comes from the setting; blank → warning, never a hard-coded number.
  if (input.reason === 'retirement') {
    const rules = await getSetting('hr.retirement.rules');
    const age = retirementAgeFor(employee, rules);
    if (age === null) warnings.push('سن التقاعد غير مضبوط في الإعدادات (نظام التأمينات) — يُراجَع يدوياً');
    else if (employee.birthDate && retirementDay(riyadhDate(employee.birthDate), age) > input.lastWorkingDay) warnings.push(`الموظف يبلغ سن التقاعد (${age}) في ${retirementDay(riyadhDate(employee.birthDate), age)} — بعد تاريخ الانتهاء`);
  }
  if (input.reason === 'contract_expiry') {
    if (!contract?.endDate) throw badRequest('العقد الساري غير محدد المدة — لا «انتهاء مدة»', { code: 'no_end_date' });
    if (riyadhDate(contract.endDate) !== input.lastWorkingDay) warnings.push(`تاريخ انتهاء العقد ${riyadhDate(contract.endDate)} يختلف عن آخر يوم عمل`);
  }
  if (['employer_notice', 'employee_notice', 'unlawful_termination'].includes(input.reason) && contract && contract.type !== 'open_ended') warnings.push('الإنهاء بالإشعار (المادة 75) خاص بالعقد غير محدد المدة؛ العقد الساري محدد المدة');
  // E2 / E3 (arts. 75–76): the minimum notice by party and wage period; the shortfall becomes a settlement line.
  let notice: Record<string, unknown> | undefined;
  if (NOTICE_REASONS.includes(input.reason)) {
    const required = noticeRequiredDays(party, (contract?.wagePeriod as 'monthly' | 'non_monthly') ?? 'monthly', policy);
    const { givenDays, shortfallDays } = noticeShortfallDays(input.noticeDate, input.lastWorkingDay, required);
    notice = { requiredDays: required, givenDays, shortfallDays, basisAr: `${party === 'employer' ? 'من صاحب العمل' : 'من العامل'}، الأجر ${contract?.wagePeriod === 'non_monthly' ? 'غير شهري' : 'شهري'}: لا يقل عن ${required} يوماً (المادة 75)` };
    if (!input.noticeDate) warnings.push('لم يُسجَّل تاريخ الإشعار — سيُحسب تعويض مهلة الإشعار كاملاً (المادة 76)');
    else if (shortfallDays > 0) warnings.push(`مهلة الإشعار ${givenDays} يوماً أقل من الحد ${required} يوماً — تعويض ${shortfallDays} يوماً (المادة 76)`);
  }
  const { warnings: legal } = await legalChecks(employee, input.reason, input.lastWorkingDay, input.noticeDate);
  warnings.push(...legal);
  if (input.lastWorkingDay < today && party !== 'law') warnings.push('آخر يوم عمل في الماضي');
  const def = await getWorkflow('hr_offboarding');
  const wf = await initWorkflow(def);
  const o = await Offboarding.create({
    number: await nextNumber('offboarding'),
    employeeId: employee._id,
    departmentId: employee.departmentId,
    contractId: contract?._id,
    reason: input.reason,
    initiatedBy: party,
    art80Case: input.art80Case,
    hearing: input.hearing,
    art81Case: input.art81Case,
    medicalCertificateAttachmentId: input.medicalCertificateAttachmentId,
    writtenAgreementAttachmentId: input.writtenAgreementAttachmentId,
    requestedBy: user._id,
    requestedByRelation: 'hr',
    noticeDate: input.noticeDate,
    lastWorkingDay: input.lastWorkingDay,
    details: input.details,
    attachmentIds: input.attachmentIds,
    notice,
    legalWarnings: warnings,
    ...extra,
    ...wf,
  });
  const attachments = [...input.attachmentIds, ...(input.hearing?.attachmentIds ?? []), input.eventAttachmentId, input.medicalCertificateAttachmentId, input.writtenAgreementAttachmentId].filter(Boolean) as string[];
  if (attachments.length) await claimAttachments(attachments, 'offboarding', String(o._id), user._id);
  await event(o, 'created', actor, { toState: o.state, data: { reason: input.reason, warnings } });
  await recordAudit(actor, { action: 'create', resource: 'hr.offboarding', resourceId: String(o._id), after: { number: o.number, employeeId: String(employee._id), reason: input.reason, lastWorkingDay: input.lastWorkingDay }, sensitive: true });
  return transitionOffboarding(o, 'submit', { user, actor });
}
/** E14: the marriage / birth date from an approved leave (marriage / maternity `eventDate`) or the manual field. */
async function art87Event(employee: EmployeeDoc, manualDate?: string, attachmentId?: string): Promise<{ event: 'marriage' | 'birth'; eventDate: string; source: string; attachmentId?: string } | null> {
  const leave = await HrRequest.findOne({ employeeId: employee._id, type: 'leave', deletedAt: null, 'details.leaveType': { $in: ['marriage', 'maternity'] }, $or: [{ state: 'approved' }, { state: 'closed', 'decision.outcome': 'approved' }] })
    .sort({ 'details.startDate': -1 })
    .select('number details')
    .lean();
  if (leave) {
    const d = leave.details as { leaveType: string; startDate: Date; eventDate?: Date };
    const day = riyadhDate(d.eventDate ?? d.startDate);
    return { event: d.leaveType === 'marriage' ? 'marriage' : 'birth', eventDate: day, source: `إجازة ${d.leaveType === 'marriage' ? 'زواج' : 'وضع'} معتمدة ${leave.number}` };
  }
  if (manualDate) return { event: 'marriage', eventDate: manualDate, source: 'إدخال يدوي', attachmentId };
  return null;
}

/** E25 (arts. 74(3 bis), 79 bis): the employee's resignation — the legal clock starts at submission. */
export async function resign(employee: EmployeeDoc, input: ResignInput, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  const { policy } = await eosPolicy();
  await assertNoOpenEnding(employee._id);
  if (!(ON_DUTY_STATUSES as readonly string[]).includes(employee.status) && employee.status !== 'suspended') throw badRequest('لا يمكن تقديم استقالة في الحالة الوظيفية الحالية');
  const now = new Date();
  const deadlines = resignationDeadlines(now, policy);
  const contract = await activeContract(employee);
  const warnings: string[] = [];
  let reason: EosReason = 'resignation';
  let art87: Record<string, unknown> | undefined;
  if (input.art87Event) {
    if (employee.gender !== 'female') warnings.push('المادة 87 خاصة بالعاملة — تجاهل الطلب');
    else {
      const ev = (await art87Event(employee, input.art87EventDate, input.art87AttachmentId)) ?? (input.art87EventDate ? { event: input.art87Event, eventDate: input.art87EventDate, source: 'إدخال يدوي', attachmentId: input.art87AttachmentId } : null);
      if (!ev) warnings.push('لم يُحدَّد تاريخ الزواج أو الوضع — تُعامل كاستقالة عادية (المادة 85)');
      else {
        const within = art87WithinLimit(input.art87Event, ev.eventDate, riyadhDate(deadlines.deemedAcceptedAt));
        art87 = { ...ev, event: input.art87Event, withinLimit: within };
        if (within) reason = 'marriage_or_birth_art87';
        else warnings.push(`الحدث في ${ev.eventDate} خارج مهلة المادة 87 (6 أشهر زواج / 3 أشهر وضع) — تُعامل كاستقالة بمعامل المادة 85`);
      }
    }
  }
  if (input.requestedLastWorkingDay && input.requestedLastWorkingDay < riyadhDate(now)) throw badRequest('آخر يوم عمل المطلوب في الماضي');
  const def = await getWorkflow('hr_offboarding');
  const holidays = await loadHolidaySet();
  const o = await Offboarding.create({
    number: await nextNumber('offboarding'),
    employeeId: employee._id,
    departmentId: employee.departmentId,
    contractId: contract?._id,
    reason,
    initiatedBy: 'employee',
    requestedBy: user._id,
    requestedByRelation: 'employee',
    noticeDate: riyadhDate(now),
    lastWorkingDay: input.requestedLastWorkingDay && input.requestedLastWorkingDay <= riyadhDate(deadlines.deemedAcceptedAt) ? input.requestedLastWorkingDay : riyadhDate(deadlines.deemedAcceptedAt),
    details: input.reason,
    attachmentIds: input.attachmentIds,
    art87,
    legalWarnings: warnings,
    resignation: { submittedAt: now, reason: input.reason, requestedLastWorkingDay: input.requestedLastWorkingDay, withdrawDeadline: deadlines.withdrawDeadline, deemedAcceptedAt: deadlines.deemedAcceptedAt },
    state: 'resignation_submitted',
    stateEnteredAt: now,
    dueAt: addBusinessDays(now, def.states.resignation_submitted.slaBusinessDays ?? 10, holidays),
    closedAt: null,
  });
  if (input.attachmentIds.length) await claimAttachments(input.attachmentIds, 'offboarding', String(o._id), user._id);
  await StageLog.create({ recordType: 'hr_offboarding', recordId: String(o._id), recordNumber: o.number, toState: 'resignation_submitted', transition: 'resign', actorUserId: actor.userId, actorEmail: actor.email, actorRelations: ['subject'], at: now, departmentId: String(employee.departmentId) });
  await event(o, 'resignation_submitted', actor, { toState: 'resignation_submitted', data: { withdrawDeadline: deadlines.withdrawDeadline, deemedAcceptedAt: deadlines.deemedAcceptedAt } });
  await recordAudit(actor, { action: 'create', resource: 'hr.offboarding', resourceId: String(o._id), after: { number: o.number, reason, employeeId: String(employee._id) } });
  await publish({ type: 'hr.offboarding.resignation_submitted', aggregateType: 'hr_offboarding', aggregateId: String(o._id), payload: { number: o.number, employeeId: String(employee._id) }, actorUserId: actor.userId });
  const manager = await managerUserIdOf(employee);
  const ids = [...(await usersWithRole([policy.approverRole])), ...(manager ? [manager] : [])];
  await notify({ userIds: [...new Set(ids)], type: 'resignation.submitted', bodyAr: `${employee.fullNameAr} — ${o.number}: تُعد مقبولة إن لم يُرد عليها قبل ${riyadhDate(deadlines.deemedAcceptedAt)} (المادة 79 مكرر)`, link: `/hr/offboarding/${o._id}` });
  return o;
}

// ==================================================================================================
// Transitions
// ==================================================================================================
export async function relationsFor(user: UserDoc, o: OffboardingDoc, policy: EosPolicy): Promise<string[]> {
  const employee = await Employee.findById(o.employeeId).select('userId directManagerId').lean();
  if (employee?.userId && String(employee.userId) === String(user._id)) return ['subject', ...(String(o.requestedBy) === String(user._id) ? ['requester'] : [])];
  const rel = new Set<string>(roleCodes(user));
  if (String(o.requestedBy) === String(user._id)) rel.add('requester');
  if (employee?.directManagerId) {
    const m = await Employee.findById(employee.directManagerId).select('userId').lean();
    if (m?.userId && String(m.userId) === String(user._id)) rel.add('direct_manager');
  }
  // The approver (Q9: HR manager) is never the requester of the same record (FIN §12 pattern).
  if (roleCodes(user).includes(policy.approverRole) && String(o.requestedBy) !== String(user._id)) rel.add('approver');
  return [...rel];
}
export async function availableActions(user: UserDoc, o: OffboardingDoc) {
  const def = await getWorkflow('hr_offboarding');
  const { policy } = await eosPolicy();
  const rel = await relationsFor(user, o, policy);
  let codes = availableTransitions(def, o.state, rel).map((t) => t.code);
  if (rel.includes('subject')) codes = codes.filter((c) => c === 'withdraw_resignation');
  if (codes.includes('withdraw_resignation') && o.resignation?.withdrawDeadline && o.resignation.withdrawDeadline < new Date()) codes = codes.filter((c) => c !== 'withdraw_resignation');
  if (o.state === 'approved' && codes.includes('complete') && !(await completable(o))) codes = codes.filter((c) => c !== 'complete');
  return codes;
}
async function completable(o: OffboardingDoc): Promise<boolean> {
  const s = o.steps;
  return !!(s?.settlement?.done && s?.custody_return?.done && s?.it_closure?.done && s?.exit_interview?.done) && o.lastWorkingDay < riyadhDate(new Date());
}
export interface TransitionOpts {
  user: UserDoc;
  actor: Actor;
  reason?: string;
  postponedUntil?: string;
  lastWorkingDay?: string;
}
export async function transitionOffboarding(o: OffboardingDoc, code: string, opts: TransitionOpts): Promise<OffboardingDoc> {
  const def = await getWorkflow('hr_offboarding');
  const { policy } = await eosPolicy();
  const employee = await Employee.findById(o.employeeId);
  if (!employee) throw notFound('الموظف غير موجود');
  const rel = opts.actor.system ? ['system', 'approver'] : await relationsFor(opts.user, o, policy);
  const now = new Date();
  const today = riyadhDate(now);
  if (['approve', 'reject'].includes(code) && String(o.requestedBy) === String(opts.user._id) && !opts.actor.system) throw forbidden('لا يعتمد مقدّم الطلب طلبه (فصل المهام)');
  if (code === 'complete' && !(await completable(o))) throw badRequest('الإقفال بعد إتمام الخطوات الأربع (المخالصة، العهد، التقنية، مقابلة الخروج) وانقضاء آخر يوم عمل');
  // E25 — the art. 79 bis clock.
  let lastWorkingDay = opts.lastWorkingDay ?? o.lastWorkingDay;
  let acceptanceKind: string | undefined;
  if (code === 'withdraw_resignation') {
    if (o.resignation?.acceptedAt) throw badRequest('قُبلت الاستقالة؛ لا عدول بعد القبول (المادة 79 مكرر)', { code: 'already_accepted' });
    if (o.resignation?.withdrawDeadline && o.resignation.withdrawDeadline < now) throw badRequest(`انتهت مهلة العدول (${policy.resignationWithdrawDays} أيام من التقديم — المادة 79 مكرر)`, { code: 'withdraw_window_over' });
  }
  if (code === 'postpone_resignation') {
    if (!opts.postponedUntil) throw badRequest('حدّد تاريخ انتهاء التأجيل');
    const submitted = riyadhDate(o.resignation!.submittedAt!);
    const max = addDays(submitted, policy.resignationMaxPostponeDays);
    if (opts.postponedUntil > max) throw badRequest(`التأجيل حتى ${max} على الأكثر (${policy.resignationMaxPostponeDays} يوماً من التقديم — المادة 79 مكرر)`, { code: 'postpone_over_max' });
    if (opts.postponedUntil <= today) throw badRequest('تاريخ التأجيل يجب أن يكون لاحقاً');
    if (o.resignation?.deemedAcceptedAt && o.resignation.deemedAcceptedAt < now) throw badRequest('مضى ثلاثون يوماً بلا رد — الاستقالة مقبولة ضمنياً ولا تُؤجَّل', { code: 'deemed_accepted' });
    lastWorkingDay = opts.postponedUntil;
  }
  if (code === 'accept_resignation') {
    acceptanceKind = opts.actor.system ? (o.state === 'resignation_postponed' ? 'postponement_end' : 'deemed') : 'explicit';
    const end = resignationEndDay({ acceptedAt: acceptanceKind === 'explicit' ? now : null, deemedAcceptedAt: o.resignation?.deemedAcceptedAt, postponedUntil: o.resignation?.postponedUntil, requestedLastWorkingDay: o.resignation?.requestedLastWorkingDay });
    lastWorkingDay = end.day;
    acceptanceKind = end.kind;
  }
  // The gates run again at approval (the state of the file may have changed since the request).
  if (code === 'approve') {
    await legalChecks(employee, o.reason as EosReason, lastWorkingDay, o.noticeDate ?? undefined);
    if (o.reason === 'dismissal_art80' && o.art80Case === 'absence') {
      const contract = o.contractId ? await Contract.findById(o.contractId).lean() : null;
      const check = await art80AbsenceCheck(employee, contract?.originalStartDate ?? contract?.startDate ?? employee.hireDate, lastWorkingDay);
      if (!check.ok) throw badRequest(check.messageAr, { code: 'art80_absence_not_met', check });
    }
  }
  const fromState = o.state;
  const toState = def.transitions.find((t) => t.code === code)?.to;
  await withTransaction(async (session) => {
    const r = await applyTransition({
      def,
      record: { ...o.toObject(), 'resignation.postponedUntil': opts.postponedUntil ?? o.resignation?.postponedUntil } as never,
      recordType: 'hr_offboarding',
      transition: code,
      actor: opts.actor,
      actorRelations: rel,
      reason: opts.reason,
      departmentId: o.departmentId ? String(o.departmentId) : undefined,
      now,
      session,
      persist: async (fields) => {
        const set: Record<string, unknown> = { ...fields, lastWorkingDay };
        if (code === 'approve' || code === 'accept_resignation') Object.assign(set, { approvedBy: opts.actor.system ? undefined : opts.user._id, approvedAt: now });
        if (code === 'postpone_resignation') Object.assign(set, { 'resignation.postponedUntil': opts.postponedUntil, 'resignation.postponeReason': opts.reason, 'resignation.postponedBy': opts.user._id });
        if (code === 'accept_resignation') Object.assign(set, { 'resignation.acceptedAt': now, 'resignation.acceptedBy': opts.actor.system ? undefined : opts.user._id, 'resignation.acceptanceKind': acceptanceKind });
        if (code === 'withdraw_resignation') set['resignation.withdrawnAt'] = now;
        if (code === 'complete') Object.assign(set, { completedAt: now, 'retention.keepUntil': new Date(riyadhDayStartOf(lastWorkingDay).getTime() + policy.retentionYears * 365.25 * DAY) });
        return (await Offboarding.updateOne({ _id: o._id, state: fromState }, { $set: set }, { session })).modifiedCount === 1;
      },
    });
    await event(o, code, opts.actor, { fromState, toState: r.to, note: opts.reason, data: { lastWorkingDay, acceptanceKind, postponedUntil: opts.postponedUntil } }, session);
    await recordAudit(opts.actor, { action: 'transition', resource: 'hr.offboarding', resourceId: String(o._id), before: { state: fromState }, after: { state: r.to }, meta: { transition: code, reason: opts.reason, lastWorkingDay }, sensitive: true }, session);
    await publish({ type: `hr.offboarding.${code}`, aggregateType: 'hr_offboarding', aggregateId: String(o._id), payload: { number: o.number, employeeId: String(o.employeeId), from: fromState, to: r.to, lastWorkingDay }, actorUserId: opts.actor.userId }, session);
  });
  let doc = (await Offboarding.findById(o._id))!;
  if (toState === 'approved') doc = await onApproved(doc, employee, opts, policy);
  if (code === 'cancel' && ['approved'].includes(fromState)) {
    // Existing behaviour (DECISIONS §11.3): cancelling re-enables the account and the status.
    await changeStatus(String(employee._id), { status: 'active', effectiveDate: now, reason: `إلغاء إنهاء الخدمة ${doc.number}: ${opts.reason ?? ''}` }, opts.actor);
    if (doc.it?.taskId) await Task.updateOne({ _id: doc.it.taskId, status: { $nin: ['done', 'cancelled'] } }, { $set: { status: 'cancelled' } });
  }
  if (code === 'complete') {
    await changeStatus(String(employee._id), { status: 'terminated', effectiveDate: riyadhDayEndOf(doc.lastWorkingDay), reason: `اكتمل إنهاء الخدمة ${doc.number} — ${EOS_REASON_AR[doc.reason as EosReason]}` }, opts.actor);
    if (doc.contractId) await Contract.updateOne({ _id: doc.contractId, status: { $in: ['active', 'renewing', 'expired'] } }, { $set: { status: 'terminated', statusReason: `eos:${doc.number}` } });
  }
  await notifyTransition(doc, employee, code, opts, policy);
  return doc;
}
/** «مراجعة واعتماد الإجراء»: status + last day (existing behaviour), the settlement deadline, the custody checklist and the IT task. */
async function onApproved(o: OffboardingDoc, employee: EmployeeDoc, opts: TransitionOpts, policy: EosPolicy): Promise<OffboardingDoc> {
  const status = o.initiatedBy === 'employee' ? 'resigned' : 'terminated';
  await changeStatus(String(employee._id), { status, effectiveDate: riyadhDayEndOf(o.lastWorkingDay), reason: `${EOS_REASON_AR[o.reason as EosReason]} — ${o.number}` }, opts.actor);
  const dueDay = settlementDueDay(o.lastWorkingDay, o.initiatedBy as never, policy);
  const custody = await Custody.find({ employeeId: employee._id, returnedAt: null }).select('itemName').lean();
  const itDept = await Department.findOne({ code: 'it' }).select('_id').lean();
  const now = new Date();
  let taskId: unknown;
  if (itDept) {
    const [task] = await Task.create([
      {
        number: await nextNumber('task'),
        title: `إغلاق حسابات وصلاحيات: ${employee.fullNameAr} (${o.number})`,
        description: `آخر يوم عمل ${o.lastWorkingDay}. العهد المفتوحة: ${custody.map((c) => c.itemName).join('، ') || 'لا شيء'}. يؤكَّد الإغلاق من سجل إنهاء الخدمة [HR §3.10.6, IT §7.3].`,
        assignerId: opts.user?._id ?? employee.userId,
        departmentId: itDept._id,
        priority: 'high',
        status: 'new',
        startAt: now,
        dueAt: riyadhDayEndOf(o.lastWorkingDay),
        source: { type: 'offboarding', id: String(o._id), label: o.number },
      },
    ]);
    taskId = task._id;
  }
  await Offboarding.updateOne(
    { _id: o._id },
    {
      $set: {
        'settlement.dueAt': riyadhDayEndOf(dueDay),
        'settlement.state': 'pending',
        'steps.custody_return.done': custody.length === 0,
        ...(custody.length === 0 ? { 'steps.custody_return.at': now } : {}),
        'steps.it_closure.done': !itDept, // no IT department in this installation → nothing to confirm
        it: { taskId, requestedAt: now },
        custodyChecklist: custody.map((c) => ({ custodyId: c._id, itemName: c.itemName })),
      },
    },
  );
  await publish({ type: 'hr.offboarding.it_requested', aggregateType: 'hr_offboarding', aggregateId: String(o._id), payload: { number: o.number, employeeId: String(employee._id), lastWorkingDay: o.lastWorkingDay, custody: custody.map((c) => c.itemName), taskId: taskId ? String(taskId) : undefined }, actorUserId: opts.actor.userId });
  await publish({ type: 'hr.offboarding.approved', aggregateType: 'hr_offboarding', aggregateId: String(o._id), payload: { number: o.number, employeeId: String(employee._id), lastWorkingDay: o.lastWorkingDay, settlementDue: dueDay }, actorUserId: opts.actor.userId });
  if (itDept) await notify({ userIds: await usersWithRole(IT_ROLES), type: 'offboarding.it_task', bodyAr: `${employee.fullNameAr} — آخر يوم عمل ${o.lastWorkingDay} (${o.number})`, link: `/it/offboarding` });
  await event(o, 'steps_started', opts.actor, { data: { settlementDue: dueDay, custody: custody.length, itTaskId: taskId ? String(taskId) : null } });
  return (await Offboarding.findById(o._id))!;
}
async function notifyTransition(doc: OffboardingDoc, employee: EmployeeDoc, code: string, opts: TransitionOpts, policy: EosPolicy) {
  const subject = employee.userId ? [String(employee.userId)] : [];
  const manager = await managerUserIdOf(employee);
  const hr = await hrUserIds();
  const label = EOS_REASON_AR[doc.reason as EosReason];
  if (code === 'submit') await notify({ userIds: await usersWithRole([policy.approverRole]), type: 'offboarding.requested', bodyAr: `${employee.fullNameAr} — ${label} — آخر يوم عمل ${doc.lastWorkingDay} (${doc.number})`, link: `/hr/offboarding/${doc._id}` });
  if (code === 'approve' || code === 'accept_resignation') {
    const kind = doc.resignation?.acceptanceKind === 'deemed' ? 'قُبلت ضمنياً بمضي ثلاثين يوماً بلا رد' : doc.resignation?.acceptanceKind === 'postponement_end' ? 'انتهت مدة التأجيل' : code === 'accept_resignation' ? 'قُبلت استقالتك' : 'اعتُمد إنهاء خدمتك';
    await notify({ userIds: subject, type: code === 'accept_resignation' ? 'resignation.decided' : 'offboarding.approved', bodyAr: `${kind} — آخر يوم عمل ${doc.lastWorkingDay}؛ تُصفّى حقوقك خلال ${doc.initiatedBy === 'employee' ? 'أسبوعين' : 'أسبوع'} من انتهاء العلاقة (المادة 88)`, link: '/me/offboarding' });
    await notify({ userIds: [...new Set([...hr, ...(manager ? [manager] : [])])], type: 'offboarding.approved', bodyAr: `${employee.fullNameAr} — ${label} — آخر يوم عمل ${doc.lastWorkingDay} (${doc.number}); الخطوات الأربع بدأت`, link: `/hr/offboarding/${doc._id}` });
  }
  if (code === 'postpone_resignation') await notify({ userIds: subject, type: 'resignation.decided', bodyAr: `أُجِّل قبول استقالتك حتى ${doc.resignation?.postponedUntil} لمصلحة العمل: ${opts.reason ?? ''} (المادة 79 مكرر)`, link: '/me/offboarding' });
  if (code === 'withdraw_resignation') await notify({ userIds: [...new Set([...hr, ...(manager ? [manager] : [])])], type: 'resignation.withdrawn', bodyAr: `${employee.fullNameAr} عدل عن استقالته ${doc.number} خلال المهلة`, link: `/hr/offboarding/${doc._id}` });
  if (code === 'reject') await notify({ userIds: [String(doc.requestedBy)], type: 'request.decided', bodyAr: `رُفض طلب إنهاء الخدمة ${doc.number}: ${opts.reason ?? ''}`, link: `/hr/offboarding/${doc._id}` });
  if (code === 'complete') await notify({ userIds: [...new Set([...hr, ...subject])], type: 'offboarding.completed', bodyAr: `${employee.fullNameAr} — اكتمل إنهاء الخدمة ${doc.number}؛ الملف محفوظ للقراءة حتى ${doc.retention?.keepUntil ? riyadhDate(doc.retention.keepUntil) : ''}`, link: `/hr/offboarding/${doc._id}` });
}
/** Settlement amounts are sensitive (HR_PLAN §6): the employee sees their own; HR and Finance see all; others nothing. */
export function redact(o: Record<string, unknown>, user: UserDoc, isSubject: boolean) {
  if (isSubject || hasRole(user, [...HR_ROLES, ...FINANCE_ROLES])) return o;
  const { settlement, hearing, ...rest } = o;
  void settlement;
  void hearing;
  return rest;
}

// ==================================================================================================
// Settlement (E3, E5, E11–E18, E20) — a separate payslip sent to Finance on approval (DECISIONS §22 Q2)
// ==================================================================================================
interface Line {
  code: SettlementLineCode;
  labelAr: string;
  kind: 'earning' | 'deduction';
  amountHalalas: number;
  basisAr?: string;
  articleAr?: string;
  computed: boolean;
  sourceType?: string;
  sourceId?: string;
}
async function commissionAverage(employee: EmployeeDoc, months: number, types: readonly string[], lastWorkingDay: string): Promise<number | null> {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const slips = await Payslip.find({ employeeId: employee._id, period: { $lte: lastWorkingDay.slice(0, 7) } }).sort({ period: -1 }).limit(months).select('earnings period').lean();
  if (!slips.length) return null;
  const serviceMonths = Math.max(1, Math.round(daysDiff(riyadhDate(employee.hireDate), lastWorkingDay) / 30.44));
  const n = Math.min(months, serviceMonths, slips.length);
  const sum = slips.slice(0, n).reduce((s, p) => s + (p.earnings ?? []).filter((l) => l.code.startsWith('allowance:') && types.some((t) => norm(l.code.slice('allowance:'.length)) === norm(t))).reduce((x, l) => x + l.amountHalalas, 0), 0);
  return round(sum / n);
}
export async function computeSettlement(o: OffboardingDoc, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  if (o.state !== 'approved') throw badRequest('تُحسب المخالصة بعد اعتماد إنهاء الخدمة');
  if (['approved', 'at_finance', 'paid'].includes(o.settlement?.state ?? '')) throw badRequest('المخالصة معتمدة — لا تُعاد');
  const { policy, provisional } = await eosPolicy();
  const payroll = await getSettingMeta('hr.payroll.policy');
  const overtime = await getSetting('hr.overtime');
  const employee = await Employee.findById(o.employeeId);
  if (!employee) throw notFound();
  const contract = o.contractId ? await Contract.findById(o.contractId).lean() : await Contract.findOne({ employeeId: employee._id }).sort({ version: -1 }).lean();
  const reason = o.reason as EosReason;
  const lastDay = o.lastWorkingDay;
  const flags: string[] = [];
  const lines: Line[] = [];
  const basic = employee.basicSalaryHalalas ?? 0;
  const monthly = monthlyWageOf(employee);
  if (!basic) flags.push('no_salary');
  // E11 (arts. 84, 2): service from the first contract of the chain; the wage = basic + all allowances + commissions (E13).
  const serviceStart = riyadhDate(contract?.originalStartDate ?? contract?.startDate ?? employee.hireDate);
  const serviceDays = Math.max(0, daysDiff(serviceStart, lastDay) + 1);
  const excludeCommissions = !!contract?.awardExcludesVariableWage;
  const commissionAvg = excludeCommissions ? null : await commissionAverage(employee, policy.commissionAverageMonths, policy.commissionAllowanceTypes, lastDay);
  const wage = awardWageOf(basic, employee.allowances ?? [], { commissionTypes: policy.commissionAllowanceTypes, excludeCommissions, commissionAverageHalalas: commissionAvg });
  if (!excludeCommissions && wage.commissionsHalalas) flags.push('commission_average_to_confirm'); // O3: «يُؤكَّد من الموارد البشرية»
  const award = eosAwardHalalas(wage.totalHalalas, serviceDays);
  const fraction = awardFractionBp(reason, award.years);
  const awardAmount = round((award.amountHalalas * fraction.bp) / 10_000);
  lines.push({ code: 'eos_award', labelAr: SETTLEMENT_LINE_AR.eos_award, kind: 'earning', amountHalalas: awardAmount, basisAr: `${award.basisAr}؛ الخدمة ${serviceDays} يوماً من ${serviceStart}${fraction.bp < 10_000 ? `؛ النسبة ${fraction.bp / 100}%` : ''}`, articleAr: fraction.articleAr, computed: true });
  // E16 (art. 111) + overtime leave (DECISIONS §21 Q5).
  const year = Number(lastDay.slice(0, 4));
  const annual = await balance(employee._id, 'annual', year);
  if (annual > 0) lines.push({ code: 'unused_leave', labelAr: SETTLEMENT_LINE_AR.unused_leave, kind: 'earning', amountHalalas: round((monthly / 30) * annual), basisAr: `${annual} يوماً × الأجر اليومي (${monthly} ÷ 30 هللة)`, articleAr: 'المادة 111', computed: true });
  const otLeave = await balance(employee._id, 'overtime_comp', year);
  if (otLeave > 0) lines.push({ code: 'overtime_leave', labelAr: SETTLEMENT_LINE_AR.overtime_leave, kind: 'earning', amountHalalas: round((monthly / 30) * otLeave), basisAr: `${otLeave} يوماً غير مستخدم — يُدفع عند الانتهاء`, articleAr: 'المادة 107 (تعديل 2025)', computed: true });
  // E18: the last month's days, absences and approved overtime from H2 (never a second payment: flagged when a payslip covers the period).
  const monthStart = `${lastDay.slice(0, 7)}-01`;
  await ensureDaysComputed([employee._id], monthStart, lastDay);
  const days = await AttendanceDay.find({ employeeId: employee._id, day: { $gte: monthStart, $lte: lastDay } }).lean();
  const s = summarizeDays(days as never);
  const calendarDays = daysDiff(monthStart, lastDay) + 1;
  if (await Payslip.exists({ employeeId: employee._id, period: lastDay.slice(0, 7) })) flags.push('payroll_overlap');
  else {
    lines.push({ code: 'pending_salary', labelAr: SETTLEMENT_LINE_AR.pending_salary, kind: 'earning', amountHalalas: round((monthly / 30) * Math.min(calendarDays, 30)), basisAr: `${calendarDays} يوماً من ${monthStart} إلى ${lastDay} × (${monthly} ÷ 30)`, articleAr: 'المادة 2', computed: true });
    const absent = days.filter((d) => d.status === 'absent').length;
    if (absent) lines.push({ code: 'absence', labelAr: SETTLEMENT_LINE_AR.absence, kind: 'deduction', amountHalalas: round((monthly / 30) * absent), basisAr: `${absent} أيام غياب في الشهر الأخير`, computed: true });
    if (s.overtimeApprovedMinutes) {
      const hour = overtimeHourHalalas(basic, monthly, payroll.value.dailyHours, overtime.rateBp);
      lines.push({ code: 'overtime', labelAr: SETTLEMENT_LINE_AR.overtime, kind: 'earning', amountHalalas: round((s.overtimeApprovedMinutes / 60) * hour), basisAr: `${s.overtimeApprovedMinutes} دقيقة معتمدة × أجر الساعة الإضافية`, articleAr: 'المادة 107', computed: true });
    }
  }
  // E3 (art. 76): the notice shortfall — owed by whoever failed to give it.
  if (o.notice?.shortfallDays) {
    const amt = noticeCompensationHalalas(monthly, o.notice.shortfallDays);
    lines.push({ code: 'notice_compensation', labelAr: SETTLEMENT_LINE_AR.notice_compensation, kind: o.initiatedBy === 'employee' ? 'deduction' : 'earning', amountHalalas: amt, basisAr: `${o.notice.shortfallDays} يوماً من مهلة الإشعار غير المراعاة × الأجر اليومي`, articleAr: 'المادة 76', computed: true });
  }
  // E5 (art. 77).
  if (reason === 'unlawful_termination') {
    const remaining = contract?.endDate ? Math.max(0, daysDiff(lastDay, riyadhDate(contract.endDate))) : 0;
    const c = art77CompensationHalalas(contract?.type ?? 'open_ended', monthly, serviceDays, remaining);
    lines.push({ code: 'unlawful_termination', labelAr: SETTLEMENT_LINE_AR.unlawful_termination, kind: 'earning', amountHalalas: c.amountHalalas, basisAr: c.basisAr, articleAr: 'المادة 77', computed: true });
    flags.push('art77_needs_hr_and_finance_approval');
  }
  // E20 (art. 40): the return ticket of a non-Saudi, unless they end the relation without a legitimate reason.
  if (!isSaudi(employee.nationality) && !['resignation', 'employee_notice', 'dismissal_art80'].includes(reason)) {
    lines.push({ code: 'return_ticket', labelAr: SETTLEMENT_LINE_AR.return_ticket, kind: 'earning', amountHalalas: policy.returnTicketDefaultHalalas ?? 0, basisAr: policy.returnTicketDefaultHalalas === null ? 'أدخل قيمة التذكرة' : 'القيمة الافتراضية من الإعدادات', articleAr: 'المادة 40', computed: true });
    if (policy.returnTicketDefaultHalalas === null) flags.push('return_ticket_amount_needed');
  }
  // E15 / E17 (art. 88): debts due to work — outstanding advances, unreturned custody, unconsumed fines and adjustments.
  for (const sch of await AdvanceSchedule.find({ employeeId: employee._id })) {
    const owed = sch.instalments.filter((i) => !i.payslipId).reduce((x, i) => x + i.amountHalalas, 0);
    if (owed) lines.push({ code: 'advance_outstanding', labelAr: `${SETTLEMENT_LINE_AR.advance_outstanding} ${sch.requestNumber ?? ''}`.trim(), kind: 'deduction', amountHalalas: owed, basisAr: `${sch.instalments.filter((i) => !i.payslipId).length} أقساط غير مستحقة بعد`, articleAr: 'المادة 88', computed: true, sourceType: 'advance_schedule', sourceId: String(sch._id) });
  }
  for (const c of o.custodyChecklist ?? []) if (c.notReturned && c.chargeHalalas) lines.push({ code: 'custody_not_returned', labelAr: `${SETTLEMENT_LINE_AR.custody_not_returned}: ${c.itemName}`, kind: 'deduction', amountHalalas: c.chargeHalalas, basisAr: 'قيمة معتمدة للعهدة غير المُرجعة', articleAr: 'المادة 88', computed: true });
  for (const a of await PayrollAdjustment.find({ employeeId: employee._id, consumedByRunId: null })) {
    lines.push({ code: a.kind === 'deduction' ? (a.sourceType === 'disciplinary' ? 'fine' : 'other_deduction') : 'other_earning', labelAr: `${a.sourceType === 'disciplinary' ? SETTLEMENT_LINE_AR.fine : a.kind === 'deduction' ? SETTLEMENT_LINE_AR.other_deduction : SETTLEMENT_LINE_AR.other_earning}: ${a.reason}`, kind: a.kind as 'earning' | 'deduction', amountHalalas: a.amountHalalas, articleAr: a.sourceType === 'disciplinary' ? 'المادة 70' : undefined, computed: true, sourceType: 'payroll_adjustment', sourceId: String(a._id) });
  }
  if (provisional || payroll.provisional) flags.push('provisional_policy');
  const earnings = lines.filter((l) => l.kind === 'earning').reduce((x, l) => x + l.amountHalalas, 0);
  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((x, l) => x + l.amountHalalas, 0);
  const now = new Date();
  await Offboarding.updateOne(
    { _id: o._id },
    {
      $set: {
        settlement: {
          ...((o.settlement as unknown as { toObject?: () => Record<string, unknown> } | undefined)?.toObject?.() ?? {}),
          state: 'computed',
          lines,
          earningsHalalas: earnings,
          deductionsHalalas: deductions,
          netHalalas: earnings - deductions,
          awardWage: { ...wage, commissionsExcluded: excludeCommissions, clauseRef: contract?.awardExclusionClauseRef },
          serviceDays,
          serviceYears: Math.round(award.years * 100) / 100,
          awardFraction: fraction.bp,
          computedAt: now,
          computedBy: user._id,
          provisional: provisional || payroll.provisional,
          flags,
          dueAt: o.settlement?.dueAt ?? riyadhDayEndOf(settlementDueDay(lastDay, o.initiatedBy as never, policy)),
        },
      },
    },
  );
  await event(o, 'settlement_computed', actor, { step: 'settlement', data: { net: earnings - deductions, flags } });
  await recordAudit(actor, { action: 'update', resource: 'hr.offboarding', resourceId: String(o._id), after: { settlement: { net: earnings - deductions, lines: lines.length } }, meta: { step: 'settlement', action: 'compute' }, sensitive: true });
  return (await Offboarding.findById(o._id))!;
}
export async function editSettlementLine(o: OffboardingDoc, line: { code: SettlementLineCode; labelAr?: string; amountHalalas: number; kind: 'earning' | 'deduction'; reason: string }, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  if (o.settlement?.state !== 'computed') throw badRequest('تُعدَّل بنود المخالصة بعد حسابها وقبل اعتمادها');
  const lines = (o.settlement.lines ?? []).map((l) => l.toObject?.() ?? l) as unknown as (Line & { editedBy?: unknown; editReason?: string })[];
  const idx = lines.findIndex((l) => l.code === line.code && (!line.labelAr || l.labelAr === line.labelAr));
  const before = idx >= 0 ? lines[idx].amountHalalas : null;
  const next = { code: line.code, labelAr: line.labelAr ?? SETTLEMENT_LINE_AR[line.code], kind: line.kind, amountHalalas: line.amountHalalas, basisAr: idx >= 0 ? lines[idx].basisAr : undefined, articleAr: idx >= 0 ? lines[idx].articleAr : undefined, computed: false, editedBy: user._id, editReason: line.reason };
  if (idx >= 0) lines[idx] = next;
  else lines.push(next);
  const earnings = lines.filter((l) => l.kind === 'earning').reduce((x, l) => x + l.amountHalalas, 0);
  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((x, l) => x + l.amountHalalas, 0);
  await Offboarding.updateOne({ _id: o._id }, { $set: { 'settlement.lines': lines, 'settlement.earningsHalalas': earnings, 'settlement.deductionsHalalas': deductions, 'settlement.netHalalas': earnings - deductions } });
  await event(o, 'settlement_line_edited', actor, { step: 'settlement', note: line.reason, data: { code: line.code, before, after: line.amountHalalas } });
  await recordAudit(actor, { action: 'update', resource: 'hr.offboarding', resourceId: String(o._id), before: { [line.code]: before }, after: { [line.code]: line.amountHalalas }, meta: { step: 'settlement', action: 'edit_line', reason: line.reason }, sensitive: true });
  return (await Offboarding.findById(o._id))!;
}
/** HR manager approves (Q9); the computer never approves (FIN §12); the payslip goes to Finance at once (DECISIONS §22 Q2). */
export async function approveSettlement(o: OffboardingDoc, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  const { policy } = await eosPolicy();
  if (o.settlement?.state !== 'computed') throw badRequest('تُعتمد مخالصة محسوبة');
  if (!roleCodes(user).includes(policy.settlementApproverRole)) throw forbidden('اعتماد المخالصة من صلاحية مدير الموارد البشرية');
  if (o.settlement.computedBy && String(o.settlement.computedBy) === String(user._id)) throw forbidden('لا يعتمد من حسب المخالصة اعتمادها (فصل المهام)');
  if (o.settlement.flags?.includes('return_ticket_amount_needed')) throw badRequest('أدخل قيمة تذكرة العودة قبل الاعتماد (المادة 40)');
  const employee = await Employee.findById(o.employeeId).select('fullNameAr userId').lean();
  const now = new Date();
  const settlement = o.settlement!;
  await withTransaction(async (session) => {
    const r = await Offboarding.updateOne({ _id: o._id, 'settlement.state': 'computed' }, { $set: { 'settlement.state': 'at_finance', 'settlement.approvedBy': user._id, 'settlement.approvedAt': now, 'settlement.sentToFinanceAt': now, 'steps.settlement.done': true, 'steps.settlement.at': now, 'steps.settlement.by': user._id } }, { session });
    if (!r.modifiedCount) throw conflict('تغيّرت حالة المخالصة');
    // The adjustments and schedules the settlement took are closed so a later run never deducts them again.
    const adjIds = (settlement.lines ?? []).filter((l) => l.sourceType === 'payroll_adjustment').map((l) => l.sourceId);
    if (adjIds.length) await PayrollAdjustment.updateMany({ _id: { $in: adjIds } }, { $set: { consumedAt: now, consumedByRunId: o._id } }, { session });
    await event(o, 'settlement_approved', actor, { step: 'settlement', data: { net: settlement.netHalalas } }, session);
    await recordAudit(actor, { action: 'approve', resource: 'hr.offboarding', resourceId: String(o._id), after: { settlement: { state: 'at_finance', net: settlement.netHalalas } }, sensitive: true }, session);
    await publish({ type: 'hr.offboarding.settlement_to_finance', aggregateType: 'hr_offboarding', aggregateId: String(o._id), payload: { number: o.number, employeeId: String(o.employeeId), netHalalas: settlement.netHalalas, dueAt: settlement.dueAt }, actorUserId: actor.userId }, session);
  });
  await notify({ userIds: await usersWithRole(FINANCE_ROLES), type: 'offboarding.settlement_approved', bodyAr: `${employee?.fullNameAr ?? ''} — ${o.number}: صافي ${((settlement.netHalalas ?? 0) / 100).toLocaleString('ar-SA-u-nu-latn')} ريال، يُسدَّد قبل ${settlement.dueAt ? riyadhDate(settlement.dueAt) : ''} (المادة 88)`, link: `/finance/settlements` });
  return (await Offboarding.findById(o._id))!;
}
export async function recordSettlementPayment(o: OffboardingDoc, input: { paidAt?: string; paymentRef?: string; proofAttachmentId?: string; note?: string }, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  if (!hasRole(user, FINANCE_ROLES)) throw forbidden('تسجيل السداد من المالية');
  if (o.settlement?.state !== 'at_finance') throw badRequest('المخالصة ليست لدى المالية');
  if (!input.paidAt) throw badRequest('حدّد تاريخ السداد');
  const now = new Date();
  await Offboarding.updateOne({ _id: o._id }, { $set: { 'settlement.state': 'paid', 'settlement.finance': { paidAt: riyadhDayEndOf(input.paidAt), paidBy: user._id, paymentRef: input.paymentRef, proofAttachmentId: input.proofAttachmentId, note: input.note } } });
  if (input.proofAttachmentId) await claimAttachments([input.proofAttachmentId], 'offboarding', String(o._id), user._id);
  await event(o, 'settlement_paid', actor, { step: 'settlement', data: { paidAt: input.paidAt, paymentRef: input.paymentRef } });
  await recordAudit(actor, { action: 'update', resource: 'hr.offboarding', resourceId: String(o._id), after: { settlement: { state: 'paid', paidAt: input.paidAt } }, sensitive: true });
  await publish({ type: 'hr.offboarding.settlement_paid', aggregateType: 'hr_offboarding', aggregateId: String(o._id), payload: { number: o.number, paidAt: input.paidAt }, actorUserId: actor.userId });
  const employee = await Employee.findById(o.employeeId).select('userId').lean();
  if (employee?.userId) await notify({ userIds: [String(employee.userId)], type: 'offboarding.settlement_approved', titleAr: 'تم سداد مخالصتك النهائية', bodyAr: `${o.number} — بتاريخ ${input.paidAt}${input.paymentRef ? ` (${input.paymentRef})` : ''}`, link: '/me/offboarding' });
  void now;
  return (await Offboarding.findById(o._id))!;
}

// ==================================================================================================
// The other steps: custody (5), IT (6), exit interview (7), certificate (8), government exit (E22)
// ==================================================================================================
export async function returnCustodyStep(o: OffboardingDoc, input: { custodyId: string; returnedAt: string; condition?: string; notReturned: boolean; chargeHalalas?: number }, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  if (o.state !== 'approved') throw badRequest('استرداد العهد بعد اعتماد إنهاء الخدمة');
  const c = await Custody.findOne({ _id: input.custodyId, employeeId: o.employeeId });
  if (!c) throw notFound('العهدة غير موجودة');
  const now = new Date();
  if (!input.notReturned) {
    if (c.returnedAt) throw badRequest('أُرجعت هذه العهدة من قبل');
    c.returnedAt = riyadhDayEndOf(input.returnedAt);
    c.condition = input.condition;
    await c.save();
  } else if (!input.chargeHalalas && input.chargeHalalas !== 0) throw badRequest('حدّد القيمة المعتمدة للعهدة غير المُرجعة (أو 0)');
  const list = (o.custodyChecklist ?? []).map((x) => x.toObject?.() ?? x) as Record<string, unknown>[];
  const idx = list.findIndex((x) => String(x.custodyId) === String(c._id));
  const row = { custodyId: c._id, itemName: c.itemName, returnedAt: input.notReturned ? undefined : input.returnedAt, condition: input.condition, notReturned: input.notReturned, chargeHalalas: input.chargeHalalas, by: user._id };
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  const open = await Custody.countDocuments({ employeeId: o.employeeId, returnedAt: null, _id: { $nin: list.filter((x) => x.notReturned).map((x) => x.custodyId) } });
  await Offboarding.updateOne({ _id: o._id }, { $set: { custodyChecklist: list, ...(open === 0 ? { 'steps.custody_return.done': true, 'steps.custody_return.at': now, 'steps.custody_return.by': user._id } : {}) } });
  await event(o, input.notReturned ? 'custody_not_returned' : 'custody_returned', actor, { step: 'custody_return', data: { custodyId: String(c._id), itemName: c.itemName, chargeHalalas: input.chargeHalalas } });
  await recordAudit(actor, { action: 'update', resource: 'hr.custody', resourceId: String(c._id), after: { returnedAt: c.returnedAt, notReturned: input.notReturned }, meta: { offboardingId: String(o._id) } });
  return (await Offboarding.findById(o._id))!;
}
export async function confirmItClosure(o: OffboardingDoc, input: { note?: string; assetsReturned: boolean }, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  // The route's `it.offboarding:edit` grant (system admin, IT department members) is the gate; the service checks the record.
  if (o.state !== 'approved') throw badRequest('إنهاء الخدمة ليس معتمداً');
  if (o.steps?.it_closure?.done) throw badRequest('أُكِّد الإغلاق من قبل');
  const now = new Date();
  await Offboarding.updateOne({ _id: o._id }, { $set: { 'it.confirmedAt': now, 'it.confirmedBy': user._id, 'it.note': input.note, 'it.assetsReturned': input.assetsReturned, 'steps.it_closure.done': true, 'steps.it_closure.at': now, 'steps.it_closure.by': user._id } });
  if (o.it?.taskId) await Task.updateOne({ _id: o.it.taskId, status: { $nin: ['done', 'cancelled'] } }, { $set: { status: 'done', progressPercent: 100, completedAt: now } });
  await event(o, 'it_confirmed', actor, { step: 'it_closure', note: input.note });
  await recordAudit(actor, { action: 'update', resource: 'it.offboarding', resourceId: String(o._id), after: { confirmedAt: now, assetsReturned: input.assetsReturned } });
  await publish({ type: 'hr.offboarding.it_confirmed', aggregateType: 'hr_offboarding', aggregateId: String(o._id), payload: { number: o.number, employeeId: String(o.employeeId), assetsReturned: input.assetsReturned }, actorUserId: actor.userId });
  await notify({ userIds: await hrUserIds(), type: 'offboarding.it_confirmed', bodyAr: `${o.number} — ${input.note ?? ''}`, link: `/hr/offboarding/${o._id}` });
  return (await Offboarding.findById(o._id))!;
}
export async function recordExitInterview(o: OffboardingDoc, input: { answers: { key: string; value: unknown }[]; interviewedAt: string; declined: boolean }, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  if (o.state !== 'approved') throw badRequest('مقابلة الخروج بعد اعتماد إنهاء الخدمة');
  if (o.steps?.exit_interview?.done) throw badRequest('سُجِّلت مقابلة الخروج من قبل');
  const tpl = await getSetting('hr.exitInterview.template');
  const keys = new Set(tpl.questions.map((q) => q.key));
  for (const a of input.answers) if (!keys.has(a.key)) throw badRequest(`سؤال غير معروف: ${a.key}`);
  const now = new Date();
  await Offboarding.updateOne({ _id: o._id }, { $set: { exitInterview: { templateVersion: tpl.version, answers: input.answers, interviewerUserId: user._id, at: input.interviewedAt, declined: input.declined }, 'steps.exit_interview.done': true, 'steps.exit_interview.at': now, 'steps.exit_interview.by': user._id } });
  await event(o, 'exit_interview', actor, { step: 'exit_interview', data: { declined: input.declined, templateVersion: tpl.version } });
  await recordAudit(actor, { action: 'update', resource: 'hr.offboarding', resourceId: String(o._id), after: { exitInterview: { at: input.interviewedAt, declined: input.declined } }, sensitive: true });
  return (await Offboarding.findById(o._id))!;
}
/** E19 (art. 64): the service certificate — free, from the file, after approval; also available to the employee through the request type. */
export async function issueExperienceCertificate(o: OffboardingDoc, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  if (!['approved', 'completed'].includes(o.state)) throw badRequest('شهادة الخدمة بعد اعتماد إنهاء الخدمة');
  if (o.experienceCertificate?.number) throw badRequest(`أُصدرت الشهادة ${o.experienceCertificate.number} من قبل`);
  const employee = await Employee.findById(o.employeeId);
  if (!employee) throw notFound();
  if (!employee.endDate) employee.endDate = riyadhDayEndOf(o.lastWorkingDay);
  const cert = await issueCertificate({ _id: o._id, type: 'experience_certificate', details: { purpose: 'انتهاء الخدمة — المادة 64' } } as never, employee, String(user._id));
  const now = new Date();
  await Offboarding.updateOne({ _id: o._id }, { $set: { experienceCertificate: { number: cert.number, attachmentId: cert.attachmentId, issuedAt: now, issuedBy: user._id } } });
  await event(o, 'certificate_issued', actor, { data: { number: cert.number } });
  await recordAudit(actor, { action: 'create', resource: 'hr.certificates', resourceId: cert.number, meta: { offboardingId: String(o._id), employeeId: String(employee._id) }, sensitive: true });
  if (employee.userId) await notify({ userIds: [String(employee.userId)], type: 'request.decided', titleAr: 'صدرت شهادة خدمتك', bodyAr: `${cert.number} — المادة 64`, link: '/me/offboarding' });
  return (await Offboarding.findById(o._id))!;
}
/** E22: GOSI exit, Qiwa update, final exit — by hand with dates and references (phase 7 integration later). */
export async function recordGovExit(o: OffboardingDoc, input: { gosiExitRef?: string; gosiExitAt?: string; qiwaExitRef?: string; qiwaExitAt?: string; finalExitRef?: string }, user: UserDoc, actor: Actor): Promise<OffboardingDoc> {
  if (!['approved', 'completed'].includes(o.state)) throw badRequest('بعد اعتماد إنهاء الخدمة');
  await Offboarding.updateOne({ _id: o._id }, { $set: { gov: { ...((o.gov as unknown as { toObject?: () => Record<string, unknown> } | undefined)?.toObject?.() ?? {}), ...input, recordedBy: user._id, at: new Date() } } });
  await event(o, 'gov_exit_recorded', actor, { data: input });
  await recordAudit(actor, { action: 'update', resource: 'hr.offboarding', resourceId: String(o._id), after: { gov: input } });
  return (await Offboarding.findById(o._id))!;
}

// ==================================================================================================
// E26: the pregnancy record (sensitive, HR-entered)
// ==================================================================================================
export async function setPregnancyRecord(employee: EmployeeDoc, input: PregnancyRecordInput, user: UserDoc, actor: Actor) {
  if (!hasRole(user, HR_ROLES)) throw forbidden();
  if (employee.gender !== 'female') throw badRequest('السجل خاص بالعاملة');
  const before = employee.pregnancy ? { declaredAt: employee.pregnancy.declaredAt, endedAt: employee.pregnancy.endedAt } : null;
  employee.pregnancy = { declaredAt: riyadhDayStartOf(input.declaredAt), expectedDeliveryDate: riyadhDayStartOf(input.expectedDeliveryDate), certificateAttachmentId: input.certificateAttachmentId, endedAt: input.endedAt ? riyadhDayEndOf(input.endedAt) : undefined, note: input.note, recordedBy: user._id } as never;
  await employee.save();
  if (input.certificateAttachmentId) await claimAttachments([input.certificateAttachmentId], 'employee', String(employee._id), user._id);
  await recordAudit(actor, { action: 'update', resource: 'hr.employees', resourceId: String(employee._id), before: { pregnancy: before }, after: { pregnancy: { declaredAt: input.declaredAt, endedAt: input.endedAt ?? null } }, sensitive: true });
  return employee;
}

// ==================================================================================================
// Jobs (daily): the art. 79 bis clock, settlement deadlines, auto-complete, retirement alerts, government exit deadlines
// ==================================================================================================
export async function runOffboardingJobs(now = new Date()): Promise<{ deemed: number; postponementEnded: number; reminders: number; settlementAlerts: number; completed: number; retirementAlerts: number; govOverdue: number }> {
  const out = { deemed: 0, postponementEnded: 0, reminders: 0, settlementAlerts: 0, completed: 0, retirementAlerts: 0, govOverdue: 0 };
  const today = riyadhDate(now);
  const { policy } = await eosPolicy();
  const sys = (await User.findOne({ 'roles.role': 'system_admin' }).select('_id roles').lean()) as unknown as UserDoc | null;
  const systemUser = sys ?? ({ _id: undefined, roles: [] } as unknown as UserDoc);
  const hr = await hrUserIds();
  // E25: deemed acceptance after 30 days without a response; the end of a postponement.
  for (const o of await Offboarding.find({ state: 'resignation_submitted', 'resignation.deemedAcceptedAt': { $lt: now } })) {
    await transitionOffboarding(o, 'accept_resignation', { user: systemUser, actor: SYSTEM_ACTOR, reason: 'مضى ثلاثون يوماً دون رد — تُعد الاستقالة مقبولة (المادة 79 مكرر)' });
    out.deemed++;
  }
  for (const o of await Offboarding.find({ state: 'resignation_postponed', 'resignation.postponedUntil': { $lte: today } })) {
    await transitionOffboarding(o, 'accept_resignation', { user: systemUser, actor: SYSTEM_ACTOR, reason: 'انتهت مدة التأجيل (المادة 79 مكرر)' });
    out.postponementEnded++;
  }
  // A reminder to the approvers three days before the deemed acceptance (once).
  for (const o of await Offboarding.find({ state: 'resignation_submitted', 'resignation.deemedAcceptedAt': { $gte: now, $lte: new Date(now.getTime() + 3 * DAY) }, 'resignation.reminderSentAt': null })) {
    const e = await Employee.findById(o.employeeId).select('fullNameAr').lean();
    await notify({ userIds: await usersWithRole([policy.approverRole]), type: 'resignation.deadline', bodyAr: `${e?.fullNameAr ?? ''} — ${o.number}: تُقبل ضمنياً في ${riyadhDate(o.resignation!.deemedAcceptedAt!)} إن لم يُرد عليها`, link: `/hr/offboarding/${o._id}` });
    await Offboarding.updateOne({ _id: o._id }, { $set: { 'resignation.reminderSentAt': now } });
    out.reminders++;
  }
  // E15 (art. 88): two days before the deadline and when it passes, to Finance (and HR when not yet approved).
  for (const o of await Offboarding.find({ state: 'approved', 'settlement.state': { $ne: 'paid' }, 'settlement.dueAt': { $ne: null } })) {
    const due = o.settlement!.dueAt!;
    const e = await Employee.findById(o.employeeId).select('fullNameAr').lean();
    const notYetApproved = !['at_finance'].includes(o.settlement!.state ?? '');
    if (!o.settlement!.dueNotifiedAt && due.getTime() - now.getTime() <= 2 * DAY) {
      await notify({ userIds: [...new Set([...(await usersWithRole(FINANCE_ROLES)), ...(notYetApproved ? hr : [])])], type: 'offboarding.settlement_due', bodyAr: `${e?.fullNameAr ?? ''} — ${o.number}: مهلة السداد تنتهي ${riyadhDate(due)} (المادة 88)${notYetApproved ? ' — المخالصة لم تُعتمد بعد' : ''}`, link: notYetApproved ? `/hr/offboarding/${o._id}` : '/finance/settlements' });
      await Offboarding.updateOne({ _id: o._id }, { $set: { 'settlement.dueNotifiedAt': now } });
      out.settlementAlerts++;
    }
    if (!o.settlement!.overdueNotifiedAt && due < now) {
      await notify({ userIds: [...new Set([...(await usersWithRole(FINANCE_ROLES)), ...hr])], type: 'offboarding.settlement_due', titleAr: 'تجاوزت مخالصة نهائية مهلة السداد', bodyAr: `${e?.fullNameAr ?? ''} — ${o.number}: المهلة ${riyadhDate(due)} (المادة 88)`, link: `/hr/offboarding/${o._id}` });
      await Offboarding.updateOne({ _id: o._id }, { $set: { 'settlement.overdueNotifiedAt': now } });
      out.settlementAlerts++;
    }
  }
  // Step 9: all four steps done and the last day passed → «منتهي الخدمة».
  for (const o of await Offboarding.find({ state: 'approved', 'steps.settlement.done': true, 'steps.custody_return.done': true, 'steps.it_closure.done': true, 'steps.exit_interview.done': true, lastWorkingDay: { $lt: today } })) {
    await transitionOffboarding(o, 'complete', { user: systemUser, actor: SYSTEM_ACTOR });
    out.completed++;
  }
  // E1 / DECISIONS §22 Q5: retirement alert `retirementAlertDays` before the age from the setting (blank → nothing).
  const rules = await getSetting('hr.retirement.rules');
  if (rules.length) {
    for (const e of await Employee.find({ deletedAt: null, status: { $in: [...ON_DUTY_STATUSES, 'suspended'] }, birthDate: { $ne: null }, retirementAlertedAt: null })) {
      const age = retirementAgeFor(e, rules);
      if (age === null) continue;
      const day = retirementDay(riyadhDate(e.birthDate!), age);
      if (addDays(day, -policy.retirementAlertDays) > today) continue;
      await notify({ userIds: [...hr, ...(e.userId ? [String(e.userId)] : [])], type: 'retirement.approaching', bodyAr: `${e.fullNameAr} يبلغ سن التقاعد (${age} سنة وفق نظام التأمينات) في ${day} — ما لم يُتفق على الاستمرار (المادة 74)`, link: `/hr/employees/${e._id}` });
      e.retirementAlertedAt = now;
      await e.save();
      out.retirementAlerts++;
    }
  }
  // E22: government exit deadlines once HR confirms them.
  const gov = await getSetting('hr.gov');
  if (gov.gosiExitDays !== null || gov.qiwaExitDays !== null) {
    for (const o of await Offboarding.find({ state: { $in: ['approved', 'completed'] }, lastWorkingDay: { $lt: today }, 'gov.overdueNotifiedAt': null })) {
      const missing: string[] = [];
      if (gov.gosiExitDays !== null && !o.gov?.gosiExitRef && addDays(o.lastWorkingDay, gov.gosiExitDays) < today) missing.push('إشعار التأمينات بانتهاء الخدمة');
      if (gov.qiwaExitDays !== null && !o.gov?.qiwaExitRef && addDays(o.lastWorkingDay, gov.qiwaExitDays) < today) missing.push('تحديث العقد في قوى');
      if (!missing.length) continue;
      const e = await Employee.findById(o.employeeId).select('fullNameAr').lean();
      await notify({ userIds: hr, type: 'gov.registration_overdue', bodyAr: `${e?.fullNameAr ?? ''} (${o.number}) — تأخر: ${missing.join('، ')}`, link: `/hr/offboarding/${o._id}` });
      await Offboarding.updateOne({ _id: o._id }, { $set: { 'gov.overdueNotifiedAt': now } });
      out.govOverdue++;
    }
  }
  return out;
}

/** O2 (DECISIONS §22): which legal settings are still blank — the «إعدادات نظامية غير مكتملة» card. */
export async function legalSettingsStatus(): Promise<{ complete: boolean; missing: { key: string; labelAr: string }[] }> {
  const [gov, retirement, saudization] = await Promise.all([getSetting('hr.gov'), getSetting('hr.retirement.rules'), getSetting('hr.saudization')]);
  const missing: { key: string; labelAr: string }[] = [];
  if (gov.qiwaContractDays === null) missing.push({ key: 'hr.gov.qiwaContractDays', labelAr: 'مهلة توثيق العقد في قوى' });
  if (gov.gosiRegisterDays === null) missing.push({ key: 'hr.gov.gosiRegisterDays', labelAr: 'مهلة التسجيل في التأمينات' });
  if (gov.gosiExitDays === null) missing.push({ key: 'hr.gov.gosiExitDays', labelAr: 'مهلة إشعار التأمينات بانتهاء الخدمة' });
  if (gov.qiwaExitDays === null) missing.push({ key: 'hr.gov.qiwaExitDays', labelAr: 'مهلة تحديث قوى عند انتهاء الخدمة' });
  if (!retirement.length) missing.push({ key: 'hr.retirement.rules', labelAr: 'سن التقاعد وفق نظام التأمينات' });
  if (saudization.requiredRatePct === null) missing.push({ key: 'hr.saudization', labelAr: 'نسبة التوطين المطلوبة من قوى' });
  return { complete: missing.length === 0, missing };
}
