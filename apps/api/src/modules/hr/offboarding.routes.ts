import { Router } from 'express';
import type { z } from 'zod';
import {
  ART80_CASES,
  ART81_CASES,
  createOffboardingSchema,
  custodyReturnStepSchema,
  EOS_REASON_AR,
  EOS_REASONS,
  exitInterviewSchema,
  itClosureSchema,
  listOffboardingsQuerySchema,
  offboardingTransitionSchema,
  pregnancyRecordSchema,
  resignSchema,
  settlementActionSchema,
} from '@eayni/shared';
import { asyncHandler } from '../../core/http/async';
import { validate } from '../../core/http/validate';
import { actorFrom, type AuthedRequest } from '../../core/http/context';
import { badRequest, forbidden, notFound } from '../../core/http/errors';
import { requireAuth } from '../../core/auth/middleware';
import { authorize } from '../../core/rbac/authorize';
import { recordAudit } from '../../core/audit/service';
import { getSetting } from '../../core/settings/service';
import { StageLog } from '../../core/workflow/model';
import { Department } from '../../core/org/model';
import { Contract, Custody, Employee } from './model';
import { Offboarding, OffboardingEvent } from './offboarding.model';
import { employeeOfUser } from './service';
import * as eos from './offboarding.service';
import { z as zod } from 'zod';

/** End of service [HR §3.10]: `/hr/offboarding/*` (HR), `/me/offboarding` (the employee), `/it/offboarding` (IT), `/finance/settlements` (Finance). */
export const offboardingRouter = Router();
export const myOffboardingRouter = Router();
export const itOffboardingRouter = Router();
export const financeSettlementsRouter = Router();
const HR_ROLES = ['hr_officer', 'hr_manager'];
const isHr = (req: AuthedRequest) => req.auth.user.roles.some((r) => HR_ROLES.includes(r.role));

async function detail(req: AuthedRequest, o: InstanceType<typeof Offboarding>) {
  const [employee, contract, events, stages, custody, dept] = await Promise.all([
    Employee.findById(o.employeeId).select('fullNameAr employeeNumber departmentId positionId nationality gender hireDate endDate status userId directManagerId').lean(),
    o.contractId ? Contract.findById(o.contractId).select('number type startDate endDate probationEndDate wagePeriod nonCompete awardExcludesVariableWage awardExclusionClauseRef originalStartDate').lean() : null,
    OffboardingEvent.find({ offboardingId: o._id }).sort({ at: 1 }).lean(),
    StageLog.find({ recordType: 'hr_offboarding', recordId: String(o._id) }).sort({ at: 1 }).lean(),
    Custody.find({ employeeId: o.employeeId }).select('itemName assetTag returnedAt condition').lean(),
    Department.findById(o.departmentId).select('nameAr').lean(),
  ]);
  const isSubject = !!employee?.userId && String(employee.userId) === String(req.auth.user._id);
  return {
    ...eos.redact(o.toObject() as Record<string, unknown>, req.auth.user, isSubject),
    employee,
    contract,
    departmentName: dept?.nameAr,
    custody,
    events,
    stages,
    actions: await eos.availableActions(req.auth.user, o),
    reasonLabel: EOS_REASON_AR[o.reason as keyof typeof EOS_REASON_AR],
  };
}
async function offboardingOrThrow(req: AuthedRequest, id: string) {
  const o = await Offboarding.findOne({ _id: id, deletedAt: null });
  if (!o) throw notFound('سجل إنهاء الخدمة غير موجود');
  const me = await employeeOfUser(String(req.auth.user._id));
  const filter = eos.visibilityFilter(req.auth.user, req.authz!, me?._id);
  if (Object.keys(filter).length && !(await Offboarding.exists({ _id: o._id, ...filter }))) throw notFound('سجل إنهاء الخدمة غير موجود');
  return o;
}

// ---------- reference data ----------
offboardingRouter.get(
  '/policy',
  requireAuth(),
  authorize('hr.offboarding', 'view'),
  asyncHandler(async (_req, res) => {
    const { policy, provisional } = await eos.eosPolicy();
    const [template, warnNotice, legal] = await Promise.all([getSetting('hr.exitInterview.template'), getSetting('hr.offboarding.warnNoticeDuringLeave'), eos.legalSettingsStatus()]);
    res.json({
      policy,
      provisional,
      reasons: EOS_REASONS.map((code) => ({ code, labelAr: EOS_REASON_AR[code] })),
      art80Cases: ART80_CASES,
      art81Cases: ART81_CASES,
      exitInterviewTemplate: template,
      warnNoticeDuringLeave: warnNotice,
      legalSettings: legal,
    });
  }),
);
offboardingRouter.get(
  '/legal-settings',
  requireAuth(),
  authorize('hr.offboarding', 'view'),
  asyncHandler(async (_req, res) => res.json(await eos.legalSettingsStatus())),
);

// ---------- list / create / detail / transition ----------
offboardingRouter.get(
  '/',
  requireAuth(),
  authorize('hr.offboarding', 'view'),
  validate(listOffboardingsQuerySchema, 'query'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = req.query as unknown as z.infer<typeof listOffboardingsQuerySchema>;
    const me = await employeeOfUser(String(req.auth.user._id));
    const f: Record<string, unknown> = { deletedAt: null, ...eos.visibilityFilter(req.auth.user, req.authz!, me?._id) };
    if (q.state) f.state = q.state;
    if (q.open) f.closedAt = null;
    if (q.employeeId) f.employeeId = q.employeeId;
    const [items, total] = await Promise.all([Offboarding.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Offboarding.countDocuments(f)]);
    const emps = new Map((await Employee.find({ _id: { $in: items.map((i) => i.employeeId) } }).select('fullNameAr employeeNumber').lean()).map((e) => [String(e._id), e]));
    res.json({
      items: items.map((o) => ({ ...eos.redact(o, req.auth.user, !!me && String(me._id) === String(o.employeeId)), employee: emps.get(String(o.employeeId)), reasonLabel: EOS_REASON_AR[o.reason as keyof typeof EOS_REASON_AR] })),
      total,
      page: q.page,
      limit: q.limit,
    });
  }),
);
offboardingRouter.post(
  '/',
  requireAuth(),
  authorize('hr.offboarding', 'create'),
  validate(createOffboardingSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await eos.createOffboarding(req.body as z.infer<typeof createOffboardingSchema>, req.auth.user, actorFrom(req));
    res.status(201).json(await detail(req, o));
  }),
);
/** E6 preview: what the attendance record says about art. 80(7) for an employee today — before HR files the dismissal. */
offboardingRouter.get(
  '/art80-absence/:employeeId',
  requireAuth(),
  authorize('hr.offboarding', 'create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const e = await Employee.findOne({ _id: req.params.employeeId, deletedAt: null });
    if (!e) throw notFound();
    const c = await Contract.findOne({ employeeId: e._id }).sort({ version: -1 }).lean();
    const { art80AbsenceCheck } = await import('./legal.service');
    const { riyadhDate } = await import('../../core/dates/businessDays');
    res.json(await art80AbsenceCheck(e, c?.originalStartDate ?? c?.startDate ?? e.hireDate, typeof req.query.day === 'string' ? req.query.day : riyadhDate(new Date())));
  }),
);
offboardingRouter.get(
  '/:id',
  requireAuth(),
  authorize('hr.offboarding', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await offboardingOrThrow(req, req.params.id);
    if (isHr(req)) await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.offboarding', resourceId: String(o._id), sensitive: true });
    res.json(await detail(req, o));
  }),
);
offboardingRouter.post(
  '/:id/transition',
  requireAuth(),
  authorize('hr.offboarding', 'view'),
  validate(offboardingTransitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await offboardingOrThrow(req, req.params.id);
    const body = req.body as z.infer<typeof offboardingTransitionSchema>;
    res.json(await detail(req, await eos.transitionOffboarding(o, body.transition, { user: req.auth.user, actor: actorFrom(req), reason: body.reason, postponedUntil: body.postponedUntil, lastWorkingDay: body.lastWorkingDay })));
  }),
);

// ---------- step 4: settlement ----------
offboardingRouter.post(
  '/:id/settlement',
  requireAuth(),
  authorize('hr.offboarding', 'edit'),
  validate(settlementActionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await offboardingOrThrow(req, req.params.id);
    const body = req.body as z.infer<typeof settlementActionSchema>;
    const user = req.auth.user;
    const actor = actorFrom(req);
    let r: InstanceType<typeof Offboarding>;
    if (body.action === 'compute') r = await eos.computeSettlement(o, user, actor);
    else if (body.action === 'edit_line') {
      if (!body.line) throw badRequest('البند مطلوب');
      r = await eos.editSettlementLine(o, body.line, user, actor);
    } else if (body.action === 'approve') r = await eos.approveSettlement(o, user, actor);
    else r = await eos.recordSettlementPayment(o, { paidAt: body.paidAt, paymentRef: body.paymentRef, proofAttachmentId: body.proofAttachmentId, note: body.note }, user, actor);
    res.json(await detail(req, r));
  }),
);
// ---------- step 5: custody ----------
offboardingRouter.post(
  '/:id/custody',
  requireAuth(),
  authorize('hr.offboarding', 'edit'),
  validate(custodyReturnStepSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await offboardingOrThrow(req, req.params.id);
    res.json(await detail(req, await eos.returnCustodyStep(o, req.body as z.infer<typeof custodyReturnStepSchema>, req.auth.user, actorFrom(req))));
  }),
);
// ---------- step 7: exit interview ----------
offboardingRouter.post(
  '/:id/exit-interview',
  requireAuth(),
  authorize('hr.offboarding', 'edit'),
  validate(exitInterviewSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await offboardingOrThrow(req, req.params.id);
    res.json(await detail(req, await eos.recordExitInterview(o, req.body as z.infer<typeof exitInterviewSchema>, req.auth.user, actorFrom(req))));
  }),
);
// ---------- step 8: certificate (E19) ----------
offboardingRouter.post(
  '/:id/certificate',
  requireAuth(),
  authorize('hr.offboarding', 'edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await offboardingOrThrow(req, req.params.id);
    res.json(await detail(req, await eos.issueExperienceCertificate(o, req.auth.user, actorFrom(req))));
  }),
);
// ---------- E22: government exit ----------
const govExitSchema = zod.object({ gosiExitRef: zod.string().trim().max(60).optional(), gosiExitAt: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), qiwaExitRef: zod.string().trim().max(60).optional(), qiwaExitAt: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), finalExitRef: zod.string().trim().max(60).optional() });
offboardingRouter.post(
  '/:id/gov-exit',
  requireAuth(),
  authorize('hr.offboarding', 'edit'),
  validate(govExitSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await offboardingOrThrow(req, req.params.id);
    res.json(await detail(req, await eos.recordGovExit(o, req.body as z.infer<typeof govExitSchema>, req.auth.user, actorFrom(req))));
  }),
);
// ---------- E26: pregnancy record on the file (HR, sensitive) ----------
offboardingRouter.put(
  '/pregnancy/:employeeId',
  requireAuth(),
  authorize('hr.employees', 'edit'),
  validate(pregnancyRecordSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    const e = await Employee.findOne({ _id: req.params.employeeId, deletedAt: null });
    if (!e) throw notFound();
    const saved = await eos.setPregnancyRecord(e, req.body as z.infer<typeof pregnancyRecordSchema>, req.auth.user, actorFrom(req));
    res.json({ pregnancy: saved.pregnancy });
  }),
);

// ---------- the employee: resign (E25), see own record, withdraw ----------
myOffboardingRouter.get(
  '/',
  requireAuth(),
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = await employeeOfUser(String(req.auth.user._id));
    if (!me) throw badRequest('لا يوجد ملف موظف مرتبط بحسابك');
    const { policy } = await eos.eosPolicy();
    const items = await Offboarding.find({ employeeId: me._id, deletedAt: null }).sort({ createdAt: -1 }).lean();
    res.json({
      items: items.map((o) => ({ ...o, reasonLabel: EOS_REASON_AR[o.reason as keyof typeof EOS_REASON_AR] })),
      canResign: !items.some((o) => ['resignation_submitted', 'resignation_postponed', 'requested', 'under_review', 'approved'].includes(o.state)),
      policy: { resignationDeemedAcceptedDays: policy.resignationDeemedAcceptedDays, resignationMaxPostponeDays: policy.resignationMaxPostponeDays, resignationWithdrawDays: policy.resignationWithdrawDays },
      gender: me.gender,
    });
  }),
);
myOffboardingRouter.post(
  '/resign',
  requireAuth(),
  validate(resignSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = await employeeOfUser(String(req.auth.user._id));
    if (!me) throw badRequest('لا يوجد ملف موظف مرتبط بحسابك');
    const o = await eos.resign(me, req.body as z.infer<typeof resignSchema>, req.auth.user, actorFrom(req));
    res.status(201).json({ ...o.toObject(), actions: await eos.availableActions(req.auth.user, o) });
  }),
);
myOffboardingRouter.post(
  '/:id/withdraw',
  requireAuth(),
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = await employeeOfUser(String(req.auth.user._id));
    const o = await Offboarding.findOne({ _id: req.params.id, employeeId: me?._id, deletedAt: null });
    if (!o) throw notFound();
    const r = await eos.transitionOffboarding(o, 'withdraw_resignation', { user: req.auth.user, actor: actorFrom(req), reason: (req.body as { reason?: string })?.reason });
    res.json({ ...r.toObject(), actions: await eos.availableActions(req.auth.user, r) });
  }),
);

// ---------- IT thin stage (HR §3.10.6, IT §7.3) ----------
itOffboardingRouter.get(
  '/',
  requireAuth(),
  authorize('it.offboarding', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const all = req.query.all === 'true';
    const items = await Offboarding.find({ deletedAt: null, state: all ? { $in: ['approved', 'completed'] } : 'approved', ...(all ? {} : { 'steps.it_closure.done': { $ne: true } }) }).sort({ lastWorkingDay: 1 }).select('number employeeId departmentId lastWorkingDay state steps it custodyChecklist reason').lean();
    const emps = new Map((await Employee.find({ _id: { $in: items.map((i) => i.employeeId) } }).select('fullNameAr employeeNumber workEmail').lean()).map((e) => [String(e._id), e]));
    res.json({ items: items.map((o) => ({ ...o, employee: emps.get(String(o.employeeId)) })) });
  }),
);
itOffboardingRouter.post(
  '/:id/confirm',
  requireAuth(),
  authorize('it.offboarding', 'edit'),
  validate(itClosureSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await Offboarding.findOne({ _id: req.params.id, deletedAt: null });
    if (!o) throw notFound();
    const r = await eos.confirmItClosure(o, req.body as z.infer<typeof itClosureSchema>, req.auth.user, actorFrom(req));
    res.json({ number: r.number, it: r.it, steps: r.steps });
  }),
);

// ---------- Finance thin stage (E15, DECISIONS §22 Q2) ----------
financeSettlementsRouter.get(
  '/',
  requireAuth(),
  authorize('finance.settlements', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const all = req.query.all === 'true';
    const items = await Offboarding.find({ deletedAt: null, 'settlement.state': all ? { $in: ['at_finance', 'paid'] } : 'at_finance' }).sort({ 'settlement.dueAt': 1 }).select('number employeeId lastWorkingDay reason settlement state').lean();
    const emps = new Map((await Employee.find({ _id: { $in: items.map((i) => i.employeeId) } }).select('fullNameAr employeeNumber bank.bankName bank.ibanLast4').lean()).map((e) => [String(e._id), e]));
    await recordAudit(actorFrom(req), { action: 'view', resource: 'finance.settlements', sensitive: true, meta: { count: items.length } });
    res.json({ items: items.map((o) => ({ ...o, employee: emps.get(String(o.employeeId)), reasonLabel: EOS_REASON_AR[o.reason as keyof typeof EOS_REASON_AR] })) });
  }),
);
financeSettlementsRouter.post(
  '/:id/pay',
  requireAuth(),
  authorize('finance.settlements', 'edit'),
  validate(settlementActionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await Offboarding.findOne({ _id: req.params.id, deletedAt: null });
    if (!o) throw notFound();
    const body = req.body as z.infer<typeof settlementActionSchema>;
    const r = await eos.recordSettlementPayment(o, { paidAt: body.paidAt, paymentRef: body.paymentRef, proofAttachmentId: body.proofAttachmentId, note: body.note }, req.auth.user, actorFrom(req));
    res.json({ number: r.number, settlement: r.settlement });
  }),
);
