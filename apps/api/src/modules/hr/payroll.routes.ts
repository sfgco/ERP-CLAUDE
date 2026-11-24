import { Router } from 'express';
import type { z } from 'zod';
import { createPayrollRunSchema, listPayrollRunsQuerySchema, listPayslipsQuerySchema, payrollAdjustmentSchema, payrollRunTransitionSchema } from '@eayni/shared';
import { asyncHandler } from '../../core/http/async';
import { validate } from '../../core/http/validate';
import { actorFrom, type AuthedRequest } from '../../core/http/context';
import { badRequest, forbidden, notFound } from '../../core/http/errors';
import { requireAuth } from '../../core/auth/middleware';
import { authorize } from '../../core/rbac/authorize';
import { recordAudit } from '../../core/audit/service';
import { getSettingMeta } from '../../core/settings/service';
import { sendHtml } from '../../core/templates/render';
import { StageLog } from '../../core/workflow/model';
import { Employee } from './model';
import { employeeOfUser } from './service';
import { AdvanceSchedule, PayrollAdjustment, PayrollRun, Payslip } from './payroll.model';
import * as payroll from './payroll.service';

export const payrollRouter = Router();
export const payslipsRouter = Router();
export const financePayrollRouter = Router();

async function runOrThrow(id: string) {
  const run = await PayrollRun.findOne({ _id: id, deletedAt: null });
  if (!run) throw notFound('المسير غير موجود');
  return run;
}
async function runDetail(req: AuthedRequest, run: InstanceType<typeof PayrollRun>, withLines: boolean) {
  const payslips = await Payslip.find({ runId: run._id }).sort({ employeeNumber: 1 }).lean();
  const stages = await StageLog.find({ recordType: 'hr_payroll_run', recordId: String(run._id) }).sort({ at: 1 }).lean();
  const policy = await getSettingMeta('hr.payroll.policy');
  await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.payroll', resourceId: String(run._id), sensitive: true, meta: { payslips: payslips.length } });
  return {
    ...run.toObject(),
    actions: await payroll.availableActions(req.auth.user, run),
    stages,
    provisional: policy.provisional,
    payslips: payslips.map((p) => (withLines ? p : { ...p, earnings: undefined, deductions: undefined })),
  };
}

// ---------- HR: runs [HR §3.6.2, §3.6.6] ----------
payrollRouter.get(
  '/',
  requireAuth(),
  authorize('hr.payroll', 'view'),
  validate(listPayrollRunsQuerySchema, 'query'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = req.query as unknown as z.infer<typeof listPayrollRunsQuerySchema>;
    const f: Record<string, unknown> = { deletedAt: null };
    if (q.state) f.state = q.state;
    if (q.year) f.period = { $regex: `^${q.year}-` };
    const [items, total, policy] = await Promise.all([
      PayrollRun.find(f).sort({ period: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      PayrollRun.countDocuments(f),
      getSettingMeta('hr.payroll.policy'),
    ]);
    res.json({ items, total, page: q.page, limit: q.limit, currentPeriod: payroll.currentPeriod(), policy: policy.value, provisional: policy.provisional });
  }),
);

payrollRouter.post(
  '/',
  requireAuth(),
  authorize('hr.payroll', 'create'),
  validate(createPayrollRunSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = req.body as z.infer<typeof createPayrollRunSchema>;
    const run = await payroll.createRun(body.period, req.auth.user, actorFrom(req), body.notes);
    res.status(201).json(await runDetail(req, run, false));
  }),
);

payrollRouter.get(
  '/adjustments',
  requireAuth(),
  authorize('hr.payroll', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const f: Record<string, unknown> = {};
    if (typeof req.query.employeeId === 'string') f.employeeId = req.query.employeeId;
    if (req.query.open === 'true') f.consumedByRunId = null;
    res.json({ items: await PayrollAdjustment.find(f).sort({ createdAt: -1 }).limit(500).lean() });
  }),
);
payrollRouter.post(
  '/adjustments',
  requireAuth(),
  authorize('hr.payroll', 'edit'),
  validate(payrollAdjustmentSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.status(201).json(await payroll.addAdjustment(req.body as z.infer<typeof payrollAdjustmentSchema>, actorFrom(req)));
  }),
);
payrollRouter.get(
  '/advances',
  requireAuth(),
  authorize('hr.payroll', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const f: Record<string, unknown> = {};
    if (typeof req.query.employeeId === 'string') f.employeeId = req.query.employeeId;
    res.json({ items: await AdvanceSchedule.find(f).sort({ createdAt: -1 }).limit(500).lean() });
  }),
);

payrollRouter.get(
  '/:id',
  requireAuth(),
  authorize('hr.payroll', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await runDetail(req, await runOrThrow(req.params.id), true));
  }),
);

payrollRouter.post(
  '/:id/recompute',
  requireAuth(),
  authorize('hr.payroll', 'edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const run = await payroll.prepareRun(await runOrThrow(req.params.id), actorFrom(req));
    res.json(await runDetail(req, run, true));
  }),
);

payrollRouter.post(
  '/:id/transition',
  requireAuth(),
  authorize('hr.payroll', 'view'),
  validate(payrollRunTransitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = req.body as z.infer<typeof payrollRunTransitionSchema>;
    if (['finance_approve', 'finance_return', 'record_payment'].includes(body.transition)) throw forbidden('هذه الخطوة من شاشة المالية');
    if (body.transition === 'send_to_finance' && (await runOrThrow(req.params.id)).state !== 'finance_returned') throw badRequest('الرفع إلى المالية يتم تلقائياً بعد اعتماد الموارد البشرية');
    const run = await payroll.transitionRun(await runOrThrow(req.params.id), body.transition, { user: req.auth.user, actor: actorFrom(req), reason: body.reason });
    res.json(await runDetail(req, run, false));
  }),
);

// ---------- payslips [HR §3.6.8–3.6.9] ----------
payslipsRouter.get(
  '/me',
  requireAuth(),
  authorize('hr.payslips', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const e = await employeeOfUser(String(req.auth.user._id));
    if (!e) throw badRequest('لا يوجد ملف موظف مرتبط بحسابك');
    const items = await Payslip.find({ employeeId: e._id, visibleToEmployeeAt: { $ne: null } }).sort({ period: -1 }).limit(36).lean();
    res.json({ items });
  }),
);
payslipsRouter.get(
  '/',
  requireAuth(),
  authorize('hr.payslips', 'view'),
  validate(listPayslipsQuerySchema, 'query'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = req.query as unknown as z.infer<typeof listPayslipsQuerySchema>;
    const user = req.auth.user;
    const f: Record<string, unknown> = {};
    if (q.runId) f.runId = q.runId;
    if (q.year) f.period = { $regex: `^${q.year}-` };
    if (payroll.isHrUser(user) || payroll.isFinanceUser(user)) {
      if (q.employeeId) f.employeeId = q.employeeId;
      await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.payslips', sensitive: true, meta: { employeeId: q.employeeId, runId: q.runId } });
    } else {
      const me = await employeeOfUser(String(user._id));
      if (!me) return res.json({ items: [], total: 0 });
      f.employeeId = me._id;
      f.visibleToEmployeeAt = { $ne: null };
    }
    const [items, total] = await Promise.all([Payslip.find(f).sort({ period: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Payslip.countDocuments(f)]);
    res.json({ items, total, page: q.page, limit: q.limit });
  }),
);
async function readablePayslip(req: AuthedRequest, id: string) {
  const p = await Payslip.findById(id);
  if (!p) throw notFound('القسيمة غير موجودة');
  const mode = await payroll.canReadPayslip(req.auth.user, p);
  if (!mode) throw notFound('القسيمة غير موجودة');
  if (mode === 'full') await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.payslips', resourceId: String(p._id), sensitive: true });
  else if (!p.viewedByEmployeeAt) await Payslip.updateOne({ _id: p._id }, { $set: { viewedByEmployeeAt: new Date() } });
  return p;
}
payslipsRouter.get(
  '/:id',
  requireAuth(),
  authorize('hr.payslips', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const p = await readablePayslip(req, req.params.id);
    const run = await PayrollRun.findById(p.runId).select('number period state cutoff').lean();
    res.json({ ...p.toObject(), run });
  }),
);
payslipsRouter.get(
  '/:id/document',
  requireAuth(),
  authorize('hr.payslips', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const p = await readablePayslip(req, req.params.id);
    const run = await PayrollRun.findById(p.runId);
    if (!run) throw notFound();
    await recordAudit(actorFrom(req), { action: 'download', resource: 'hr.payslips', resourceId: String(p._id), sensitive: true });
    sendHtml(res, await payroll.payslipHtml(p, run));
  }),
);

// ---------- Finance: the thin stage [HR §3.6.7, FIN §5, §11, §12] ----------
financePayrollRouter.get(
  '/',
  requireAuth(),
  authorize('finance.payroll', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const states = req.query.all === 'true' ? { $in: ['at_finance', 'finance_returned', 'finance_approved', 'paid', 'closed'] } : { $in: ['at_finance', 'finance_approved'] };
    const items = await PayrollRun.find({ deletedAt: null, state: states }).sort({ period: -1 }).limit(100).lean();
    res.json({ items: items.map((r) => ({ ...r, policySnapshot: undefined })) });
  }),
);
financePayrollRouter.get(
  '/:id',
  requireAuth(),
  authorize('finance.payroll', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const run = await runOrThrow(req.params.id);
    if (!['at_finance', 'finance_returned', 'finance_approved', 'paid', 'closed'].includes(run.state)) throw notFound('المسير لم يصل إلى المالية');
    res.json(await runDetail(req, run, true));
  }),
);
financePayrollRouter.post(
  '/:id/transition',
  requireAuth(),
  authorize('finance.payroll', 'view'),
  validate(payrollRunTransitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = req.body as z.infer<typeof payrollRunTransitionSchema>;
    if (!['finance_approve', 'finance_return', 'record_payment'].includes(body.transition)) throw forbidden('هذه الخطوة من شاشة الموارد البشرية');
    const run = await payroll.transitionRun(await runOrThrow(req.params.id), body.transition, {
      user: req.auth.user,
      actor: actorFrom(req),
      reason: body.reason,
      payment: { paidAt: body.paidAt, paymentRef: body.paymentRef, proofAttachmentId: body.proofAttachmentId },
    });
    res.json(await runDetail(req, run, false));
  }),
);

void Employee;
