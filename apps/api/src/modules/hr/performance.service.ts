import type { ClientSession } from 'mongoose';
import {
  APPRAISAL_CYCLE_KIND_AR,
  type AppraisalTemplateInput,
  type CreateAppraisalCycleInput,
  type CreateDisciplinaryInput,
  type CreateGoalInput,
  type DisciplinePolicy,
} from '@eayni/shared';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors';
import { SYSTEM_ACTOR, type Actor } from '../../core/http/context';
import { recordAudit } from '../../core/audit/service';
import { nextNumber } from '../../core/numbering/service';
import { notify } from '../../core/notifications/service';
import { publish } from '../../core/outbox/service';
import { getSetting, getSettingMeta } from '../../core/settings/service';
import { applyTransition, availableTransitions, getWorkflow } from '../../core/workflow/engine';
import { isWeekend, loadHolidaySet, riyadhDate, riyadhDayEndOf } from '../../core/dates/businessDays';
import { kpiDefinition } from '../../core/kpi/registry';
import { Task, TaskEvent } from '../../core/tasks/model';
import { User, type UserDoc } from '../../core/auth/model';
import { withTransaction } from '../../db';
import { Employee, type EmployeeDoc } from './model';
import { addDays } from './attendance.service';
import { hrUserIds, registerManagerChangeHandler } from './service';
import { PayrollAdjustment } from './payroll.model';
import {
  Appraisal,
  AppraisalCycle,
  AppraisalTemplate,
  DisciplinaryAction,
  Goal,
  ImprovementPlan,
  PerformanceEvent,
  type AppraisalCycleDoc,
  type AppraisalDoc,
  type DisciplinaryActionDoc,
} from './performance.model';

const HR_ROLES = ['hr_officer', 'hr_manager'];
const isHr = (user: UserDoc) => user.roles.some((r) => HR_ROLES.includes(r.role));
const dayStart = (day: string) => new Date(`${day}T00:00:00+03:00`);
const dayEnd = (day: string) => new Date(`${day}T23:59:59.999+03:00`);

async function event(recordType: string, recordId: unknown, type: string, actor: Actor, extra: Record<string, unknown> = {}, session?: ClientSession) {
  await PerformanceEvent.create([{ recordType, recordId, type, actorUserId: actor.userId, actorEmail: actor.email, ...extra }], { session });
}
async function managerUserIdOf(employee: EmployeeDoc): Promise<string | undefined> {
  if (!employee.directManagerId) return undefined;
  const m = await Employee.findById(employee.directManagerId).select('userId').lean();
  return m?.userId ? String(m.userId) : undefined;
}

// ==================================================================================================
// Goals [HR §3.7 «تحديد الأهداف الوظيفية لكل موظف»، «ربط الأهداف بمؤشرات أداء القسم»، «متابعة نسبة الإنجاز»]
// ==================================================================================================
export async function createGoal(input: CreateGoalInput, actor: Actor) {
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null });
  if (!employee) throw notFound('الموظف غير موجود');
  let kpiNameAr: string | undefined;
  if (input.kpiCode) {
    const def = kpiDefinition(input.kpiCode);
    if (!def) throw badRequest('مؤشر الأداء غير معروف؛ اختر من سجل المؤشرات', { code: 'unknown_kpi' });
    kpiNameAr = def.nameAr;
  }
  const goal = await Goal.create({ ...input, kpiNameAr, setBy: actor.userId, state: 'active' });
  await event('goal', goal._id, 'created', actor, { toState: 'active' });
  await recordAudit(actor, { action: 'create', resource: 'hr.goals', resourceId: String(goal._id), after: { employeeId: input.employeeId, title: input.title } });
  if (employee.userId) await notify({ userIds: [String(employee.userId)], type: 'goal.assigned', bodyAr: input.title, link: '/me/performance' });
  return goal;
}
export async function updateGoal(id: string, patch: Record<string, unknown>, actor: Actor) {
  const goal = await Goal.findOne({ _id: id, deletedAt: null });
  if (!goal) throw notFound('الهدف غير موجود');
  if (patch.kpiCode) {
    const def = kpiDefinition(String(patch.kpiCode));
    if (!def) throw badRequest('مؤشر الأداء غير معروف', { code: 'unknown_kpi' });
    patch.kpiNameAr = def.nameAr;
  }
  const before = goal.toObject();
  goal.set(patch);
  await goal.save();
  await event('goal', goal._id, 'updated', actor, { fromState: before.state, toState: goal.state, changes: patch });
  await recordAudit(actor, { action: 'update', resource: 'hr.goals', resourceId: String(goal._id), before, after: goal });
  return goal;
}
export async function addGoalProgress(id: string, percent: number, note: string | undefined, actor: Actor) {
  const goal = await Goal.findOne({ _id: id, deletedAt: null });
  if (!goal) throw notFound('الهدف غير موجود');
  if (!['active', 'draft'].includes(goal.state)) throw badRequest('الهدف غير قائم');
  goal.progress.push({ at: new Date(), percent, note, byUserId: actor.userId as never, byEmail: actor.email } as never);
  goal.percent = percent;
  if (percent >= 100) goal.state = 'achieved';
  await goal.save();
  await event('goal', goal._id, 'progress', actor, { changes: { percent, note } });
  return goal;
}

// ==================================================================================================
// Templates and cycles [HR §3.7 «تقييم الأداء نصف سنوي وسنوي»]
// ==================================================================================================
export async function saveTemplate(input: AppraisalTemplateInput, actor: Actor, id?: string) {
  const weights = input.sections.reduce((s, x) => s + x.weightBp, 0);
  if (weights !== 10_000) throw badRequest('مجموع أوزان الأقسام يجب أن يكون 100%');
  for (const sec of input.sections) if (sec.criteria.reduce((s, c) => s + c.weightBp, 0) !== 10_000) throw badRequest(`مجموع أوزان معايير قسم «${sec.titleAr}» يجب أن يكون 100%`);
  if (id) {
    const existing = await AppraisalTemplate.findOne({ _id: id, deletedAt: null });
    if (!existing) throw notFound('النموذج غير موجود');
    const used = await AppraisalCycle.exists({ templateId: existing._id, state: { $ne: 'planned' } });
    if (used) {
      // A template a cycle already opened with is immutable: the change is a new version (golden rule 3, HR_PLAN §3.4).
      const doc = await AppraisalTemplate.create({ ...input, version: existing.version + 1, createdBy: actor.email });
      await AppraisalTemplate.updateOne({ _id: existing._id }, { $set: { active: false } });
      await recordAudit(actor, { action: 'create', resource: 'hr.appraisals', resourceId: String(doc._id), meta: { templateVersionOf: id } });
      return doc;
    }
    existing.set(input);
    await existing.save();
    await recordAudit(actor, { action: 'update', resource: 'hr.appraisals', resourceId: String(existing._id), after: existing });
    return existing;
  }
  const doc = await AppraisalTemplate.create({ ...input, version: 1, createdBy: actor.email });
  await recordAudit(actor, { action: 'create', resource: 'hr.appraisals', resourceId: String(doc._id), after: doc });
  return doc;
}

export async function ensureDefaultTemplate(actor: Actor = SYSTEM_ACTOR) {
  const existing = await AppraisalTemplate.findOne({ deletedAt: null, active: true }).sort({ version: -1 });
  if (existing) return existing;
  const { DEFAULT_APPRAISAL_TEMPLATE } = await import('@eayni/shared');
  return saveTemplate(DEFAULT_APPRAISAL_TEMPLATE, actor);
}

export async function createCycle(input: CreateAppraisalCycleInput, actor: Actor) {
  if (await AppraisalCycle.exists({ year: input.year, kind: input.kind })) throw conflict('توجد دورة تقييم لهذه السنة والنوع');
  const template = await AppraisalTemplate.findOne({ _id: input.templateId, deletedAt: null });
  if (!template) throw badRequest('النموذج غير موجود');
  const cycle = await AppraisalCycle.create({ ...input, nameAr: `${APPRAISAL_CYCLE_KIND_AR[input.kind]} ${input.year}`, createdBy: actor.userId });
  await recordAudit(actor, { action: 'create', resource: 'hr.appraisals', resourceId: String(cycle._id), after: cycle });
  return cycle;
}

/** Tasks assigned to the employee inside the cycle window — «تسجيل المهام المسندة … متابعة نسبة الإنجاز» [HR §3.7]. */
async function tasksCompletionOf(userId: unknown, from: string, to: string) {
  const tasks = await Task.find({ assigneeId: userId, deletedAt: null, status: { $ne: 'cancelled' }, createdAt: { $lte: dayEnd(to) }, $or: [{ dueAt: { $gte: dayStart(from), $lte: dayEnd(to) } }, { dueAt: null, createdAt: { $gte: dayStart(from) } }] })
    .select('status dueAt completedAt')
    .lean();
  const assigned = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const late = tasks.filter((t) => t.status === 'late' || (t.dueAt && ((t.completedAt && t.completedAt > t.dueAt) || (!t.completedAt && t.dueAt < new Date())))).length;
  return { assigned, done, late, percentBp: assigned ? Math.round((done / assigned) * 10_000) : null };
}

/** Open a cycle: one appraisal per eligible employee, pinned to the direct manager of that moment (HR_PLAN §4.6). */
export async function openCycle(cycle: AppraisalCycleDoc, actor: Actor): Promise<{ created: number }> {
  if (cycle.state !== 'planned') throw badRequest('الدورة مفتوحة أو مغلقة مسبقاً');
  const policy = await getSetting('hr.appraisal');
  const template = await AppraisalTemplate.findById(cycle.templateId).lean();
  if (!template) throw badRequest('نموذج الدورة غير موجود');
  const cutoff = new Date(dayStart(cycle.to).getTime() - policy.minServiceDays * 86_400_000);
  const employees = await Employee.find({ deletedAt: null, status: { $nin: ['resigned', 'terminated'] }, hireDate: { $lte: cutoff } });
  let created = 0;
  const managers = new Set<string>();
  for (const e of employees) {
    if (await Appraisal.exists({ employeeId: e._id, cycleId: cycle._id })) continue;
    const managerUserId = await managerUserIdOf(e);
    // Goals of the cycle: tied to it, or standing goals (no cycle) that are undated or due inside the window.
    const goals = await Goal.find({ employeeId: e._id, deletedAt: null, state: { $ne: 'cancelled' }, $or: [{ cycleId: cycle._id }, { cycleId: null, dueDate: null }, { cycleId: null, dueDate: { $gte: cycle.from, $lte: cycle.to } }] }).lean();
    await Appraisal.create({
      employeeId: e._id,
      cycleId: cycle._id,
      departmentId: e.departmentId,
      managerUserId: managerUserId ?? undefined,
      state: 'open',
      stateEnteredAt: new Date(),
      dueAt: dayEnd(cycle.dueAt),
      goalsSnapshot: goals.map((g) => ({ _id: g._id, title: g.title, weightBp: g.weightBp, percent: g.percent, kpiCode: g.kpiCode, state: g.state })),
      tasksCompletion: e.userId ? await tasksCompletionOf(e.userId, cycle.from, cycle.to) : undefined,
    });
    if (managerUserId) managers.add(managerUserId);
    created++;
  }
  cycle.state = 'open';
  cycle.openedAt = new Date();
  cycle.templateSnapshot = template;
  await cycle.save();
  await recordAudit(actor, { action: 'update', resource: 'hr.appraisals', resourceId: String(cycle._id), meta: { opened: created } });
  if (managers.size) await notify({ userIds: [...managers], type: 'appraisal.opened', bodyAr: `${cycle.nameAr}: قيّم فريقك قبل ${cycle.dueAt}`, link: '/manager/appraisals' });
  return { created };
}

export async function closeCycle(cycle: AppraisalCycleDoc, actor: Actor) {
  if (cycle.state !== 'open') throw badRequest('الدورة ليست مفتوحة');
  cycle.state = 'closed';
  cycle.closedAt = new Date();
  await cycle.save();
  await recordAudit(actor, { action: 'update', resource: 'hr.appraisals', resourceId: String(cycle._id), after: { state: 'closed' } });
  return cycle;
}

// ==================================================================================================
// Appraisals
// ==================================================================================================
type Criterion = { key: string; labelAr: string; weightBp: number; source: 'manual' | 'goals' | 'tasks' };
type Template = { sections: { titleAr: string; weightBp: number; criteria: Criterion[] }[]; scale: { value: number; labelAr: string }[]; improvementThresholdBp: number };

export async function relationsForAppraisal(user: UserDoc, a: AppraisalDoc): Promise<string[]> {
  const rel = new Set<string>(user.roles.map((r) => r.role));
  const employee = await Employee.findById(a.employeeId).select('userId').lean();
  if (employee?.userId && String(employee.userId) === String(user._id)) return ['subject']; // the appraised employee never scores or approves oneself
  if (a.managerUserId && String(a.managerUserId) === String(user._id)) rel.add('direct_manager');
  return [...rel];
}

/** The manager's scores [HR §3.7 «تسجيل نتائج التقييم وملاحظات المدير المباشر»]; `goals` / `tasks` criteria come from the snapshots. */
export async function scoreAppraisal(a: AppraisalDoc, user: UserDoc, scores: { key: string; value: number; note?: string }[], managerNotes: string | undefined, actor: Actor) {
  const rel = await relationsForAppraisal(user, a);
  if (!rel.includes('direct_manager') && !rel.some((r) => HR_ROLES.includes(r))) throw forbidden('التقييم من صلاحية المدير المباشر');
  if (rel.includes('subject')) throw forbidden('لا يقيّم الموظف نفسه');
  if (!['open', 'returned'].includes(a.state)) throw badRequest('التقييم ليس مفتوحاً للتعديل');
  const cycle = await AppraisalCycle.findById(a.cycleId).lean();
  const template = (cycle?.templateSnapshot ?? (await AppraisalTemplate.findById(cycle!.templateId).lean())) as Template;
  const maxScale = Math.max(...template.scale.map((s) => s.value));
  const minScale = Math.min(...template.scale.map((s) => s.value));
  const all: { key: string; value: number; note?: string }[] = [];
  let overall = 0;
  for (const sec of template.sections) {
    let secScore = 0;
    for (const c of sec.criteria) {
      let value: number;
      if (c.source === 'goals') {
        const goals = (a.goalsSnapshot as { weightBp: number; percent: number }[] | undefined) ?? [];
        const w = goals.reduce((s, g) => s + g.weightBp, 0);
        const pct = w ? goals.reduce((s, g) => s + (g.percent ?? 0) * g.weightBp, 0) / w : null;
        value = pct === null ? NaN : Math.round(minScale + ((maxScale - minScale) * pct) / 100);
        if (Number.isNaN(value)) {
          const manual = scores.find((s) => s.key === c.key);
          if (!manual) throw badRequest(`لا أهداف مسجّلة؛ أدخل درجة «${c.labelAr}» يدوياً`);
          value = manual.value;
        }
      } else if (c.source === 'tasks') {
        const pctBp = a.tasksCompletion?.percentBp ?? null;
        if (pctBp === null) {
          const manual = scores.find((s) => s.key === c.key);
          if (!manual) throw badRequest(`لا مهام مسندة في الفترة؛ أدخل درجة «${c.labelAr}» يدوياً`);
          value = manual.value;
        } else value = Math.round(minScale + ((maxScale - minScale) * pctBp) / 10_000);
      } else {
        const manual = scores.find((s) => s.key === c.key);
        if (!manual) throw badRequest(`درجة «${c.labelAr}» مطلوبة`);
        if (!template.scale.some((s) => s.value === manual.value)) throw badRequest(`درجة «${c.labelAr}» خارج المقياس`);
        value = manual.value;
      }
      const note = scores.find((s) => s.key === c.key)?.note;
      all.push({ key: c.key, value, note });
      secScore += ((value - minScale) / (maxScale - minScale)) * c.weightBp;
    }
    overall += (secScore / 10_000) * sec.weightBp;
  }
  const overallBp = Math.round(overall);
  const ratingValue = minScale + ((maxScale - minScale) * overallBp) / 10_000;
  const rating = [...template.scale].sort((x, y) => Math.abs(x.value - ratingValue) - Math.abs(y.value - ratingValue))[0];
  a.scores = all as never;
  a.overallScoreBp = overallBp;
  a.overallRatingLabel = rating?.labelAr;
  if (managerNotes !== undefined) a.managerNotes = managerNotes;
  await a.save();
  await event('appraisal', a._id, 'scored', actor, { changes: { overallScoreBp: overallBp } });
  await recordAudit(actor, { action: 'update', resource: 'hr.appraisals', resourceId: String(a._id), after: { overallScoreBp: overallBp }, sensitive: true });
  return a;
}

export async function availableAppraisalActions(user: UserDoc, a: AppraisalDoc): Promise<string[]> {
  const def = await getWorkflow('hr_appraisal');
  return availableTransitions(def, a.state, await relationsForAppraisal(user, a)).map((t) => t.code);
}

export async function transitionAppraisal(a: AppraisalDoc, code: string, opts: { user: UserDoc; actor: Actor; reason?: string; hrNotes?: string; employeeComment?: string }) {
  const def = await getWorkflow('hr_appraisal');
  const rel = await relationsForAppraisal(opts.user, a);
  if (code === 'submit' && a.overallScoreBp === undefined) throw badRequest('أدخل الدرجات قبل التسليم');
  const now = new Date();
  const fromState = a.state;
  const cycle = await AppraisalCycle.findById(a.cycleId).lean();
  const template = cycle?.templateSnapshot as Template | undefined;
  let offerImprovementPlan = false;
  await withTransaction(async (session) => {
    const r = await applyTransition({
      def,
      record: a.toObject() as never,
      recordType: 'hr_appraisal',
      transition: code,
      actor: opts.actor,
      actorRelations: rel,
      reason: opts.reason,
      now,
      session,
      persist: async (fields) => {
        const set: Record<string, unknown> = { ...fields };
        if (code === 'submit') set.submittedAt = now;
        if (code === 'approve') Object.assign(set, { approvedBy: opts.user._id, approvedAt: now, hrNotes: opts.hrNotes });
        if (code === 'acknowledge') Object.assign(set, { acknowledgedAt: now, employeeComment: opts.employeeComment });
        return (await Appraisal.updateOne({ _id: a._id, state: fromState }, { $set: set }, { session })).modifiedCount === 1;
      },
    });
    await event('appraisal', a._id, code, opts.actor, { fromState, toState: r.to, note: opts.reason }, session);
    await recordAudit(opts.actor, { action: 'transition', resource: 'hr.appraisals', resourceId: String(a._id), before: { state: fromState }, after: { state: r.to }, meta: { transition: code } }, session);
    if (code === 'approve') {
      offerImprovementPlan = !!template && (a.overallScoreBp ?? 10_000) < template.improvementThresholdBp;
      await publish({ type: 'hr.appraisal.approved', aggregateType: 'hr_appraisal', aggregateId: String(a._id), payload: { employeeId: String(a.employeeId), cycleId: String(a.cycleId), overallScoreBp: a.overallScoreBp }, actorUserId: opts.actor.userId }, session);
    }
  });
  const doc = (await Appraisal.findById(a._id))!;
  const employee = await Employee.findById(doc.employeeId).select('userId fullNameAr').lean();
  const link = `/hr/performance/appraisals/${doc._id}`;
  if (code === 'submit') await notify({ userIds: await hrUserIds(), type: 'appraisal.submitted', bodyAr: `${employee?.fullNameAr ?? ''} — ${cycle?.nameAr ?? ''}`, link });
  if (code === 'return' && doc.managerUserId) await notify({ userIds: [String(doc.managerUserId)], type: 'appraisal.returned', bodyAr: `${employee?.fullNameAr ?? ''}: ${opts.reason ?? ''}`, link: '/manager/appraisals' });
  if (code === 'approve' && employee?.userId) await notify({ userIds: [String(employee.userId)], type: 'appraisal.approved', bodyAr: `${cycle?.nameAr ?? ''}: ${doc.overallRatingLabel ?? ''} — يرجى الاطلاع والإقرار`, link: '/me/performance' });
  return { appraisal: doc, offerImprovementPlan };
}

// ==================================================================================================
// Improvement plans [HR §3.7 «متابعة خطط تحسين الأداء»]
// ==================================================================================================
export async function createImprovementPlan(input: { employeeId: string; appraisalId?: string; from: string; to: string; objectives: { text: string; measure?: string; dueDate?: string }[] }, user: UserDoc, actor: Actor) {
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null });
  if (!employee) throw notFound('الموظف غير موجود');
  const policy = await getSetting('hr.appraisal');
  const to = input.to <= input.from ? addDays(input.from, policy.improvementPlanDays) : input.to;
  const managerUserId = await managerUserIdOf(employee);
  const plan = await ImprovementPlan.create({
    ...input,
    to,
    objectives: input.objectives.map((o) => ({ ...o, done: false })),
    ownerUserId: managerUserId ?? user._id,
    hrFollowerUserId: isHr(user) ? user._id : undefined,
  });
  if (input.appraisalId) await Appraisal.updateOne({ _id: input.appraisalId }, { $set: { improvementPlanId: plan._id } });
  await event('improvement_plan', plan._id, 'created', actor, { toState: 'active' });
  await recordAudit(actor, { action: 'create', resource: 'hr.improvement_plans', resourceId: String(plan._id), after: { employeeId: input.employeeId, to } });
  if (employee.userId) await notify({ userIds: [String(employee.userId)], type: 'improvement.review_due', titleAr: 'خطة تحسين أداء جديدة', bodyAr: `خطة تحسين أداء حتى ${to}`, link: '/me/performance' });
  return plan;
}
export async function reviewImprovementPlan(id: string, input: { note: string; rating?: number; objectivesDone?: number[] }, actor: Actor) {
  const plan = await ImprovementPlan.findById(id);
  if (!plan) throw notFound('الخطة غير موجودة');
  if (plan.state !== 'active') throw badRequest('الخطة ليست قائمة');
  plan.reviews.push({ at: new Date(), byUserId: actor.userId as never, byEmail: actor.email, note: input.note, rating: input.rating } as never);
  for (const i of input.objectivesDone ?? []) if (plan.objectives[i]) plan.objectives[i].done = true;
  await plan.save();
  await event('improvement_plan', plan._id, 'reviewed', actor, { note: input.note });
  return plan;
}
export async function closeImprovementPlan(id: string, state: 'completed' | 'not_completed' | 'cancelled', note: string, actor: Actor) {
  const plan = await ImprovementPlan.findById(id);
  if (!plan) throw notFound('الخطة غير موجودة');
  if (plan.state !== 'active') throw badRequest('الخطة مغلقة مسبقاً');
  plan.state = state;
  plan.closingNote = note;
  plan.closedAt = new Date();
  await plan.save();
  await event('improvement_plan', plan._id, 'closed', actor, { toState: state, note });
  await recordAudit(actor, { action: 'update', resource: 'hr.improvement_plans', resourceId: String(plan._id), after: { state, note } });
  return plan;
}

// ==================================================================================================
// Disciplinary actions [HR §3.7 «تسجيل الإنذارات والإجراءات الإدارية وفق الصلاحيات»; arts. 66–73]
// ==================================================================================================
/**
 * An *employee* deadline (art. 72 — owner decisions 2026-11-24 / 2026-11-25): `days` days from `fromDay`, official
 * holidays excluded and, when `excludeWeekend` is on (setting `employeeDeadlinesExcludeWeekend`, default on), Friday–Saturday
 * excluded too — each excluded day inside the window extends it by a day. Used for the appeal window and the court-objection
 * window only; the employer's deadlines (arts. 71 and the 15 days to decide an appeal) stay calendar days.
 * Returns the end of the last day (Riyadh).
 */
export function employeeDeadlineFrom(fromDay: string, days: number, holidays: Set<string>, excludeWeekend: boolean): Date {
  let d = fromDay;
  let counted = 0;
  while (counted < days) {
    d = addDays(d, 1);
    if (holidays.has(d)) continue;
    if (excludeWeekend && isWeekend(new Date(`${d}T12:00:00+03:00`))) continue;
    counted++;
  }
  return riyadhDayEndOf(d);
}
/** @deprecated kept for the 2026-11-24 tests: holidays only, no weekend. */
export const appealDeadlineFrom = (deliveredDay: string, days: number, holidays: Set<string>): Date => employeeDeadlineFrom(deliveredDay, days, holidays, false);

/** The oral questioning of art. 71 is accepted only for a warning (no payroll effect) or a fine of at most one day's wage. */
export function oralQuestioningAllowed(payrollEffect: string, fineDays?: number): boolean {
  return payrollEffect === 'none' || (payrollEffect === 'fine' && (fineDays ?? 0) <= 1);
}

export async function disciplinePolicy(): Promise<{ policy: DisciplinePolicy; provisional: boolean }> {
  const m = await getSettingMeta('hr.discipline');
  return { policy: m.value, provisional: m.provisional };
}
export async function relationsForDiscipline(user: UserDoc, d: DisciplinaryActionDoc, policy: DisciplinePolicy): Promise<string[]> {
  const rel = new Set<string>(user.roles.map((r) => r.role));
  const employee = await Employee.findById(d.employeeId).select('userId directManagerId').lean();
  if (employee?.userId && String(employee.userId) === String(user._id)) return ['subject'];
  if (String(d.issuedBy) === String(user._id)) rel.add('issuer');
  if (employee?.directManagerId) {
    const m = await Employee.findById(employee.directManagerId).select('userId').lean();
    if (m?.userId && String(m.userId) === String(user._id)) rel.add('direct_manager');
  }
  // The approver role (Q11: HR manager) — never the issuer of the same action (segregation).
  if (user.roles.some((r) => r.role === policy.approverRole) && String(d.issuedBy) !== String(user._id)) rel.add('approver');
  return [...rel];
}

export async function createDisciplinary(input: CreateDisciplinaryInput, user: UserDoc, actor: Actor) {
  const { policy, provisional } = await disciplinePolicy();
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null });
  if (!employee) throw notFound('الموظف غير موجود');
  if (employee.userId && String(employee.userId) === String(user._id)) throw forbidden('لا يُصدر الموظف إجراءً على نفسه');
  const step = policy.ladder.find((s) => s.code === input.kind);
  if (!step) throw badRequest('نوع الإجراء ليس في سلّم الإجراءات المعتمد', { code: 'unknown_kind' });
  const managerUserId = await managerUserIdOf(employee);
  const roles = user.roles.map((r) => r.role);
  const mayIssue = policy.issuers.some((i) => (i === 'direct_manager' ? managerUserId === String(user._id) : roles.includes(i)));
  if (!mayIssue) throw forbidden('إصدار الإجراء من صلاحية المدير المباشر أو الموارد البشرية');
  const today = riyadhDate(new Date());
  if (input.violationDate > today) throw badRequest('تاريخ المخالفة في المستقبل');
  if (input.discoveryDate > today) throw badRequest('تاريخ اكتشاف المخالفة في المستقبل');
  if (input.discoveryDate < input.violationDate) throw badRequest('تاريخ الاكتشاف قبل تاريخ المخالفة');
  // Art. 71 (owner decision 2026-11-24): the 30 days run from the *discovery* of the violation, not from the violation itself.
  if (input.discoveryDate < addDays(today, -policy.violationDiscoveryDays))
    throw badRequest(`لا يُتخذ جزاء على مخالفة مضى على اكتشافها أكثر من ${policy.violationDiscoveryDays} يوماً (المادة 71)`, { code: 'discovery_expired' });
  // Art. 71 (owner decision 2026-11-25): every penalty follows an investigation — its end date and its record (محضر التحقيق) are mandatory.
  if (input.investigationEndDate < input.discoveryDate) throw badRequest('انتهاء التحقيق قبل اكتشاف المخالفة');
  if (input.investigationEndDate > today) throw badRequest('تاريخ انتهاء التحقيق في المستقبل');
  if (input.investigationEndDate < addDays(today, -policy.investigationSignDays))
    throw badRequest(`لا يُوقَّع الجزاء بعد مرور ${policy.investigationSignDays} يوماً من انتهاء التحقيق وثبوت المخالفة (المادة 71)`, { code: 'investigation_expired' });
  if ((input.investigationRecordText ?? '').trim().length < 10 && !input.investigationRecordAttachmentIds.length)
    throw badRequest('أرفق محضر التحقيق أو أدخل نصه (المادة 71)', { code: 'investigation_record_required' });
  if (input.investigationMode === 'oral' && !oralQuestioningAllowed(step.payrollEffect, input.fineDays))
    throw badRequest('الاستجواب الشفهي مقبول فقط للإنذار أو لغرامة لا تتجاوز أجر يوم واحد؛ غير ذلك يلزم تحقيق كتابي (المادة 71)', { code: 'oral_not_allowed' });
  // One penalty per violation (owner decision 2026-11-24): a second action on the same employee and day needs an explicit «مخالفة مستقلة».
  if (!input.separateViolation && (await DisciplinaryAction.exists({ employeeId: employee._id, violationDate: input.violationDate, state: { $ne: 'withdrawn' }, deletedAt: null })))
    throw conflict('يوجد إجراء على مخالفة لهذا الموظف في نفس اليوم؛ جزاء واحد فقط لكل مخالفة. علّم «مخالفة أخرى مستقلة» إن كانت مخالفة مختلفة', { code: 'violation_already_penalised' });
  if (step.payrollEffect === 'fine') {
    if (!input.fineDays || input.fineDays <= 0) throw badRequest('حدّد أيام الخصم');
    const maxDays = Math.min(step.maxFineDaysPerMonth ?? Infinity, policy.maxFineDaysPerViolation);
    if (input.fineDays > maxDays) throw badRequest(`غرامة المخالفة الواحدة لا تتجاوز أجر ${maxDays} أيام (المادة 70)`, { code: 'fine_over_max' });
  }
  if (step.payrollEffect === 'suspension' && step.maxSuspensionDays !== null && (input.suspensionDays ?? 0) > step.maxSuspensionDays)
    throw badRequest(`الحد الأقصى للإيقاف ${step.maxSuspensionDays} أيام (المادة 70)`);
  const total = (employee.basicSalaryHalalas ?? 0) + (employee.allowances ?? []).reduce((s, a) => s + (a.amountHalalas ?? 0), 0);
  const def = await getWorkflow('hr_disciplinary');
  const doc = await DisciplinaryAction.create({
    number: await nextNumber('disciplinary'),
    employeeId: employee._id,
    departmentId: employee.departmentId,
    kind: step.code,
    kindLabelAr: step.labelAr,
    payrollEffect: step.payrollEffect,
    fineDays: step.payrollEffect === 'fine' ? input.fineDays : undefined,
    fineHalalas: step.payrollEffect === 'fine' ? Math.round(((input.fineDays ?? 0) * total) / 30) : undefined,
    suspensionDays: step.payrollEffect === 'suspension' ? input.suspensionDays : undefined,
    violationDate: input.violationDate,
    discoveryDate: input.discoveryDate,
    investigationEndDate: input.investigationEndDate,
    investigationMode: input.investigationMode,
    investigationRecordText: input.investigationRecordText,
    investigationRecordAttachmentIds: input.investigationRecordAttachmentIds,
    separateViolation: input.separateViolation,
    description: input.description,
    evidenceAttachmentIds: input.evidenceAttachmentIds,
    issuedBy: user._id,
    issuedByRelation: managerUserId === String(user._id) ? 'direct_manager' : 'hr',
    state: def.initialState,
    stateEnteredAt: new Date(),
  });
  await event('disciplinary', doc._id, 'created', actor, { toState: 'draft', changes: { provisionalLadder: provisional } });
  await recordAudit(actor, { action: 'create', resource: 'hr.discipline', resourceId: String(doc._id), after: { number: doc.number, kind: doc.kind, employeeId: String(employee._id) }, sensitive: true });
  return doc;
}

export async function availableDisciplineActions(user: UserDoc, d: DisciplinaryActionDoc) {
  const def = await getWorkflow('hr_disciplinary');
  const { policy } = await disciplinePolicy();
  const rel = await relationsForDiscipline(user, d, policy);
  let codes = availableTransitions(def, d.state, rel).map((t) => t.code);
  if (d.state === 'delivered' && rel.includes('subject') && d.appealDeadline && d.appealDeadline < new Date()) codes = codes.filter((c) => c !== 'appeal');
  if (rel.includes('subject')) codes = codes.filter((c) => c === 'acknowledge' || c === 'appeal');
  return codes.filter((c) => c !== 'finalize'); // the system's transition when the court-objection window ends
}

export async function transitionDisciplinary(d: DisciplinaryActionDoc, code: string, opts: { user: UserDoc; actor: Actor; note?: string }) {
  const def = await getWorkflow('hr_disciplinary');
  const { policy } = await disciplinePolicy();
  const rel = await relationsForDiscipline(opts.user, d, policy);
  if (['approve', 'reject', 'uphold', 'reject_appeal', 'withdraw', 'court_uphold', 'court_cancel'].includes(code) && String(d.issuedBy) === String(opts.user._id) && !opts.actor.system)
    throw forbidden('لا يعتمد مُصدر الإجراء إجراءه (فصل المهام)');
  if (code === 'finalize' && !opts.actor.system) throw forbidden('انتهاء مهلة الاعتراض يُثبته النظام وحده عند حلولها');
  if (code === 'appeal' && d.appealDeadline && d.appealDeadline < new Date()) throw badRequest(`انتهت مهلة التظلم (${policy.appealDays} يوماً عدا العطل)`);
  const now = new Date();
  const today = riyadhDate(now);
  if (code === 'finalize' && (!d.courtObjectionDeadline || d.courtObjectionDeadline >= now)) throw badRequest('مهلة الاعتراض أمام المحكمة لم تنتهِ بعد');
  // Art. 71: the penalty is signed (approved) within `investigationSignDays` of the investigation's end.
  if (code === 'approve' && d.investigationEndDate && d.investigationEndDate < addDays(today, -policy.investigationSignDays))
    throw badRequest(`لا يُوقَّع الجزاء بعد مرور ${policy.investigationSignDays} يوماً من انتهاء التحقيق (المادة 71)`, { code: 'investigation_expired' });
  const holidays = code === 'deliver' || code === 'reject_appeal' ? await loadHolidaySet() : new Set<string>();
  const fromState = d.state;
  const employeeForTask = code === 'appeal' ? await Employee.findById(d.employeeId).select('userId fullNameAr departmentId').lean() : null;
  // Art. 72 (owner decision 2026-11-25): the court-objection window runs from the rejection of the appeal or from the end of the
  // decision window, whichever came first — so an escalated (undecided) appeal keeps the earlier deadline.
  const courtDeadline = code === 'reject_appeal' ? (d.courtObjectionDeadline ?? employeeDeadlineFrom(today, policy.courtObjectionDays, holidays, policy.employeeDeadlinesExcludeWeekend)) : undefined;
  await withTransaction(async (session) => {
    const r = await applyTransition({
      def,
      record: d.toObject() as never,
      recordType: 'hr_disciplinary',
      transition: code,
      actor: opts.actor,
      actorRelations: rel,
      reason: opts.note,
      now,
      session,
      persist: async (fields) => {
        const set: Record<string, unknown> = { ...fields };
        if (code === 'approve') Object.assign(set, { approvedBy: opts.user._id, approvedAt: now });
        if (code === 'deliver') Object.assign(set, { deliveredAt: now, deliveredBy: opts.user._id, appealDeadline: employeeDeadlineFrom(today, policy.appealDays, holidays, policy.employeeDeadlinesExcludeWeekend) });
        if (code === 'acknowledge') set.employeeAck = { at: now, note: opts.note };
        // The 15 days to decide are the employer's: calendar days.
        if (code === 'appeal') Object.assign(set, { appeal: { at: now, note: opts.note }, appealDecisionDueAt: riyadhDayEndOf(addDays(today, policy.appealDecisionDays)) });
        if (code === 'reject_appeal') Object.assign(set, { 'appeal.outcome': 'rejected', 'appeal.decidedBy': opts.user._id, 'appeal.decidedAt': now, 'appeal.decisionNote': opts.note, courtObjectionDeadline: courtDeadline });
        if (code === 'withdraw' && fromState === 'appealed') Object.assign(set, { 'appeal.outcome': 'withdrawn', 'appeal.decidedBy': opts.user._id, 'appeal.decidedAt': now, 'appeal.decisionNote': opts.note });
        if (code === 'finalize' && fromState === 'appealed') Object.assign(set, { 'appeal.outcome': 'expired', 'appeal.decidedAt': now, 'appeal.decisionNote': opts.note });
        if (code === 'court_objection') Object.assign(set, { 'court.filedAt': now, 'court.filedBy': opts.user._id, 'court.reference': opts.note });
        if (code === 'court_uphold' || code === 'court_cancel') Object.assign(set, { 'court.rulingAt': now, 'court.rulingBy': opts.user._id, 'court.rulingOutcome': code === 'court_uphold' ? 'upheld' : 'cancelled', 'court.rulingNote': opts.note });
        return (await DisciplinaryAction.updateOne({ _id: d._id, state: fromState }, { $set: set }, { session })).modifiedCount === 1;
      },
    });
    // Art. 72 (owner decision 2026-11-24): the appeal must be decided in writing within `appealDecisionDays` — a task with that deadline for the approver.
    if (code === 'appeal') {
      const [task] = await Task.create(
        [
          {
            number: await nextNumber('task', session),
            title: `البت في تظلم على ${d.kindLabelAr} ${d.number}`,
            description: `تظلّم ${employeeForTask?.fullNameAr ?? ''} على الإجراء ${d.number}: ${opts.note ?? ''}\nيجب البت فيه كتابياً خلال ${policy.appealDecisionDays} يوماً (المادة 72).`,
            assignerId: employeeForTask?.userId ?? opts.user._id,
            assigneeId: d.approvedBy ?? null,
            departmentId: d.departmentId,
            priority: 'high',
            status: 'new',
            startAt: now,
            dueAt: riyadhDayEndOf(addDays(today, policy.appealDecisionDays)),
            source: { type: 'disciplinary', id: String(d._id), label: d.number },
          },
        ],
        { session },
      );
      await DisciplinaryAction.updateOne({ _id: d._id }, { $set: { appealTaskId: task._id } }, { session });
    }
    // Any way out of «قيد التظلم» closes the decision task (a court objection or the window's end supersede the internal decision).
    if (fromState === 'appealed' && d.appealTaskId)
      await Task.updateOne({ _id: d.appealTaskId, status: { $nin: ['done', 'cancelled'] } }, { $set: { status: code === 'reject_appeal' || code === 'withdraw' ? 'done' : 'cancelled', ...(code === 'reject_appeal' || code === 'withdraw' ? { progressPercent: 100, completedAt: now } : {}) } }, { session });
    // A fine reaches payroll only once the action is final (upheld) — «التعديل يدخل في المسير التالي»; a court objection holds it until the ruling.
    if (r.to === 'upheld' && d.payrollEffect === 'fine' && d.fineHalalas && !d.payrollAdjustmentId) {
      const [adj] = await PayrollAdjustment.create(
        [{ employeeId: d.employeeId, kind: 'deduction', amountHalalas: d.fineHalalas, reason: `${d.kindLabelAr} ${d.number}`, sourceType: 'disciplinary', sourceId: String(d._id), createdBy: opts.actor.userId, createdByEmail: opts.actor.email }],
        { session },
      );
      await DisciplinaryAction.updateOne({ _id: d._id }, { $set: { payrollAdjustmentId: adj._id } }, { session });
      await publish({ type: 'hr.discipline.payroll_effect', aggregateType: 'hr_disciplinary', aggregateId: String(d._id), payload: { employeeId: String(d.employeeId), amountHalalas: d.fineHalalas }, actorUserId: opts.actor.userId }, session);
    }
    await event('disciplinary', d._id, code, opts.actor, { fromState, toState: r.to, note: opts.note }, session);
    await recordAudit(opts.actor, { action: 'transition', resource: 'hr.discipline', resourceId: String(d._id), before: { state: fromState }, after: { state: r.to }, meta: { transition: code }, sensitive: true }, session);
  });
  const doc = (await DisciplinaryAction.findById(d._id))!;
  const employee = await Employee.findById(doc.employeeId).select('userId fullNameAr').lean();
  const approvers = (await User.find({ 'roles.role': policy.approverRole, status: 'active' }).select('_id').lean()).map((u) => String(u._id));
  const subject = employee?.userId ? [String(employee.userId)] : [];
  const weekendNote = policy.employeeDeadlinesExcludeWeekend ? 'عدا العطل الرسمية ونهاية الأسبوع' : 'عدا العطل الرسمية';
  if (code === 'submit') await notify({ userIds: approvers, type: 'discipline.pending', bodyAr: `${doc.kindLabelAr} — ${employee?.fullNameAr ?? ''} (${doc.number})`, link: `/hr/discipline/${doc._id}` });
  if (code === 'deliver') await notify({ userIds: subject, type: 'discipline.delivered', bodyAr: `${doc.kindLabelAr} (${doc.number}) — يمكنك التظلم خلال ${policy.appealDays} يوماً ${weekendNote} (حتى ${riyadhDate(doc.appealDeadline!)})`, link: '/me/performance' });
  if (code === 'appeal') await notify({ userIds: approvers, type: 'discipline.appealed', bodyAr: `${doc.number} — ${employee?.fullNameAr ?? ''}: ${opts.note ?? ''} — يُبت فيه كتابياً قبل ${riyadhDate(doc.appealDecisionDueAt!)}`, link: `/hr/discipline/${doc._id}` });
  if (code === 'reject_appeal')
    await notify({ userIds: subject, type: 'discipline.appeal_rejected', bodyAr: `${doc.kindLabelAr} (${doc.number}): ${opts.note ?? ''} — لك الاعتراض أمام المحكمة العمالية خلال ${policy.courtObjectionDays} يوماً ${weekendNote} (حتى ${riyadhDate(doc.courtObjectionDeadline!)})؛ لا يُنفَّذ الجزاء قبل ذلك`, link: '/me/performance' });
  if (code === 'court_objection') await notify({ userIds: [...approvers, ...subject], type: 'discipline.court_objection', bodyAr: `${doc.kindLabelAr} (${doc.number}) — ${opts.note ?? ''}؛ الجزاء موقوف حتى تسجيل الحكم`, link: `/hr/discipline/${doc._id}` });
  if (code === 'court_uphold' || code === 'court_cancel' || code === 'finalize')
    await notify({ userIds: subject, type: 'discipline.final', bodyAr: `${doc.kindLabelAr} (${doc.number}) — ${doc.state === 'upheld' ? 'أصبح الجزاء نهائياً' : 'أُلغي الجزاء'}${opts.note ? `: ${opts.note}` : ''}`, link: '/me/performance' });
  return doc;
}

// ==================================================================================================
// Jobs and handlers
// ==================================================================================================
/** Daily: open the cycles whose opening day arrived; remind managers before the due date. */
export async function runAppraisalJobs(now = new Date()): Promise<{ opened: number; reminders: number }> {
  const today = riyadhDate(now);
  let opened = 0;
  for (const c of await AppraisalCycle.find({ state: 'planned', opensAt: { $lte: today } })) {
    await openCycle(c, SYSTEM_ACTOR);
    opened++;
  }
  const policy = await getSetting('hr.appraisal');
  const horizon = new Date(now.getTime() + policy.dueReminderDays * 86_400_000);
  const due = await Appraisal.find({ state: { $in: ['open', 'returned'] }, dueAt: { $lte: horizon }, dueReminderSentAt: null, managerUserId: { $ne: null } });
  for (const a of due) {
    const e = await Employee.findById(a.employeeId).select('fullNameAr').lean();
    await notify({ userIds: [String(a.managerUserId)], type: 'appraisal.due', bodyAr: `تقييم ${e?.fullNameAr ?? ''} يُسلَّم قبل ${riyadhDate(a.dueAt!)}`, link: '/manager/appraisals' });
    await Appraisal.updateOne({ _id: a._id }, { $set: { dueReminderSentAt: now } });
  }
  return { opened, reminders: due.length };
}

/**
 * Daily: a review reminder to the plan owner every 30 days from the start; the disciplinary clocks of art. 72 —
 * (1) auto-uphold an undisputed action after the appeal window; (2) an appeal undecided after `appealDecisionDays`
 * is escalated to the HR manager and its court-objection window starts from the end of the decision window;
 * (3) an action whose court-objection window ended without a recorded objection becomes final (owner decisions 2026-11-25).
 */
export async function runPerformanceFollowUps(now = new Date()): Promise<{ planReminders: number; upheld: number; escalated: number; finalized: number }> {
  const today = riyadhDate(now);
  let planReminders = 0;
  for (const p of await ImprovementPlan.find({ state: 'active', to: { $gte: today } })) {
    const days = Math.floor((now.getTime() - dayStart(p.from).getTime()) / 86_400_000);
    if (days <= 0 || days % 30 !== 0 || p.reviewReminderSentOn === today) continue;
    const e = await Employee.findById(p.employeeId).select('fullNameAr').lean();
    await notify({ userIds: [String(p.ownerUserId), ...(p.hrFollowerUserId ? [String(p.hrFollowerUserId)] : [])], type: 'improvement.review_due', bodyAr: `مراجعة خطة تحسين أداء ${e?.fullNameAr ?? ''} (حتى ${p.to})`, link: `/hr/performance/plans/${p._id}` });
    await ImprovementPlan.updateOne({ _id: p._id }, { $set: { reviewReminderSentOn: today } });
    planReminders++;
  }
  const admin = await User.findOne({ 'roles.role': 'hr_manager', status: 'active' });
  let upheld = 0;
  for (const d of await DisciplinaryAction.find({ state: 'delivered', appealDeadline: { $lt: now } })) {
    if (!admin) break;
    await transitionDisciplinary(d, 'uphold', { user: admin, actor: SYSTEM_ACTOR, note: 'انتهت مهلة التظلم دون تظلم' });
    upheld++;
  }
  // (2) Escalation of an undecided appeal (owner decision 2026-11-25): the HR managers are notified, the task moves to one of them,
  // and the court-objection window starts from the end of the decision window (the earlier of the two starts).
  let escalated = 0;
  const { policy } = await disciplinePolicy();
  const holidays = await loadHolidaySet();
  for (const d of await DisciplinaryAction.find({ state: 'appealed', appealDecisionDueAt: { $lt: now }, appealEscalatedAt: null })) {
    const hrManagers = (await User.find({ 'roles.role': 'hr_manager', status: 'active' }).select('_id').lean()).map((u) => String(u._id));
    const assignee = hrManagers.find((id) => id !== String(d.issuedBy)) ?? hrManagers[0];
    const courtObjectionDeadline = d.courtObjectionDeadline ?? employeeDeadlineFrom(riyadhDate(d.appealDecisionDueAt!), policy.courtObjectionDays, holidays, policy.employeeDeadlinesExcludeWeekend);
    await DisciplinaryAction.updateOne({ _id: d._id }, { $set: { appealEscalatedAt: now, courtObjectionDeadline } });
    if (d.appealTaskId && assignee) {
      const task = await Task.findOneAndUpdate({ _id: d.appealTaskId, status: { $nin: ['done', 'cancelled'] } }, { $set: { assigneeId: assignee, priority: 'high', reviewNote: `تجاوز البت في التظلم مهلة ${policy.appealDecisionDays} يوماً (المادة 72) — أُحيلت المهمة إلى مدير الموارد البشرية` } }, { new: false }).lean();
      if (task) await TaskEvent.create({ taskId: task._id, type: 'reassigned', fromAssigneeId: task.assigneeId, toAssigneeId: assignee, note: 'إحالة تلقائية: تجاوز مهلة البت في التظلم (المادة 72)', actorEmail: 'system', at: now });
    }
    const e = await Employee.findById(d.employeeId).select('fullNameAr').lean();
    await notify({ userIds: hrManagers, type: 'discipline.appeal_escalated', bodyAr: `${d.kindLabelAr} (${d.number}) — ${e?.fullNameAr ?? ''}: لم يُبت في التظلم خلال ${policy.appealDecisionDays} يوماً؛ مهلة الاعتراض أمام المحكمة تسري حتى ${riyadhDate(courtObjectionDeadline)}`, link: `/hr/discipline/${d._id}` });
    await event('disciplinary', d._id, 'appeal_escalated', SYSTEM_ACTOR, { note: `انتهت مهلة البت (${riyadhDate(d.appealDecisionDueAt!)}) دون قرار` });
    escalated++;
  }
  // (3) The court-objection window ended without a recorded objection → the penalty is final (a fine reaches payroll now).
  let finalized = 0;
  for (const d of await DisciplinaryAction.find({ state: { $in: ['objection_window', 'appealed'] }, courtObjectionDeadline: { $lt: now } })) {
    if (!admin) break;
    await transitionDisciplinary(d, 'finalize', { user: admin, actor: SYSTEM_ACTOR, note: 'انتهت مهلة الاعتراض أمام المحكمة دون تسجيل اعتراض' });
    finalized++;
  }
  return { planReminders, upheld, escalated, finalized };
}

let registered = false;
/** A manager change moves the open appraisals to the new manager (DECISIONS §11.4). */
export function registerPerformanceHandlers(): void {
  if (registered) return;
  registered = true;
  registerManagerChangeHandler(async ({ employee, toManagerUserId }) => {
    const r = await Appraisal.updateMany({ employeeId: employee._id, state: { $in: ['open', 'returned', 'manager_submitted'] } }, { $set: { managerUserId: toManagerUserId ?? null } });
    return r.modifiedCount;
  });
}
