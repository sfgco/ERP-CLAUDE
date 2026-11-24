import type { CreateTrainingInput } from '@eayni/shared';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors';
import type { Actor } from '../../core/http/context';
import { recordAudit } from '../../core/audit/service';
import { nextNumber } from '../../core/numbering/service';
import { notify } from '../../core/notifications/service';
import { publish } from '../../core/outbox/service';
import { getSetting } from '../../core/settings/service';
import { riyadhDate } from '../../core/dates/businessDays';
import { CalendarEvent } from '../../core/calendar/model';
import { Task } from '../../core/tasks/model';
import { User, type UserDoc } from '../../core/auth/model';
import { Employee } from './model';
import { hrUserIds } from './service';
import { Training, TrainingNeed, TrainingParticipant, TrainingPlan, type TrainingDoc } from './training.model';

const HR_ROLES = ['hr_officer', 'hr_manager'];
const isHr = (user: UserDoc) => user.roles.some((r) => HR_ROLES.includes(r.role));

// ---------- the annual plan [HR §3.8.1] ----------
export async function savePlan(year: number, items: unknown[], notes: string | undefined, actor: Actor) {
  let plan = await TrainingPlan.findOne({ year });
  if (plan && !['draft', 'submitted'].includes(plan.state)) throw badRequest('الخطة معتمدة؛ أنشئ خطة السنة التالية أو أعدها للمسودة');
  if (!plan) plan = await TrainingPlan.create({ year, items, notes, state: 'draft' });
  else {
    plan.items = items as never;
    plan.notes = notes;
    plan.version += 1;
    await plan.save();
  }
  await recordAudit(actor, { action: plan.version === 1 ? 'create' : 'update', resource: 'hr.training', resourceId: String(plan._id), after: { year, items: items.length, version: plan.version } });
  return plan;
}
export async function transitionPlan(plan: InstanceType<typeof TrainingPlan>, code: 'submit' | 'approve' | 'return' | 'close', user: UserDoc, actor: Actor, reason?: string) {
  const policy = await getSetting('hr.training');
  const roles = user.roles.map((r) => r.role);
  const from = plan.state;
  if (code === 'submit') {
    if (plan.state !== 'draft') throw badRequest('الخطة ليست مسودة');
    if (!isHr(user)) throw forbidden('رفع الخطة من صلاحية الموارد البشرية');
    Object.assign(plan, { state: 'submitted', submittedBy: user._id, submittedAt: new Date() });
  } else if (code === 'approve') {
    if (plan.state !== 'submitted') throw badRequest('الخطة ليست بانتظار الاعتماد');
    if (!roles.includes(policy.planApproverRole)) throw forbidden('اعتماد الخطة من صلاحية مدير الموارد البشرية (Q12)');
    if (plan.submittedBy && String(plan.submittedBy) === String(user._id)) throw forbidden('لا يعتمد من رفع الخطة خطته');
    Object.assign(plan, { state: 'approved', approvedBy: user._id, approvedAt: new Date() });
    await TrainingNeed.updateMany({ _id: { $in: plan.items.flatMap((i) => i.needIds ?? []) }, state: { $in: ['new', 'accepted'] } }, { $set: { state: 'planned' } });
  } else if (code === 'return') {
    if (plan.state !== 'submitted') throw badRequest('الخطة ليست بانتظار الاعتماد');
    if (!roles.includes(policy.planApproverRole)) throw forbidden();
    if (!reason) throw badRequest('السبب مطلوب');
    Object.assign(plan, { state: 'draft', returnReason: reason });
  } else {
    if (plan.state !== 'approved') throw badRequest('الخطة ليست معتمدة');
    if (!isHr(user)) throw forbidden();
    Object.assign(plan, { state: 'closed', closedAt: new Date() });
  }
  await plan.save();
  await recordAudit(actor, { action: 'transition', resource: 'hr.training', resourceId: String(plan._id), before: { state: from }, after: { state: plan.state }, meta: { reason } });
  if (code === 'submit') {
    const approvers = (await User.find({ 'roles.role': policy.planApproverRole, status: 'active' }).select('_id').lean()).map((u) => String(u._id));
    await notify({ userIds: approvers, type: 'generic', titleAr: 'خطة تدريب بانتظار الاعتماد', bodyAr: `خطة التدريب السنوية ${plan.year}`, link: '/hr/training' });
  }
  return plan;
}

// ---------- needs [HR §3.8.2–3.8.3] ----------
export async function createNeed(input: { departmentId: string; year: number; title: string; justification?: string; source: string; appraisalId?: string; employeeIds: string[]; priority: string }, user: UserDoc, actor: Actor) {
  const policy = await getSetting('hr.training');
  const roles = user.roles;
  const managesDept = roles.some((r) => policy.needsSubmitters.includes(r.role) && (!r.departmentId || String(r.departmentId) === input.departmentId));
  if (!isHr(user) && !managesDept) throw forbidden('رفع الاحتياجات التدريبية من صلاحية مدير القسم أو الموارد البشرية');
  const need = await TrainingNeed.create({ ...input, requestedBy: user._id });
  await recordAudit(actor, { action: 'create', resource: 'hr.training', resourceId: String(need._id), after: { title: input.title, departmentId: input.departmentId } });
  await notify({ userIds: await hrUserIds(), type: 'generic', titleAr: 'احتياج تدريبي جديد', bodyAr: input.title, link: '/hr/training' });
  return need;
}
export async function setNeedState(id: string, state: string, note: string | undefined, actor: Actor) {
  const need = await TrainingNeed.findOne({ _id: id, deletedAt: null });
  if (!need) throw notFound('الاحتياج غير موجود');
  const before = need.state;
  need.state = state as never;
  need.stateNote = note;
  await need.save();
  await recordAudit(actor, { action: 'update', resource: 'hr.training', resourceId: String(need._id), before: { state: before }, after: { state, note } });
  return need;
}

// ---------- courses [HR §3.8.4–3.8.5] ----------
export async function createTraining(input: CreateTrainingInput, user: UserDoc, actor: Actor): Promise<TrainingDoc> {
  const number = await nextNumber('training');
  const t = await Training.create({ ...input, number, createdBy: user._id, state: 'planned' });
  // The course on the shared calendar [EP §13.6 «إضافة دورة تدريبية»]; participants are added as they are nominated.
  const ev = await CalendarEvent.create({
    number: await nextNumber('event'),
    title: `دورة تدريبية: ${input.title}`,
    type: 'training',
    status: 'scheduled',
    startAt: input.startAt,
    endAt: input.endAt,
    allDay: false,
    location: input.location,
    description: input.description,
    ownerId: user._id,
    participantIds: [],
    departmentIds: input.departmentIds,
    link: { type: 'training', id: String(t._id), label: number },
  });
  t.calendarEventId = ev._id;
  await t.save();
  if (input.needIds.length) await TrainingNeed.updateMany({ _id: { $in: input.needIds } }, { $set: { state: 'planned' } });
  await recordAudit(actor, { action: 'create', resource: 'hr.training', resourceId: String(t._id), after: { number, title: input.title } });
  await publish({ type: 'hr.training.scheduled', aggregateType: 'training', aggregateId: String(t._id), payload: { number, title: input.title, startAt: input.startAt }, actorUserId: actor.userId });
  return t;
}
export async function updateTraining(t: TrainingDoc, patch: Record<string, unknown>, actor: Actor) {
  const before = t.toObject();
  t.set(patch);
  await t.save();
  if (t.calendarEventId)
    await CalendarEvent.updateOne({ _id: t.calendarEventId }, { $set: { title: `دورة تدريبية: ${t.title}`, startAt: t.startAt, endAt: t.endAt, location: t.location, status: t.state === 'cancelled' ? 'cancelled' : t.state === 'completed' ? 'done' : 'scheduled' } });
  if (patch.state === 'completed') {
    await TrainingNeed.updateMany({ _id: { $in: t.needIds } }, { $set: { state: 'done' } });
    await publish({ type: 'hr.training.completed', aggregateType: 'training', aggregateId: String(t._id), payload: { number: t.number }, actorUserId: actor.userId });
  }
  await recordAudit(actor, { action: 'update', resource: 'hr.training', resourceId: String(t._id), before, after: t });
  return t;
}

// ---------- participants [HR §3.8.6–3.8.7] ----------
/** Nominate employees: a participant row, a task in «مهامي» (EP §10) and a place on the calendar event. */
export async function nominate(t: TrainingDoc, employeeIds: string[], user: UserDoc, actor: Actor) {
  if (['completed', 'cancelled'].includes(t.state)) throw badRequest('الدورة منتهية أو ملغاة');
  const employees = await Employee.find({ _id: { $in: employeeIds }, deletedAt: null });
  const created = [];
  for (const e of employees) {
    if (await TrainingParticipant.exists({ trainingId: t._id, employeeId: e._id })) continue;
    let taskId: unknown;
    if (e.userId) {
      const task = await Task.create({
        number: await nextNumber('task'),
        title: `دورة تدريبية: ${t.title}`,
        description: `${t.providerName ?? ''} · ${riyadhDate(t.startAt)} → ${riyadhDate(t.endAt)}${t.location ? ` · ${t.location}` : ''}`.trim(),
        assignerId: user._id,
        assigneeId: e.userId,
        departmentId: e.departmentId,
        priority: 'medium',
        status: 'new',
        startAt: t.startAt,
        dueAt: t.endAt,
        source: { type: 'training', id: String(t._id), label: t.number },
      });
      taskId = task._id;
      await CalendarEvent.updateOne({ _id: t.calendarEventId }, { $addToSet: { participantIds: e.userId } });
    }
    const p = await TrainingParticipant.create({ trainingId: t._id, employeeId: e._id, departmentId: e.departmentId, status: 'nominated', taskId, nominatedBy: user._id, history: [{ at: new Date(), status: 'nominated', byEmail: actor.email }] });
    created.push(p);
    if (e.userId) await notify({ userIds: [String(e.userId)], type: 'training.nominated', bodyAr: `${t.title} — ${riyadhDate(t.startAt)}`, link: '/me/training' });
  }
  await recordAudit(actor, { action: 'update', resource: 'hr.training', resourceId: String(t._id), meta: { nominated: created.length } });
  return created;
}
export async function updateParticipant(id: string, patch: { status?: string; result?: string; certificateAttachmentId?: string }, user: UserDoc, actor: Actor) {
  const p = await TrainingParticipant.findById(id);
  if (!p) throw notFound('المشارك غير موجود');
  const employee = await Employee.findById(p.employeeId).select('userId').lean();
  const self = !!employee?.userId && String(employee.userId) === String(user._id);
  if (!isHr(user) && !self) throw forbidden();
  if (self && !isHr(user) && (patch.status || patch.result)) throw forbidden('الموظف يرفع شهادته فقط؛ حالة المشاركة تسجّلها الموارد البشرية');
  if (patch.certificateAttachmentId) {
    p.certificateAttachmentId = patch.certificateAttachmentId as never;
    p.certificateUploadedAt = new Date();
    const { Attachment } = await import('../../core/files/model');
    await Attachment.updateOne({ _id: patch.certificateAttachmentId }, { $set: { ownerType: 'employee', ownerId: String(p.employeeId) } });
  }
  if (patch.status && patch.status !== p.status) {
    p.status = patch.status as never;
    p.history.push({ at: new Date(), status: patch.status, byEmail: actor.email, note: patch.result } as never);
    if (p.taskId && ['completed', 'attended'].includes(patch.status)) await Task.updateOne({ _id: p.taskId, status: { $ne: 'done' } }, { $set: { status: 'done', progressPercent: 100, completedAt: new Date() } });
    if (p.taskId && patch.status === 'withdrawn') await Task.updateOne({ _id: p.taskId }, { $set: { status: 'cancelled' } });
  }
  if (patch.result !== undefined) p.result = patch.result;
  await p.save();
  await recordAudit(actor, { action: 'update', resource: 'hr.training', resourceId: String(p._id), after: patch });
  return p;
}
export async function removeParticipant(id: string, actor: Actor) {
  const p = await TrainingParticipant.findById(id);
  if (!p) throw notFound('المشارك غير موجود');
  if (p.status !== 'nominated') throw conflict('لا يُحذف مشارك بعد التسجيل؛ سجّله «انسحب»');
  await updateParticipant(id, { status: 'withdrawn' }, { _id: actor.userId, roles: [{ role: 'hr_manager' }] } as never, actor);
}

/** Daily: remind participants before a course and mark started courses «جارية». */
export async function runTrainingReminders(now = new Date()): Promise<{ reminded: number; running: number }> {
  const policy = await getSetting('hr.training');
  const horizon = new Date(now.getTime() + policy.reminderDaysBefore * 86_400_000 + 86_400_000);
  let reminded = 0;
  for (const t of await Training.find({ deletedAt: null, state: { $in: ['planned', 'open'] }, startAt: { $gte: now, $lte: horizon }, reminderSentAt: null })) {
    const parts = await TrainingParticipant.find({ trainingId: t._id, status: { $in: ['nominated', 'registered'] } }).select('employeeId').lean();
    const users = await Employee.find({ _id: { $in: parts.map((p) => p.employeeId) }, userId: { $ne: null } }).select('userId').lean();
    if (users.length) await notify({ userIds: users.map((u) => String(u.userId)), type: 'training.reminder', bodyAr: `${t.title} تبدأ ${riyadhDate(t.startAt)}${t.location ? ` — ${t.location}` : ''}`, link: '/me/training' });
    await Training.updateOne({ _id: t._id }, { $set: { reminderSentAt: now } });
    reminded += users.length;
  }
  const r = await Training.updateMany({ deletedAt: null, state: { $in: ['planned', 'open'] }, startAt: { $lte: now }, endAt: { $gte: now } }, { $set: { state: 'running' } });
  return { reminded, running: r.modifiedCount };
}
