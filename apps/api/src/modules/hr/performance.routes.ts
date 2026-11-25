import { Router } from 'express';
import type { z } from 'zod';
import {
  appraisalTemplateSchema,
  appraisalTransitionSchema,
  createAppraisalCycleSchema,
  createDisciplinarySchema,
  createGoalSchema,
  createImprovementPlanSchema,
  disciplinaryTransitionSchema,
  goalProgressSchema,
  improvementCloseSchema,
  improvementReviewSchema,
  listAppraisalsQuerySchema,
  scoreAppraisalSchema,
  updateGoalSchema,
} from '@eayni/shared';
import { asyncHandler } from '../../core/http/async';
import { validate } from '../../core/http/validate';
import { actorFrom, type AuthedRequest } from '../../core/http/context';
import { badRequest, forbidden, notFound } from '../../core/http/errors';
import { requireAuth } from '../../core/auth/middleware';
import { authorize } from '../../core/rbac/authorize';
import { recordAudit } from '../../core/audit/service';
import { getSettingMeta } from '../../core/settings/service';
import { listKpiDefinitions } from '../../core/kpi/registry';
import { StageLog } from '../../core/workflow/model';
import { Employee } from './model';
import { employeeOfUser } from './service';
import { allInScope, scopedEmployeeIds } from './scope';
import { Appraisal, AppraisalCycle, AppraisalTemplate, DisciplinaryAction, Goal, ImprovementPlan, PerformanceEvent } from './performance.model';
import * as perf from './performance.service';

export const performanceRouter = Router();
export const disciplineRouter = Router();

const HR_ROLES = ['hr_officer', 'hr_manager'];
const isHr = (req: AuthedRequest) => req.auth.roleCodes.some((c) => HR_ROLES.includes(c));
const employeeNames = async (ids: unknown[]) => {
  const rows = await Employee.find({ _id: { $in: ids } }).select('fullNameAr employeeNumber departmentId positionId').lean();
  return new Map(rows.map((e) => [String(e._id), e]));
};

// ---------- KPI registry (goals link to department KPIs) ----------
performanceRouter.get(
  '/kpis',
  requireAuth(),
  asyncHandler(async (_req, res) => {
    res.json({ items: listKpiDefinitions() });
  }),
);

// ---------- my performance page ----------
performanceRouter.get(
  '/me',
  requireAuth(),
  authorize('hr.goals', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const e = await employeeOfUser(String(req.auth.user._id));
    if (!e) throw badRequest('لا يوجد ملف موظف مرتبط بحسابك');
    const [goals, appraisals, plans, actions] = await Promise.all([
      Goal.find({ employeeId: e._id, deletedAt: null }).sort({ createdAt: -1 }).lean(),
      Appraisal.find({ employeeId: e._id, state: { $in: ['approved', 'acknowledged'] } }).sort({ approvedAt: -1 }).lean(),
      ImprovementPlan.find({ employeeId: e._id }).sort({ createdAt: -1 }).lean(),
      DisciplinaryAction.find({ employeeId: e._id, deletedAt: null, state: { $in: ['delivered', 'appealed', 'objection_window', 'court_objection', 'upheld'] } }).sort({ deliveredAt: -1 }).lean(),
    ]);
    const cycles = await AppraisalCycle.find({ _id: { $in: appraisals.map((a) => a.cycleId) } }).select('nameAr year kind').lean();
    const cycleName = new Map(cycles.map((c) => [String(c._id), c.nameAr]));
    res.json({
      goals,
      appraisals: appraisals.map((a) => ({ ...a, cycleName: cycleName.get(String(a.cycleId)), actions: a.state === 'approved' ? ['acknowledge'] : [] })),
      plans,
      disciplinaryActions: actions.map((d) => ({ ...d, evidenceAttachmentIds: undefined })),
    });
  }),
);

// ---------- goals [HR §3.7] ----------
performanceRouter.get(
  '/goals',
  requireAuth(),
  authorize('hr.goals', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const ids = await scopedEmployeeIds(req, employeeId);
    const f: Record<string, unknown> = { deletedAt: null };
    if (ids) f.employeeId = { $in: ids };
    if (typeof req.query.cycleId === 'string') f.cycleId = req.query.cycleId;
    if (typeof req.query.state === 'string') f.state = req.query.state;
    const items = await Goal.find(f).sort({ createdAt: -1 }).limit(500).lean();
    const names = await employeeNames(items.map((g) => g.employeeId));
    res.json({ items: items.map((g) => ({ ...g, employee: names.get(String(g.employeeId)) })) });
  }),
);
performanceRouter.post(
  '/goals',
  requireAuth(),
  authorize('hr.goals', 'create'),
  validate(createGoalSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = req.body as z.infer<typeof createGoalSchema>;
    if (!(await allInScope(req, [body.employeeId]))) throw notFound('الموظف غير موجود');
    res.status(201).json(await perf.createGoal(body, actorFrom(req)));
  }),
);
performanceRouter.patch(
  '/goals/:id',
  requireAuth(),
  authorize('hr.goals', 'edit'),
  validate(updateGoalSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const goal = await Goal.findOne({ _id: req.params.id, deletedAt: null });
    if (!goal || !(await allInScope(req, [String(goal.employeeId)]))) throw notFound('الهدف غير موجود');
    res.json(await perf.updateGoal(req.params.id, req.body as Record<string, unknown>, actorFrom(req)));
  }),
);
/** «متابعة نسبة الإنجاز»: the employee updates their own progress; the manager and HR may too. */
performanceRouter.post(
  '/goals/:id/progress',
  requireAuth(),
  authorize('hr.goals', 'view'),
  validate(goalProgressSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const goal = await Goal.findOne({ _id: req.params.id, deletedAt: null });
    if (!goal || !(await allInScope(req, [String(goal.employeeId)]))) throw notFound('الهدف غير موجود');
    const body = req.body as z.infer<typeof goalProgressSchema>;
    res.json(await perf.addGoalProgress(req.params.id, body.percent, body.note, actorFrom(req)));
  }),
);

// ---------- templates and cycles ----------
performanceRouter.get(
  '/templates',
  requireAuth(),
  authorize('hr.appraisals', 'view'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await AppraisalTemplate.find({ deletedAt: null }).sort({ active: -1, version: -1 }).lean() });
  }),
);
performanceRouter.post(
  '/templates',
  requireAuth(),
  authorize('hr.appraisals', 'edit'),
  validate(appraisalTemplateSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    res.status(201).json(await perf.saveTemplate(req.body as z.infer<typeof appraisalTemplateSchema>, actorFrom(req)));
  }),
);
performanceRouter.put(
  '/templates/:id',
  requireAuth(),
  authorize('hr.appraisals', 'edit'),
  validate(appraisalTemplateSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    res.json(await perf.saveTemplate(req.body as z.infer<typeof appraisalTemplateSchema>, actorFrom(req), req.params.id));
  }),
);
performanceRouter.get(
  '/cycles',
  requireAuth(),
  authorize('hr.appraisals', 'view'),
  asyncHandler(async (_req, res) => {
    const items = await AppraisalCycle.find().sort({ year: -1, from: -1 }).lean();
    const counts = await Appraisal.aggregate<{ _id: { cycleId: unknown; state: string }; n: number }>([{ $group: { _id: { cycleId: '$cycleId', state: '$state' }, n: { $sum: 1 } } }]);
    const policy = await getSettingMeta('hr.appraisal');
    res.json({
      items: items.map((c) => ({
        ...c,
        templateSnapshot: undefined,
        counts: Object.fromEntries(counts.filter((x) => String(x._id.cycleId) === String(c._id)).map((x) => [x._id.state, x.n])),
      })),
      policy: policy.value,
      provisional: policy.provisional,
    });
  }),
);
performanceRouter.post(
  '/cycles',
  requireAuth(),
  authorize('hr.appraisals', 'edit'),
  validate(createAppraisalCycleSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    res.status(201).json(await perf.createCycle(req.body as z.infer<typeof createAppraisalCycleSchema>, actorFrom(req)));
  }),
);
performanceRouter.post(
  '/cycles/:id/open',
  requireAuth(),
  authorize('hr.appraisals', 'edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    const cycle = await AppraisalCycle.findById(req.params.id);
    if (!cycle) throw notFound('الدورة غير موجودة');
    res.json(await perf.openCycle(cycle, actorFrom(req)));
  }),
);
performanceRouter.post(
  '/cycles/:id/close',
  requireAuth(),
  authorize('hr.appraisals', 'edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    const cycle = await AppraisalCycle.findById(req.params.id);
    if (!cycle) throw notFound('الدورة غير موجودة');
    res.json(await perf.closeCycle(cycle, actorFrom(req)));
  }),
);

// ---------- appraisals ----------
performanceRouter.get(
  '/appraisals',
  requireAuth(),
  authorize('hr.appraisals', 'view'),
  validate(listAppraisalsQuerySchema, 'query'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = req.query as unknown as z.infer<typeof listAppraisalsQuerySchema>;
    const user = req.auth.user;
    const f: Record<string, unknown> = {};
    if (q.cycleId) f.cycleId = q.cycleId;
    if (q.state) f.state = q.state;
    if (q.view === 'team') f.managerUserId = user._id;
    else {
      const ids = await scopedEmployeeIds(req, q.employeeId);
      if (ids) f.employeeId = { $in: ids };
      // An employee sees their own appraisal only once approved (HR_PLAN §6).
      if (req.authz!.scope === 'own') f.state = q.state && ['approved', 'acknowledged'].includes(q.state) ? q.state : { $in: ['approved', 'acknowledged'] };
    }
    const [items, total] = await Promise.all([Appraisal.find(f).sort({ dueAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Appraisal.countDocuments(f)]);
    const names = await employeeNames(items.map((a) => a.employeeId));
    const cycles = await AppraisalCycle.find({ _id: { $in: items.map((a) => a.cycleId) } }).select('nameAr dueAt').lean();
    const cn = new Map(cycles.map((c) => [String(c._id), c.nameAr]));
    res.json({ items: items.map((a) => ({ ...a, employee: names.get(String(a.employeeId)), cycleName: cn.get(String(a.cycleId)) })), total, page: q.page, limit: q.limit });
  }),
);
async function visibleAppraisal(req: AuthedRequest, id: string) {
  const a = await Appraisal.findById(id);
  if (!a) throw notFound('التقييم غير موجود');
  const rel = await perf.relationsForAppraisal(req.auth.user, a);
  if (rel.includes('subject') && !['approved', 'acknowledged'].includes(a.state)) throw notFound('التقييم غير موجود');
  if (!rel.includes('subject') && !rel.includes('direct_manager') && !(await allInScope(req, [String(a.employeeId)]))) throw notFound('التقييم غير موجود');
  return a;
}
performanceRouter.get(
  '/appraisals/:id',
  requireAuth(),
  authorize('hr.appraisals', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await visibleAppraisal(req, req.params.id);
    const [cycle, employee, events, stages, plan] = await Promise.all([
      AppraisalCycle.findById(a.cycleId).lean(),
      Employee.findById(a.employeeId).select('fullNameAr employeeNumber departmentId positionId').lean(),
      PerformanceEvent.find({ recordType: 'appraisal', recordId: a._id }).sort({ at: 1 }).lean(),
      StageLog.find({ recordType: 'hr_appraisal', recordId: String(a._id) }).sort({ at: 1 }).lean(),
      a.improvementPlanId ? ImprovementPlan.findById(a.improvementPlanId).lean() : null,
    ]);
    const rel = await perf.relationsForAppraisal(req.auth.user, a);
    if (!rel.includes('subject') && !rel.includes('direct_manager')) await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.appraisals', resourceId: String(a._id), sensitive: true });
    res.json({ ...a.toObject(), employee, cycle: cycle ? { _id: cycle._id, nameAr: cycle.nameAr, from: cycle.from, to: cycle.to, dueAt: cycle.dueAt, template: cycle.templateSnapshot } : null, events, stages, plan, actions: await perf.availableAppraisalActions(req.auth.user, a), canScore: rel.includes('direct_manager') && ['open', 'returned'].includes(a.state) });
  }),
);
performanceRouter.post(
  '/appraisals/:id/score',
  requireAuth(),
  authorize('hr.appraisals', 'view'),
  validate(scoreAppraisalSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await visibleAppraisal(req, req.params.id);
    const body = req.body as z.infer<typeof scoreAppraisalSchema>;
    res.json(await perf.scoreAppraisal(a, req.auth.user, body.scores, body.managerNotes, actorFrom(req)));
  }),
);
performanceRouter.post(
  '/appraisals/:id/transition',
  requireAuth(),
  authorize('hr.appraisals', 'view'),
  validate(appraisalTransitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await visibleAppraisal(req, req.params.id);
    const body = req.body as z.infer<typeof appraisalTransitionSchema>;
    const r = await perf.transitionAppraisal(a, body.transition, { user: req.auth.user, actor: actorFrom(req), reason: body.reason, hrNotes: body.hrNotes, employeeComment: body.employeeComment });
    res.json({ ...r.appraisal.toObject(), offerImprovementPlan: r.offerImprovementPlan, actions: await perf.availableAppraisalActions(req.auth.user, r.appraisal) });
  }),
);

// ---------- improvement plans ----------
performanceRouter.get(
  '/plans',
  requireAuth(),
  authorize('hr.improvement_plans', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const ids = await scopedEmployeeIds(req, employeeId);
    const f: Record<string, unknown> = {};
    if (ids) f.employeeId = { $in: ids };
    if (typeof req.query.state === 'string') f.state = req.query.state;
    const items = await ImprovementPlan.find(f).sort({ createdAt: -1 }).limit(500).lean();
    const names = await employeeNames(items.map((p) => p.employeeId));
    res.json({ items: items.map((p) => ({ ...p, employee: names.get(String(p.employeeId)) })) });
  }),
);
performanceRouter.post(
  '/plans',
  requireAuth(),
  authorize('hr.improvement_plans', 'create'),
  validate(createImprovementPlanSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = req.body as z.infer<typeof createImprovementPlanSchema>;
    if (!(await allInScope(req, [body.employeeId]))) throw notFound('الموظف غير موجود');
    res.status(201).json(await perf.createImprovementPlan(body, req.auth.user, actorFrom(req)));
  }),
);
performanceRouter.get(
  '/plans/:id',
  requireAuth(),
  authorize('hr.improvement_plans', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const p = await ImprovementPlan.findById(req.params.id).lean();
    if (!p || !(await allInScope(req, [String(p.employeeId)]))) throw notFound('الخطة غير موجودة');
    const [employee, events] = await Promise.all([Employee.findById(p.employeeId).select('fullNameAr employeeNumber').lean(), PerformanceEvent.find({ recordType: 'improvement_plan', recordId: p._id }).sort({ at: 1 }).lean()]);
    res.json({ ...p, employee, events });
  }),
);
performanceRouter.post(
  '/plans/:id/reviews',
  requireAuth(),
  authorize('hr.improvement_plans', 'edit'),
  validate(improvementReviewSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const p = await ImprovementPlan.findById(req.params.id).lean();
    if (!p || !(await allInScope(req, [String(p.employeeId)]))) throw notFound('الخطة غير موجودة');
    res.json(await perf.reviewImprovementPlan(req.params.id, req.body as z.infer<typeof improvementReviewSchema>, actorFrom(req)));
  }),
);
performanceRouter.post(
  '/plans/:id/close',
  requireAuth(),
  authorize('hr.improvement_plans', 'edit'),
  validate(improvementCloseSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const p = await ImprovementPlan.findById(req.params.id).lean();
    if (!p || !(await allInScope(req, [String(p.employeeId)]))) throw notFound('الخطة غير موجودة');
    const body = req.body as z.infer<typeof improvementCloseSchema>;
    res.json(await perf.closeImprovementPlan(req.params.id, body.state, body.note, actorFrom(req)));
  }),
);

// ---------- disciplinary actions [HR §3.7 «وفق الصلاحيات»] ----------
disciplineRouter.get(
  '/policy',
  requireAuth(),
  asyncHandler(async (_req, res) => {
    const { policy, provisional } = await perf.disciplinePolicy();
    res.json({ ...policy, provisional });
  }),
);
disciplineRouter.get(
  '/',
  requireAuth(),
  authorize('hr.discipline', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const ids = await scopedEmployeeIds(req, employeeId);
    const f: Record<string, unknown> = { deletedAt: null };
    if (ids) f.employeeId = { $in: ids };
    if (typeof req.query.state === 'string') f.state = req.query.state;
    // An employee sees only what was delivered to them (HR_PLAN §6).
    if (req.authz!.scope === 'own') f.state = { $in: ['delivered', 'appealed', 'objection_window', 'court_objection', 'upheld'] };
    const items = await DisciplinaryAction.find(f).sort({ createdAt: -1 }).limit(500).lean();
    const names = await employeeNames(items.map((d) => d.employeeId));
    if (req.authz!.scope !== 'own' && items.length) await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.discipline', sensitive: true, meta: { count: items.length } });
    res.json({ items: items.map((d) => ({ ...d, employee: names.get(String(d.employeeId)) })) });
  }),
);
disciplineRouter.post(
  '/',
  requireAuth(),
  authorize('hr.discipline', 'create'),
  validate(createDisciplinarySchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = req.body as z.infer<typeof createDisciplinarySchema>;
    if (!(await allInScope(req, [body.employeeId]))) throw notFound('الموظف غير موجود');
    res.status(201).json(await perf.createDisciplinary(body, req.auth.user, actorFrom(req)));
  }),
);
async function visibleAction(req: AuthedRequest, id: string) {
  const d = await DisciplinaryAction.findOne({ _id: id, deletedAt: null });
  if (!d) throw notFound('الإجراء غير موجود');
  const { policy } = await perf.disciplinePolicy();
  const rel = await perf.relationsForDiscipline(req.auth.user, d, policy);
  if (rel.includes('subject')) {
    if (!['delivered', 'appealed', 'objection_window', 'court_objection', 'upheld'].includes(d.state)) throw notFound('الإجراء غير موجود');
    return { d, rel };
  }
  if (!rel.includes('issuer') && !rel.includes('approver') && !(await allInScope(req, [String(d.employeeId)]))) throw notFound('الإجراء غير موجود');
  return { d, rel };
}
disciplineRouter.get(
  '/:id',
  requireAuth(),
  authorize('hr.discipline', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { d, rel } = await visibleAction(req, req.params.id);
    const [employee, events, stages] = await Promise.all([
      Employee.findById(d.employeeId).select('fullNameAr employeeNumber departmentId').lean(),
      PerformanceEvent.find({ recordType: 'disciplinary', recordId: d._id }).sort({ at: 1 }).lean(),
      StageLog.find({ recordType: 'hr_disciplinary', recordId: String(d._id) }).sort({ at: 1 }).lean(),
    ]);
    if (!rel.includes('subject')) await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.discipline', resourceId: String(d._id), sensitive: true });
    res.json({ ...d.toObject(), employee, events, stages, actions: await perf.availableDisciplineActions(req.auth.user, d) });
  }),
);
disciplineRouter.post(
  '/:id/transition',
  requireAuth(),
  authorize('hr.discipline', 'view'),
  validate(disciplinaryTransitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { d } = await visibleAction(req, req.params.id);
    const body = req.body as z.infer<typeof disciplinaryTransitionSchema>;
    const doc = await perf.transitionDisciplinary(d, body.transition, { user: req.auth.user, actor: actorFrom(req), note: body.note });
    res.json({ ...doc.toObject(), actions: await perf.availableDisciplineActions(req.auth.user, doc) });
  }),
);

