import type { ClientSession } from 'mongoose';
import {
  APPLICANT_STAGE_NEXT,
  type ApplicantStage,
  type CreateApplicantInput,
  type CreateOfferInput,
  type CreateRequisitionInput,
  type RecruitmentPolicy,
  type SaudizationSetting,
} from '@eayni/shared';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors';
import { SYSTEM_ACTOR, type Actor } from '../../core/http/context';
import { recordAudit } from '../../core/audit/service';
import { nextNumber } from '../../core/numbering/service';
import { notify } from '../../core/notifications/service';
import { publish } from '../../core/outbox/service';
import { getSetting, getSettingMeta } from '../../core/settings/service';
import { applyTransition, availableTransitions, getWorkflow, initWorkflow } from '../../core/workflow/engine';
import { User, type UserDoc } from '../../core/auth/model';
import { blindIndex, blindIndexCandidates, decrypt, encrypt } from '../../core/auth/crypto';
import { CalendarEvent } from '../../core/calendar/model';
import { Department, Position } from '../../core/org/model';
import { Attachment } from '../../core/files/model';
import { claimAttachments } from '../../core/files/service';
import { riyadhDate, riyadhDayEndOf } from '../../core/dates/businessDays';
import { withTransaction } from '../../db';
import { requisitionVisibility } from './h3b.visibility';
export { requisitionVisibility };
import { Contract, Employee, type EmployeeDoc } from './model';
import { Applicant, ApplicantEvent, Interview, JobRequisition, Offer, type ApplicantDoc, type JobRequisitionDoc, type OfferDoc } from './recruitment.model';
import { createContract, createEmployee, hrUserIds, ON_DUTY_STATUSES } from './service';
import { addDays } from './attendance.service';
import { ageOn, fixedTermExpiryOutcome, isSaudi, saudizationRatePct } from './legal.service';

/**
 * Recruitment [HR §3.2] — requisition → approval → posting → applicants → screening → interviews → offer → acceptance →
 * contracting (employee + contract + account from the offer, no retyping) → government registration by hand.
 * Legal rules: docs/HR_H3B_LEGAL.md T1–T14; owner decisions DECISIONS §22.
 */
const HR_ROLES = ['hr_officer', 'hr_manager'];
const DAY = 86_400_000;

export async function recruitmentPolicy(): Promise<{ policy: RecruitmentPolicy; provisional: boolean }> {
  const m = await getSettingMeta('hr.recruitment');
  return { policy: m.value, provisional: m.provisional };
}
const roleCodes = (u: UserDoc) => u.roles.map((r) => r.role);
const isHr = (u: UserDoc) => roleCodes(u).some((r) => HR_ROLES.includes(r));
const managesDepartment = (u: UserDoc, departmentId: unknown) => u.roles.some((r) => r.role === 'department_manager' && String(r.departmentId ?? u.departmentId ?? '') === String(departmentId));

async function reqEvent(type: string, data: Record<string, unknown>, actor: Actor, session?: ClientSession) {
  await publish({ type, aggregateType: 'hr_requisition', ...data, actorUserId: actor.userId } as never, session);
}
async function appEvent(applicantId: unknown, type: string, actor: Actor, data: Record<string, unknown> = {}, session?: ClientSession) {
  await ApplicantEvent.create([{ applicantId, type, actorUserId: actor.userId, actorEmail: actor.email, ...data }], { session });
}

// ==================================================================================================
// T3 — Saudization (arts. 26, 28; Nitaqat; DECISIONS §22 Q4): a warning, never a block
// ==================================================================================================
export async function saudizationStatus(): Promise<{ setting: SaudizationSetting; headcount: number; saudiCount: number; ratePct: number | null; below: boolean; warningAr: string | null }> {
  const setting = await getSetting('hr.saudization');
  const employees = await Employee.find({ deletedAt: null, status: { $in: [...ON_DUTY_STATUSES, 'suspended'] } }).select('nationality').lean();
  const saudiCount = employees.filter((e) => isSaudi(e.nationality)).length;
  const ratePct = saudizationRatePct(saudiCount, employees.length);
  const below = setting.requiredRatePct !== null && ratePct !== null && ratePct < setting.requiredRatePct;
  return {
    setting,
    headcount: employees.length,
    saudiCount,
    ratePct,
    below,
    warningAr: below ? `نسبة التوطين الحالية ${ratePct}% دون النسبة المطلوبة ${setting.requiredRatePct}% (قوى — ${setting.nitaqatBandAr ?? 'النطاق غير مسجَّل'})` : null,
  };
}
/** The rate if one more non-Saudi joins — the warning on a requisition / offer for a non-Saudi. */
export async function saudizationAfterHire(nonSaudiHires: number): Promise<string | null> {
  const s = await saudizationStatus();
  if (s.setting.requiredRatePct === null) return null;
  const after = saudizationRatePct(s.saudiCount, s.headcount + nonSaudiHires);
  if (after !== null && after < s.setting.requiredRatePct) return `بعد التعيين تهبط نسبة التوطين إلى ${after}% دون النسبة المطلوبة ${s.setting.requiredRatePct}% (المادة 26 / نطاقات) — تحذير فقط`;
  return null;
}

// ==================================================================================================
// Requisitions [HR §3.2.1–3.2.4; HR_PLAN §4.3]
// ==================================================================================================
export async function relationsForRequisition(user: UserDoc, r: JobRequisitionDoc, policy: RecruitmentPolicy): Promise<string[]> {
  const rel = new Set<string>(roleCodes(user));
  if (String(r.requestedBy) === String(user._id)) return ['requester'];
  if (managesDepartment(user, r.departmentId)) rel.add('department_manager');
  const approverRole = r.needsExecutive ? 'executive' : policy.requisitionApproverRole;
  if (roleCodes(user).includes(approverRole)) rel.add('approver');
  return [...rel];
}
export async function createRequisition(input: CreateRequisitionInput, user: UserDoc, actor: Actor): Promise<JobRequisitionDoc> {
  const { policy } = await recruitmentPolicy();
  if (!(await Department.exists({ _id: input.departmentId, deletedAt: null }))) throw badRequest('القسم غير موجود');
  const mayRaise = isHr(user) || (policy.requisitionRaisers.includes('department_manager') && managesDepartment(user, input.departmentId)) || policy.requisitionRaisers.some((x) => x !== 'department_manager' && roleCodes(user).includes(x));
  if (!mayRaise) throw forbidden('رفع طلب التوظيف من صلاحية مدير القسم المعني أو الموارد البشرية');
  if (input.positionId && !(await Position.exists({ _id: input.positionId, deletedAt: null }))) throw badRequest('المسمى الوظيفي غير موجود');
  if (input.contractType === 'fixed_term' && !input.durationMonths) throw badRequest('حدّد مدة العقد محدد المدة');
  const needsExecutive =
    (policy.executiveSalaryThresholdHalalas !== null && !!input.salaryRange && input.salaryRange.maxHalalas > policy.executiveSalaryThresholdHalalas) ||
    (policy.executiveHeadcountThreshold !== null && input.headcount >= policy.executiveHeadcountThreshold);
  const def = await getWorkflow('hr_requisition');
  const wf = await initWorkflow(def);
  const { draft, ...rest } = input;
  const r = await JobRequisition.create({ ...rest, number: await nextNumber('requisition'), requestedBy: user._id, needsExecutive, ...wf });
  await recordAudit(actor, { action: 'create', resource: 'hr.recruitment', resourceId: String(r._id), after: { number: r.number, departmentId: input.departmentId, headcount: input.headcount }, sensitive: !!input.salaryRange });
  if (!draft) return transitionRequisition(r, 'submit', { user, actor });
  return r;
}
export async function updateRequisition(r: JobRequisitionDoc, patch: Record<string, unknown>, user: UserDoc, actor: Actor) {
  if (!['draft', 'needs_completion'].includes(r.state)) throw badRequest('يُعدَّل الطلب وهو مسودة أو بحاجة إلى استكمال فقط');
  if (String(r.requestedBy) !== String(user._id) && !isHr(user)) throw forbidden();
  const before = r.toObject();
  Object.assign(r, patch);
  await r.save();
  await recordAudit(actor, { action: 'update', resource: 'hr.recruitment', resourceId: String(r._id), before: { titleAr: before.titleAr, headcount: before.headcount }, after: { titleAr: r.titleAr, headcount: r.headcount } });
  return r;
}
export async function availableRequisitionActions(user: UserDoc, r: JobRequisitionDoc) {
  const def = await getWorkflow('hr_requisition');
  const { policy } = await recruitmentPolicy();
  return availableTransitions(def, r.state, await relationsForRequisition(user, r, policy)).map((t) => t.code);
}
export async function transitionRequisition(r: JobRequisitionDoc, code: string, opts: { user: UserDoc; actor: Actor; reason?: string; posting?: { channels: string[]; closesAt?: string; externalRefs: { channel: string; reference: string }[] } }): Promise<JobRequisitionDoc> {
  const def = await getWorkflow('hr_requisition');
  const { policy } = await recruitmentPolicy();
  const rel = opts.actor.system ? ['system'] : await relationsForRequisition(opts.user, r, policy);
  if (['approve', 'reject', 'return'].includes(code) && String(r.requestedBy) === String(opts.user._id)) throw forbidden('لا يعتمد مقدّم الطلب طلبه (فصل المهام)');
  if (code === 'post') {
    if (!opts.posting?.channels.length) throw badRequest('حدّد قنوات الإعلان');
    const known = new Set(policy.postingChannels.map((c) => c.code));
    const unknown = opts.posting.channels.filter((c) => !known.has(c));
    if (unknown.length) throw badRequest('قناة إعلان غير معروفة', { unknown });
  }
  const fromState = r.state;
  const now = new Date();
  // T3: the Saudization warning is attached when the requisition is submitted (information for the approver).
  const saudizationWarning = code === 'submit' ? await saudizationAfterHire(r.headcount) : undefined;
  await withTransaction(async (session) => {
    await applyTransition({
      def,
      record: r.toObject() as never,
      recordType: 'hr_requisition',
      transition: code,
      actor: opts.actor,
      actorRelations: rel,
      reason: opts.reason,
      departmentId: String(r.departmentId),
      now,
      session,
      persist: async (fields) => {
        const set: Record<string, unknown> = { ...fields };
        if (code === 'approve') Object.assign(set, { approvedBy: opts.user._id, approvedAt: now });
        if (code === 'post') set.posting = { ...opts.posting, postedAt: now };
        if (saudizationWarning !== undefined) set.saudizationWarning = saudizationWarning;
        return (await JobRequisition.updateOne({ _id: r._id, state: fromState }, { $set: set }, { session })).modifiedCount === 1;
      },
    });
    await recordAudit(opts.actor, { action: 'transition', resource: 'hr.recruitment', resourceId: String(r._id), before: { state: fromState }, after: { state: def.transitions.find((t) => t.code === code)!.to }, meta: { transition: code, reason: opts.reason } }, session);
    await reqEvent(`hr.requisition.${code}`, { aggregateId: String(r._id), payload: { number: r.number, departmentId: String(r.departmentId), from: fromState } }, opts.actor, session);
  });
  const doc = (await JobRequisition.findById(r._id))!;
  // Notifications (HR_PLAN §4.3): approver on submit; requester on each decision; HR on approval; department manager when posted / closed.
  const approverRole = doc.needsExecutive ? 'executive' : policy.requisitionApproverRole;
  const approvers = (await User.find({ 'roles.role': approverRole, status: 'active' }).select('_id').lean()).map((u) => String(u._id)).filter((id) => id !== String(doc.requestedBy));
  const dept = await Department.findById(doc.departmentId).select('nameAr managerUserId').lean();
  const requester = [String(doc.requestedBy)];
  const manager = dept?.managerUserId ? [String(dept.managerUserId)] : [];
  if (code === 'submit') await notify({ userIds: approvers, type: 'requisition.submitted', bodyAr: `${doc.titleAr} (${doc.number}) — ${dept?.nameAr ?? ''} × ${doc.headcount}${doc.saudizationWarning ? ` — ${doc.saudizationWarning}` : ''}`, link: `/hr/recruitment/requisitions/${doc._id}` });
  if (['approve', 'reject', 'return'].includes(code)) {
    await notify({ userIds: requester, type: 'requisition.decided', bodyAr: `${doc.titleAr} (${doc.number}): ${def.states[doc.state].labelAr}${opts.reason ? ` — ${opts.reason}` : ''}`, link: `/hr/recruitment/requisitions/${doc._id}` });
    if (code === 'approve') await notify({ userIds: await hrUserIds(), type: 'requisition.decided', bodyAr: `اعتُمد طلب التوظيف ${doc.number} — ${doc.titleAr}؛ يلزم الإعلان عنه`, link: `/hr/recruitment/requisitions/${doc._id}` });
  }
  if (code === 'post') await notify({ userIds: [...new Set([...requester, ...manager])], type: 'requisition.posted', bodyAr: `${doc.titleAr} (${doc.number}) — القنوات: ${doc.posting?.channels.join('، ')}`, link: `/hr/recruitment/requisitions/${doc._id}` });
  if (code === 'close') await notify({ userIds: [...new Set([...requester, ...manager])], type: 'requisition.closed', bodyAr: `${doc.titleAr} (${doc.number}) — تم تعيين ${doc.hiredCount} من ${doc.headcount}`, link: `/hr/recruitment/requisitions/${doc._id}` });
  return doc;
}
/** Who sees which requisitions (HR_PLAN §6): HR all; department managers theirs; requesters their own; the executive all. */
/** Salary data is sensitive (HR_PLAN §6): department managers see the requisition without the range. */
export function redactRequisition(r: Record<string, unknown>, user: UserDoc) {
  if (isHr(user) || roleCodes(user).includes('executive')) return r;
  const { salaryRange, ...rest } = r;
  void salaryRange;
  return rest;
}

// ==================================================================================================
// Applicants [HR §3.2.5–3.2.6]: entry by hand, CSV import, screening, T1 rejection reasons, PDPL retention
// ==================================================================================================
export async function addApplicant(r: JobRequisitionDoc, input: CreateApplicantInput, actor: Actor, batchId?: string): Promise<ApplicantDoc> {
  if (!['approved', 'posted'].includes(r.state)) throw badRequest('تُسجَّل الطلبات على طلب توظيف معتمد أو معلن عنه');
  const dup = await Applicant.findOne({ requisitionId: r._id, deletedAt: null, $or: [{ phone: input.phone }, ...(input.email ? [{ email: input.email }] : [])] }).select('_id').lean();
  if (dup) throw conflict('مرشح بنفس الجوال أو البريد مسجَّل على هذا الطلب', { applicantId: String(dup._id) });
  // T8 (art. 54): a previous employee of the cooperative is recognised by the identity number.
  let previousEmployeeId: unknown;
  if (input.identityNumber) {
    const prev = await Employee.findOne({ 'identity.hash': { $in: blindIndexCandidates(input.identityNumber) } }).select('_id').lean();
    previousEmployeeId = prev?._id;
  }
  const { identityNumber, ...rest } = input;
  const a = await Applicant.create({
    ...rest,
    requisitionId: r._id,
    identityNumberEnc: identityNumber ? encrypt(identityNumber) : undefined,
    identityLast4: identityNumber?.slice(-4),
    previousEmployeeId,
    importedBatchId: batchId,
    createdBy: actor.userId,
  });
  if (input.cvAttachmentId) await claimAttachments([input.cvAttachmentId], 'applicant', String(a._id), actor.userId);
  await appEvent(a._id, 'created', actor, { toStage: 'new', data: { batchId } });
  await recordAudit(actor, { action: 'create', resource: 'hr.recruitment', resourceId: String(a._id), after: { requisitionId: String(r._id), fullNameAr: a.fullNameAr }, meta: { kind: 'applicant' }, sensitive: !!identityNumber });
  return a;
}
/** CSV import (DECISIONS §22 Q6): every valid row is created; the invalid ones are reported, nothing is half-done per row. */
export async function importApplicants(r: JobRequisitionDoc, rows: CreateApplicantInput[], actor: Actor) {
  const batchId = `${r.number}-${Date.now()}`;
  const created: string[] = [];
  const rejected: { row: number; error: string }[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      const a = await addApplicant(r, row, actor, batchId);
      created.push(String(a._id));
    } catch (e) {
      rejected.push({ row: i + 1, error: (e as Error).message });
    }
  }
  return { batchId, created: created.length, rejected };
}
export async function moveApplicant(a: ApplicantDoc, stage: ApplicantStage, opts: { actor: Actor; rejectionReason?: string; note?: string }): Promise<ApplicantDoc> {
  const { policy } = await recruitmentPolicy();
  const from = a.stage as ApplicantStage;
  if (!APPLICANT_STAGE_NEXT[from].includes(stage)) throw badRequest(`لا يمكن نقل المرشح من «${from}» إلى «${stage}»`, { code: 'bad_stage_move' });
  let retainUntil: Date | undefined;
  if (stage === 'rejected') {
    // T1 (art. 3): the reason comes from the professional list — never free text on a protected ground.
    if (!opts.rejectionReason || !policy.rejectionReasons.some((x) => x.code === opts.rejectionReason)) throw badRequest('سبب الرفض يُختار من القائمة المهنية المعتمدة (المادة 3: لا تمييز)', { code: 'rejection_reason_required' });
    if (opts.rejectionReason === 'other_professional' && !(opts.note ?? '').trim()) throw badRequest('اذكر السبب المهني الآخر');
  }
  if (stage === 'rejected' || stage === 'withdrawn') retainUntil = new Date(Date.now() + policy.cvRetentionMonths * 30.44 * DAY); // PDPL (Q10)
  const r = await Applicant.updateOne({ _id: a._id, stage: from }, { $set: { stage, rejectionReason: stage === 'rejected' ? opts.rejectionReason : a.rejectionReason, ...(retainUntil ? { retainUntil } : {}) } });
  if (!r.modifiedCount) throw conflict('تغيّرت مرحلة المرشح من مستخدم آخر');
  await appEvent(a._id, 'stage', opts.actor, { fromStage: from, toStage: stage, note: opts.note, data: { rejectionReason: opts.rejectionReason } });
  await recordAudit(opts.actor, { action: 'update', resource: 'hr.recruitment', resourceId: String(a._id), before: { stage: from }, after: { stage }, meta: { kind: 'applicant', rejectionReason: opts.rejectionReason } });
  return (await Applicant.findById(a._id))!;
}
export async function addApplicantNote(a: ApplicantDoc, note: string, actor: Actor) {
  await appEvent(a._id, 'note', actor, { note });
}
export function serializeApplicant(a: ApplicantDoc | Record<string, unknown>, user: UserDoc) {
  const o = 'toObject' in a && typeof a.toObject === 'function' ? (a.toObject() as Record<string, unknown>) : { ...(a as Record<string, unknown>) };
  delete o.identityNumberEnc;
  if (!isHr(user)) delete o.expectedSalaryHalalas;
  return o;
}
/** PDPL (Q10): purge the CVs of rejected / withdrawn applicants after the retention period. Daily. */
export async function runCvRetention(now = new Date()): Promise<number> {
  const due = await Applicant.find({ retainUntil: { $ne: null, $lte: now }, cvPurgedAt: null, cvAttachmentId: { $ne: null } }).select('cvAttachmentId').lean();
  let purged = 0;
  for (const a of due) {
    await Attachment.updateOne({ _id: a.cvAttachmentId }, { $set: { deletedAt: now } });
    await Applicant.updateOne({ _id: a._id }, { $set: { cvPurgedAt: now }, $unset: { cvAttachmentId: 1, identityNumberEnc: 1 } });
    await recordAudit(SYSTEM_ACTOR, { action: 'delete', resource: 'hr.recruitment', resourceId: String(a._id), meta: { job: 'hr.recruitment.cv_retention', attachmentId: String(a.cvAttachmentId) } });
    purged++;
  }
  return purged;
}

// ==================================================================================================
// Interviews [HR §3.2.6]: on the shared calendar, scored on the policy's criteria (Q10)
// ==================================================================================================
export async function scheduleInterview(a: ApplicantDoc, input: { round: number; scheduledAt: Date; durationMinutes: number; mode: string; location?: string; panelUserIds: string[]; notes?: string }, user: UserDoc, actor: Actor) {
  if (!['shortlisted', 'interviewing', 'screened'].includes(a.stage)) throw badRequest('تُجدول المقابلة لمرشح في القائمة المختصرة');
  if (await Interview.exists({ applicantId: a._id, round: input.round, state: 'scheduled' })) throw conflict('توجد مقابلة مجدولة لهذه الجولة');
  const r = await JobRequisition.findById(a.requisitionId).select('number titleAr departmentId').lean();
  const endAt = new Date(input.scheduledAt.getTime() + input.durationMinutes * 60_000);
  const ev = await CalendarEvent.create({
    number: await nextNumber('event'),
    title: `مقابلة توظيف: ${a.fullNameAr} — ${r?.titleAr ?? ''} (الجولة ${input.round})`,
    type: 'interview',
    status: 'scheduled',
    startAt: input.scheduledAt,
    endAt,
    location: input.location,
    description: input.notes,
    ownerId: user._id,
    participantIds: input.panelUserIds,
    departmentIds: r?.departmentId ? [r.departmentId] : [],
    link: { type: 'applicant', id: String(a._id), label: r?.number },
  });
  const iv = await Interview.create({ ...input, applicantId: a._id, requisitionId: a.requisitionId, calendarEventId: ev._id, createdBy: user._id });
  if (a.stage !== 'interviewing') await moveApplicant(a, 'interviewing', { actor, note: `جولة ${input.round}` });
  await appEvent(a._id, 'interview_scheduled', actor, { data: { interviewId: String(iv._id), round: input.round, scheduledAt: input.scheduledAt } });
  await notify({ userIds: input.panelUserIds, type: 'interview.scheduled', bodyAr: `${a.fullNameAr} — ${r?.titleAr ?? ''} الجولة ${input.round} في ${input.scheduledAt.toISOString().slice(0, 16).replace('T', ' ')}`, link: `/hr/recruitment/requisitions/${a.requisitionId}` });
  return iv;
}
export async function recordInterviewResult(iv: InstanceType<typeof Interview>, input: { state: 'done' | 'no_show' | 'cancelled'; scores: { criterion: string; value: number }[]; recommendation?: string; notes?: string }, user: UserDoc, actor: Actor) {
  if (iv.state !== 'scheduled') throw badRequest('سُجِّلت نتيجة هذه المقابلة من قبل');
  const { policy } = await recruitmentPolicy();
  const criteria = new Set(policy.interviewCriteria.map((c) => c.code));
  for (const s of input.scores) {
    if (!criteria.has(s.criterion)) throw badRequest(`معيار غير معروف: ${s.criterion}`);
    if (s.value < policy.scoreMin || s.value > policy.scoreMax) throw badRequest(`الدرجة بين ${policy.scoreMin} و${policy.scoreMax}`);
  }
  // T1: the panel scores the policy's professional criteria only — no other axis is stored.
  const total = input.scores.length ? Math.round((input.scores.reduce((s, x) => s + x.value, 0) / input.scores.length) * 100) / 100 : undefined;
  Object.assign(iv, { state: input.state, scores: input.scores, totalScore: total, recommendation: input.recommendation, notes: input.notes, resultBy: user._id, resultAt: new Date() });
  await iv.save();
  if (iv.calendarEventId) await CalendarEvent.updateOne({ _id: iv.calendarEventId }, { $set: { status: input.state === 'done' ? 'done' : input.state === 'no_show' ? 'not_done' : 'cancelled', outcome: input.notes } });
  await appEvent(iv.applicantId, 'interview_result', actor, { data: { interviewId: String(iv._id), state: input.state, totalScore: total, recommendation: input.recommendation } });
  await recordAudit(actor, { action: 'update', resource: 'hr.recruitment', resourceId: String(iv._id), after: { state: input.state, totalScore: total }, meta: { kind: 'interview' } });
  return iv;
}

// ==================================================================================================
// Offers [HR §3.2.7–3.2.10; HR_PLAN §4.4] — T2, T3, T5, T6, T7, T9, E9, E13 at creation; the hire creates the file
// ==================================================================================================
export async function relationsForOffer(user: UserDoc, o: OfferDoc, policy: RecruitmentPolicy): Promise<string[]> {
  const rel = new Set<string>(roleCodes(user));
  if (String(o.createdBy) === String(user._id)) rel.add('creator');
  const approverRole = o.needsExecutive ? 'executive' : policy.offerApproverRole;
  if (roleCodes(user).includes(approverRole) && String(o.createdBy) !== String(user._id)) rel.add('approver');
  return [...rel];
}
export async function createOffer(input: CreateOfferInput, user: UserDoc, actor: Actor): Promise<OfferDoc> {
  const { policy } = await recruitmentPolicy();
  const a = await Applicant.findOne({ _id: input.applicantId, deletedAt: null });
  if (!a) throw notFound('المرشح غير موجود');
  if (!['shortlisted', 'interviewing'].includes(a.stage)) throw badRequest('يُقدَّم العرض لمرشح في القائمة المختصرة أو بعد المقابلات');
  if (await Offer.exists({ applicantId: a._id, state: { $nin: ['declined', 'expired', 'withdrawn'] } })) throw conflict('يوجد عرض قائم لهذا المرشح');
  const r = await JobRequisition.findById(a.requisitionId);
  if (!r || !['approved', 'posted'].includes(r.state)) throw badRequest('طلب التوظيف ليس معتمداً');
  if (r.hiredCount >= r.headcount) throw badRequest('اكتمل عدد التعيينات المطلوب في هذا الطلب');
  const flags: string[] = [];
  const saudi = isSaudi(a.nationality);
  // T2 (arts. 162–163): no hire under the minimum age; a warning under 18 (no hazardous work).
  if (a.birthDate) {
    const age = ageOn(a.birthDate, input.startDate);
    if (age < policy.minimumHireAge) throw badRequest(`لا يجوز توظيف من دون ${policy.minimumHireAge} سنة (المادة 162)`, { code: 'under_minimum_age' });
    if (age < policy.juvenileWarningBelowAge) flags.push('juvenile');
  } else flags.push('birth_date_missing');
  // T6 (art. 37): a non-Saudi's contract is written and fixed-term; the permit period fills a missing duration.
  if (!saudi) {
    if (input.contractType === 'open_ended') throw badRequest('عقد غير السعودي يكون محدد المدة (المادة 37)', { code: 'non_saudi_open_ended' });
    if (!input.durationMonths && input.contractType !== 'specific_work') {
      if (input.workPermit?.expiryDate) flags.push('duration_from_work_permit');
      else throw badRequest('حدّد مدة العقد أو تاريخ انتهاء رخصة العمل لغير السعودي (المادة 37)', { code: 'non_saudi_duration_required' });
    }
    if (!input.workPermit?.number) flags.push('work_permit_missing'); // T4: الرخصة حقل على الملف، تحذير قبل التعاقد
    const w = await saudizationAfterHire(1); // T3
    if (w) flags.push('saudization_below');
  }
  if (input.contractType === 'fixed_term' && !input.durationMonths && !input.workPermit?.expiryDate) throw badRequest('حدّد مدة العقد محدد المدة');
  if (input.contractType === 'specific_work' && !input.workDescription) throw badRequest('عقد العمل المعيّن يصف العمل (المادة 57)', { code: 'work_description_required' });
  // T7 (art. 53): ≤ 180 days (policy maximum).
  if (input.probationDays > policy.maxProbationDays) throw badRequest(`فترة التجربة لا تتجاوز ${policy.maxProbationDays} يوماً (المادة 53)`, { code: 'probation_over_max' });
  // T9: a renewal clause needs its period.
  if (input.renewalClause.enabled && !input.renewalClause.periodMonths) throw badRequest('حدّد مدة التجديد في شرط التجديد (المادة 55)');
  // E13 (art. 86): excluding commissions needs the clause reference.
  if (input.awardExcludesVariableWage && !input.awardExclusionClauseRef?.trim()) throw badRequest('استثناء العمولات من أجر المكافأة يكون بنص صريح في العقد — أدخل مرجع البند (المادة 86)', { code: 'exclusion_clause_required' });
  if (input.validUntil < riyadhDate(new Date())) throw badRequest('تاريخ صلاحية العرض في الماضي');
  // Q10: the executive approves above the requisition's salary range.
  const total = input.basicSalaryHalalas + input.allowances.reduce((s, x) => s + x.amountHalalas, 0);
  const needsExecutive = (!!r.salaryRange?.maxHalalas && total > r.salaryRange.maxHalalas) || (policy.executiveSalaryThresholdHalalas !== null && total > policy.executiveSalaryThresholdHalalas);
  if (needsExecutive) flags.push('above_salary_range');
  const def = await getWorkflow('hr_offer');
  const wf = await initWorkflow(def);
  const o = await Offer.create({ ...input, number: await nextNumber('offer'), requisitionId: r._id, departmentId: r.departmentId, positionId: input.positionId ?? r.positionId, needsExecutive, flags, createdBy: user._id, ...wf });
  await Applicant.updateOne({ _id: a._id }, { $set: { stage: 'offered' } }); // offered is reached only through an offer, never by drag (APPLICANT_STAGE_NEXT)
  await appEvent(a._id, 'stage', actor, { fromStage: a.stage, toStage: 'offered', note: o.number });
  await appEvent(a._id, 'offer_created', actor, { data: { offerId: String(o._id), number: o.number } });
  await recordAudit(actor, { action: 'create', resource: 'hr.offers', resourceId: String(o._id), after: { number: o.number, applicantId: String(a._id) }, sensitive: true });
  return o;
}
export async function availableOfferActions(user: UserDoc, o: OfferDoc) {
  const def = await getWorkflow('hr_offer');
  const { policy } = await recruitmentPolicy();
  return availableTransitions(def, o.state, await relationsForOffer(user, o, policy)).map((t) => t.code).filter((c) => c !== 'expire');
}
export interface OfferTransitionOpts {
  user: UserDoc;
  actor: Actor;
  reason?: string;
  acceptedAt?: string;
  signedAttachmentId?: string;
  hire?: {
    workEmail: string;
    identity: { type: 'national_id' | 'iqama' | 'passport' | 'other'; number: string; expiryDate?: string };
    gender: 'male' | 'female';
    birthDate?: string;
    mobile?: string;
    bank?: { bankName: string; iban: string };
    medicalInsurancePolicy?: { number?: string; expiryDate?: string };
    createAccount: boolean;
    contractAttachmentId?: string;
    differentProfession?: boolean;
  };
  gov?: { qiwaRef?: string; qiwaAt?: string; gosiRef?: string; gosiAt?: string };
}
export async function transitionOffer(o: OfferDoc, code: string, opts: OfferTransitionOpts): Promise<OfferDoc & { temporaryPassword?: string }> {
  const def = await getWorkflow('hr_offer');
  const { policy } = await recruitmentPolicy();
  const rel = opts.actor.system ? ['system'] : await relationsForOffer(opts.user, o, policy);
  if (code === 'record_gov_registration') return recordGovRegistration(o, opts);
  if (code === 'accept' && !opts.acceptedAt) throw badRequest('حدّد تاريخ قبول المرشح');
  if (code === 'contract' && !opts.hire) throw badRequest('بيانات التعاقد مطلوبة (البريد الوظيفي، الهوية، الجنس)');
  const fromState = o.state;
  const now = new Date();
  let temporaryPassword: string | undefined;
  let hired: { employeeId: unknown; contractId: unknown } | null = null;
  if (code === 'contract') {
    const h = await hireFromOffer(o, opts.hire!, opts.user, opts.actor);
    hired = { employeeId: h.employee._id, contractId: h.contract._id };
    temporaryPassword = h.temporaryPassword;
  }
  await withTransaction(async (session) => {
    await applyTransition({
      def,
      record: o.toObject() as never,
      recordType: 'hr_offer',
      transition: code,
      actor: opts.actor,
      actorRelations: rel,
      reason: opts.reason,
      departmentId: String(o.departmentId),
      now,
      session,
      persist: async (fields) => {
        const set: Record<string, unknown> = { ...fields };
        if (code === 'approve') Object.assign(set, { approvedBy: opts.user._id, approvedAt: now });
        if (code === 'send') set.sentAt = now;
        if (code === 'accept') set.response = { at: riyadhDayEndOf(opts.acceptedAt!), accepted: true, signedAttachmentId: opts.signedAttachmentId };
        if (code === 'decline') set.response = { at: now, accepted: false, note: opts.reason };
        if (hired) Object.assign(set, { createdEmployeeId: hired.employeeId, createdContractId: hired.contractId });
        return (await Offer.updateOne({ _id: o._id, state: fromState }, { $set: set }, { session })).modifiedCount === 1;
      },
    });
    if (code === 'accept' && opts.signedAttachmentId) await claimAttachments([opts.signedAttachmentId], 'offer', String(o._id), opts.user._id, session);
    if (code === 'decline' || code === 'withdraw' || code === 'expire') {
      const retainUntil = new Date(now.getTime() + policy.cvRetentionMonths * 30.44 * DAY);
      await Applicant.updateOne({ _id: o.applicantId, stage: 'offered' }, { $set: { stage: code === 'decline' ? 'withdrawn' : 'shortlisted', ...(code === 'decline' ? { retainUntil } : {}) } }, { session });
    }
    if (hired) {
      await Applicant.updateOne({ _id: o.applicantId }, { $set: { stage: 'hired', linkedEmployeeId: hired.employeeId } }, { session });
      await JobRequisition.updateOne({ _id: o.requisitionId }, { $inc: { hiredCount: 1 } }, { session });
    }
    await ApplicantEvent.create([{ applicantId: o.applicantId, type: `offer_${code}`, actorUserId: opts.actor.userId, actorEmail: opts.actor.email, note: opts.reason, data: { offerId: String(o._id) } }], { session });
    await recordAudit(opts.actor, { action: 'transition', resource: 'hr.offers', resourceId: String(o._id), before: { state: fromState }, after: { state: def.transitions.find((t) => t.code === code)!.to }, meta: { transition: code }, sensitive: true }, session);
    await publish({ type: `hr.offer.${code}`, aggregateType: 'hr_offer', aggregateId: String(o._id), payload: { number: o.number, applicantId: String(o.applicantId), requisitionId: String(o.requisitionId), employeeId: hired ? String(hired.employeeId) : undefined }, actorUserId: opts.actor.userId }, session);
    if (hired) await publish({ type: 'hr.employee.hired', aggregateType: 'employee', aggregateId: String(hired.employeeId), payload: { offerId: String(o._id), requisitionId: String(o.requisitionId) }, actorUserId: opts.actor.userId }, session);
  });
  const doc = (await Offer.findById(o._id))!;
  // Requisition auto-close when the headcount is reached (HR_PLAN §4.3 «close when hired count reached»).
  if (hired) {
    const r = await JobRequisition.findById(o.requisitionId);
    if (r && r.hiredCount >= r.headcount && ['approved', 'posted'].includes(r.state)) await transitionRequisition(r, 'close', { user: opts.user, actor: SYSTEM_ACTOR, reason: 'اكتمل عدد التعيينات' });
  }
  const a = await Applicant.findById(o.applicantId).select('fullNameAr').lean();
  const approverRole = doc.needsExecutive ? 'executive' : policy.offerApproverRole;
  if (code === 'submit') {
    const approvers = (await User.find({ 'roles.role': approverRole, status: 'active' }).select('_id').lean()).map((u) => String(u._id)).filter((id) => id !== String(doc.createdBy));
    await notify({ userIds: approvers, type: 'offer.pending', bodyAr: `${a?.fullNameAr ?? ''} — ${doc.number}${doc.flags.includes('saudization_below') ? ' — تحذير نسبة التوطين' : ''}${doc.flags.includes('above_salary_range') ? ' — فوق نطاق الراتب' : ''}`, link: `/hr/recruitment/offers/${doc._id}` });
  }
  if (code === 'accept') await notify({ userIds: await hrUserIds(), type: 'offer.accepted', bodyAr: `${a?.fullNameAr ?? ''} قبل العرض ${doc.number} — يلزم استكمال التعاقد قبل ${doc.startDate}`, link: `/hr/recruitment/offers/${doc._id}` });
  if (code === 'decline') await notify({ userIds: [String(doc.createdBy)], type: 'offer.declined', bodyAr: `${a?.fullNameAr ?? ''} رفض العرض ${doc.number}: ${opts.reason ?? ''}`, link: `/hr/recruitment/offers/${doc._id}` });
  if (hired) {
    const emp = await Employee.findById(hired.employeeId).select('fullNameAr directManagerId').lean();
    const mgr = emp?.directManagerId ? await Employee.findById(emp.directManagerId).select('userId').lean() : null;
    if (mgr?.userId) await notify({ userIds: [String(mgr.userId)], type: 'employee.hired', bodyAr: `${emp?.fullNameAr ?? ''} يباشر العمل في ${doc.startDate}`, link: `/hr/employees/${hired.employeeId}` });
  }
  return Object.assign(doc, temporaryPassword ? { temporaryPassword } : {});
}
/**
 * «استكمال إجراءات التعاقد» (HR §3.2.9; golden rule 2): the employee file, the contract and the portal account are
 * created from the offer and the applicant — nothing retyped. T5 fields are enforced; T7 / T8 run in `createContract`.
 */
async function hireFromOffer(o: OfferDoc, hire: NonNullable<OfferTransitionOpts['hire']>, user: UserDoc, actor: Actor) {
  const a = await Applicant.findById(o.applicantId);
  if (!a) throw notFound('المرشح غير موجود');
  const r = await JobRequisition.findById(o.requisitionId).select('positionId departmentId').lean();
  const parts = a.fullNameAr.trim().split(/\s+/);
  const birthDate = hire.birthDate ?? a.birthDate;
  const { employee, temporaryPassword } = await createEmployee(
    {
      firstNameAr: parts[0],
      lastNameAr: parts.slice(1).join(' ') || parts[0],
      fullNameAr: a.fullNameAr,
      gender: hire.gender,
      birthDate: birthDate ? new Date(`${birthDate}T00:00:00+03:00`) : undefined,
      nationality: a.nationality,
      identity: { type: hire.identity.type, number: hire.identity.number, expiryDate: hire.identity.expiryDate ? new Date(`${hire.identity.expiryDate}T00:00:00+03:00`) : undefined },
      workEmail: hire.workEmail,
      mobile: hire.mobile ?? a.phone,
      departmentId: String(o.departmentId),
      positionId: o.positionId ? String(o.positionId) : r?.positionId ? String(r.positionId) : undefined,
      branchId: o.branchId ? String(o.branchId) : undefined,
      siteId: o.siteId ? String(o.siteId) : undefined,
      directManagerId: o.directManagerId ? String(o.directManagerId) : undefined,
      employmentType: o.employmentType as never,
      hireDate: new Date(`${o.startDate}T00:00:00+03:00`),
      status: 'active',
      basicSalaryHalalas: o.basicSalaryHalalas,
      allowances: o.allowances.map((x) => ({ type: x.type ?? 'أخرى', amountHalalas: x.amountHalalas ?? 0 })),
      bank: hire.bank,
      medicalInsurance: !!hire.medicalInsurancePolicy,
      medicalInsurancePolicy: hire.medicalInsurancePolicy ? { number: hire.medicalInsurancePolicy.number, expiryDate: hire.medicalInsurancePolicy.expiryDate ? new Date(`${hire.medicalInsurancePolicy.expiryDate}T00:00:00+03:00`) : undefined } : undefined,
      workPermit: o.workPermit?.number || o.workPermit?.expiryDate ? { number: o.workPermit.number ?? undefined, professionAr: o.workPermit.professionAr ?? undefined, expiryDate: o.workPermit.expiryDate ? new Date(`${o.workPermit.expiryDate}T00:00:00+03:00`) : undefined } : undefined,
      createAccount: hire.createAccount,
    } as never,
    actor,
  );
  try {
    const contract = await createContract(
      employee,
      {
        type: o.contractType,
        startDate: new Date(`${o.startDate}T00:00:00+03:00`),
        durationMonths: o.durationMonths ?? undefined,
        probationDays: o.probationDays ?? 0,
        attachmentId: hire.contractAttachmentId,
        wagePeriod: (o.wagePeriod as 'monthly' | 'non_monthly') ?? 'monthly',
        renewalClause: o.renewalClause?.enabled ? { enabled: true, periodMonths: o.renewalClause.periodMonths ?? undefined } : { enabled: false },
        workDescription: o.workDescription ?? undefined,
        awardExcludesVariableWage: !!o.awardExcludesVariableWage,
        awardExclusionClauseRef: o.awardExclusionClauseRef ?? undefined,
        nonCompete: o.nonCompete?.months ? { months: o.nonCompete.months, scopeAr: o.nonCompete.scopeAr ?? '' } : undefined,
        differentProfession: hire.differentProfession,
        notes: `من العرض ${o.number}`,
      },
      actor,
    );
    void user;
    return { employee, contract, temporaryPassword };
  } catch (e) {
    // The contract refused (T6 / T7 / T8): the file created a moment ago is withdrawn so nothing half-hired remains.
    await Employee.updateOne({ _id: employee._id }, { $set: { deletedAt: new Date() } });
    if (employee.userId) await User.updateOne({ _id: employee.userId }, { $set: { status: 'disabled', disabledReason: 'hire_rolled_back' } });
    throw e;
  }
}
/** T13 (by hand until phase 7): Qiwa / GOSI references with dates. */
async function recordGovRegistration(o: OfferDoc, opts: OfferTransitionOpts): Promise<OfferDoc> {
  if (!['contracted', 'onboarded'].includes(o.state)) throw badRequest('يُسجَّل التوثيق بعد التعاقد');
  if (!opts.gov || (!opts.gov.qiwaRef && !opts.gov.gosiRef)) throw badRequest('أدخل مرجع قوى أو التأمينات');
  const before = (o.govRegistration as unknown as { toObject?: () => Record<string, unknown> } | undefined)?.toObject?.() ?? o.govRegistration;
  o.govRegistration = { ...(o.govRegistration ?? {}), ...opts.gov, recordedBy: opts.user._id, at: new Date() } as never;
  await o.save();
  if (o.createdEmployeeId && opts.gov.gosiAt) await Employee.updateOne({ _id: o.createdEmployeeId, gosiJoinDate: null }, { $set: { gosiJoinDate: new Date(`${opts.gov.gosiAt}T00:00:00+03:00`) } });
  await recordAudit(opts.actor, { action: 'update', resource: 'hr.offers', resourceId: String(o._id), before: { govRegistration: before }, after: { govRegistration: o.govRegistration }, meta: { kind: 'gov_registration' } });
  return o;
}

// ==================================================================================================
// T9 path (a) — HR confirms «استمر الطرفان» after a lapsed fixed term with no renewal clause (art. 55, art. 37)
// ==================================================================================================
export async function continueFixedTermContract(employee: EmployeeDoc, c: InstanceType<typeof Contract>, actor: Actor) {
  if (c.type !== 'fixed_term' || !c.endDate) throw badRequest('هذا الإجراء لعقد محدد المدة منقضٍ');
  if (c.status !== 'expired') throw badRequest('العقد لم ينقضِ بعد');
  if (c.renewalClause?.enabled) throw badRequest('هذا العقد له شرط تجديد؛ التجديد يجري آلياً (المادة 55)');
  if (!(ON_DUTY_STATUSES as readonly string[]).includes(employee.status)) throw badRequest('الموظف ليس على رأس العمل — لا يُعد العقد مستمراً');
  const saudi = isSaudi(employee.nationality);
  const startDate = new Date(c.endDate.getTime() + DAY);
  const next = saudi
    ? await createContract(employee, { type: 'open_ended', startDate, wagePeriod: c.wagePeriod as never, awardExcludesVariableWage: c.awardExcludesVariableWage, awardExclusionClauseRef: c.awardExclusionClauseRef ?? undefined, notes: 'تحوّل إلى غير محدد المدة: استمر الطرفان بعد انقضاء المدة بلا شرط تجديد (المادة 55)' }, actor, { renewalOf: c, convertedReason: 'art55_continued_no_clause' })
    : await createContract(employee, { type: 'fixed_term', startDate, endDate: employee.workPermit?.expiryDate ?? undefined, durationMonths: employee.workPermit?.expiryDate ? undefined : c.durationMonths ?? 12, wagePeriod: c.wagePeriod as never, awardExcludesVariableWage: c.awardExcludesVariableWage, awardExclusionClauseRef: c.awardExclusionClauseRef ?? undefined, notes: 'تجديد بمدة رخصة العمل: استمر الطرفان بعد انقضاء المدة (المادتان 55 و37)' }, actor, { renewalOf: c });
  await Contract.updateOne({ _id: c._id }, { $set: { 'continuationDecision.decidedAt': new Date(), 'continuationDecision.decidedBy': actor.userId, 'continuationDecision.outcome': saudi ? 'converted_indefinite' : 'renewed_permit_period' } });
  return next;
}
/**
 * Daily (T9): lapsed fixed-term contracts. Path (b) renews for the clause period (and converts a Saudi's contract after
 * 3 renewals or 4 years); path (a) flags the contract for HR's continuation decision when the employee is still on duty.
 */
export async function runFixedTermExpiry(now = new Date()): Promise<{ renewed: number; converted: number; flagged: number }> {
  const out = { renewed: 0, converted: 0, flagged: 0 };
  const lapsed = await Contract.find({ type: 'fixed_term', status: 'expired', statusReason: 'end_date_passed', endDate: { $ne: null, $lt: now }, 'continuationDecision.neededSince': null, convertedReason: null });
  for (const c of lapsed) {
    if (await Contract.exists({ previousId: c._id })) continue; // a later row already follows it
    const employee = await Employee.findOne({ _id: c.employeeId, deletedAt: null });
    if (!employee || !(ON_DUTY_STATUSES as readonly string[]).includes(employee.status)) continue;
    const saudi = isSaudi(employee.nationality);
    const outcome = fixedTermExpiryOutcome(c, saudi);
    const startDate = new Date(c.endDate!.getTime() + DAY);
    if (outcome.kind === 'renew') {
      const next = await createContract(employee, { type: 'fixed_term', startDate, durationMonths: outcome.periodMonths, wagePeriod: c.wagePeriod as never, renewalClause: { enabled: true, periodMonths: outcome.periodMonths }, awardExcludesVariableWage: c.awardExcludesVariableWage, awardExclusionClauseRef: c.awardExclusionClauseRef ?? undefined, notes: `تجديد آلي بشرط التجديد (المادة 55) — التجديد رقم ${(c.renewalCount ?? 0) + 1}` }, SYSTEM_ACTOR, { renewalOf: c });
      out.renewed++;
      if (outcome.convertAfter) await Contract.updateOne({ _id: next._id }, { $set: { notes: `${next.notes ?? ''} — عند انقضائه يتحوّل إلى غير محدد المدة (3 تجديدات أو 4 سنوات)` } });
    } else if (outcome.kind === 'convert_indefinite') {
      await createContract(employee, { type: 'open_ended', startDate, wagePeriod: c.wagePeriod as never, awardExcludesVariableWage: c.awardExcludesVariableWage, awardExclusionClauseRef: c.awardExclusionClauseRef ?? undefined, notes: 'تحوّل إلى غير محدد المدة: ثلاثة تجديدات متتالية أو أربع سنوات، أيهما أقل (المادة 55)' }, SYSTEM_ACTOR, { renewalOf: c, convertedReason: 'art55_three_renewals_or_four_years' });
      out.converted++;
    } else {
      await Contract.updateOne({ _id: c._id }, { $set: { 'continuationDecision.neededSince': now } });
      await notify({ userIds: await hrUserIds(), type: 'contract.continuation_needed', bodyAr: `${employee.fullNameAr} — العقد ${c.number} انقضى في ${riyadhDate(c.endDate!)} بلا شرط تجديد والموظف على رأس العمل: ${saudi ? 'يتحوّل إلى غير محدد المدة (المادة 55)' : 'يتجدد بمدة رخصة العمل (المادة 37)'} — أكّد الاستمرار`, link: `/hr/employees/${employee._id}` });
      out.flagged++;
    }
  }
  return out;
}

// ==================================================================================================
// Jobs: offer expiry, onboarding, government-registration deadlines (T13)
// ==================================================================================================
export async function runRecruitmentJobs(now = new Date()): Promise<{ expired: number; onboarded: number; govOverdue: number; cvPurged: number }> {
  const today = riyadhDate(now);
  const out = { expired: 0, onboarded: 0, govOverdue: 0, cvPurged: 0 };
  const sys = await User.findOne({ 'roles.role': 'system_admin' }).select('_id roles').lean();
  const systemUser = (sys ?? { _id: undefined, roles: [] }) as unknown as UserDoc;
  for (const o of await Offer.find({ state: 'sent', validUntil: { $lt: today } })) {
    await transitionOffer(o, 'expire', { user: systemUser, actor: SYSTEM_ACTOR, reason: 'انتهت صلاحية العرض' });
    out.expired++;
  }
  for (const o of await Offer.find({ state: 'contracted', startDate: { $lte: today } })) {
    await transitionOffer(o, 'onboard', { user: systemUser, actor: SYSTEM_ACTOR });
    out.onboarded++;
  }
  const gov = await getSetting('hr.gov');
  if (gov.qiwaContractDays !== null || gov.gosiRegisterDays !== null) {
    const hr = await hrUserIds();
    for (const o of await Offer.find({ state: { $in: ['contracted', 'onboarded'] }, govOverdueNotifiedAt: null, startDate: { $lte: today } })) {
      const missing: string[] = [];
      if (gov.qiwaContractDays !== null && !o.govRegistration?.qiwaRef && addDays(o.startDate, gov.qiwaContractDays) < today) missing.push('توثيق العقد في قوى');
      if (gov.gosiRegisterDays !== null && !o.govRegistration?.gosiRef && addDays(o.startDate, gov.gosiRegisterDays) < today) missing.push('التسجيل في التأمينات الاجتماعية');
      if (!missing.length) continue;
      const a = await Applicant.findById(o.applicantId).select('fullNameAr').lean();
      await notify({ userIds: hr, type: 'gov.registration_overdue', bodyAr: `${a?.fullNameAr ?? ''} (${o.number}) — تأخر: ${missing.join('، ')}`, link: `/hr/recruitment/offers/${o._id}` });
      o.govOverdueNotifiedAt = now;
      await o.save();
      out.govOverdue++;
    }
  }
  out.cvPurged = await runCvRetention(now);
  return out;
}
/** The identity number of an applicant for an HR user (audited by the route). */
export function applicantIdentity(a: ApplicantDoc): string | null {
  return a.identityNumberEnc ? decrypt(a.identityNumberEnc) : null;
}
export const applicantIdentityHash = (n: string) => blindIndex(n);
