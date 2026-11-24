import { Router } from 'express';
import type { z } from 'zod';
import {
  createTrainingNeedSchema,
  createTrainingSchema,
  nominateParticipantsSchema,
  trainingNeedStateSchema,
  trainingPlanSchema,
  trainingPlanTransitionSchema,
  updateParticipantSchema,
  updateTrainingSchema,
} from '@eayni/shared';
import { asyncHandler } from '../../core/http/async';
import { validate } from '../../core/http/validate';
import { actorFrom, type AuthedRequest } from '../../core/http/context';
import { badRequest, forbidden, notFound } from '../../core/http/errors';
import { requireAuth } from '../../core/auth/middleware';
import { authorize } from '../../core/rbac/authorize';
import { Attachment } from '../../core/files/model';
import { Employee } from './model';
import { employeeOfUser } from './service';
import { allInScope, scopedEmployeeIds } from './scope';
import { Training, TrainingNeed, TrainingParticipant, TrainingPlan } from './training.model';
import * as training from './training.service';

export const trainingRouter = Router();
const HR_ROLES = ['hr_officer', 'hr_manager'];
const isHr = (req: AuthedRequest) => req.auth.roleCodes.some((c) => HR_ROLES.includes(c));

// ---------- my training ----------
trainingRouter.get(
  '/me',
  requireAuth(),
  authorize('hr.training', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const e = await employeeOfUser(String(req.auth.user._id));
    if (!e) throw badRequest('لا يوجد ملف موظف مرتبط بحسابك');
    const parts = await TrainingParticipant.find({ employeeId: e._id }).sort({ createdAt: -1 }).lean();
    const trainings = await Training.find({ _id: { $in: parts.map((p) => p.trainingId) } }).lean();
    const tn = new Map(trainings.map((t) => [String(t._id), t]));
    const certs = await Attachment.find({ _id: { $in: parts.map((p) => p.certificateAttachmentId).filter(Boolean) } }).select('originalName').lean();
    const cn = new Map(certs.map((c) => [String(c._id), c.originalName]));
    res.json({ items: parts.map((p) => ({ ...p, training: tn.get(String(p.trainingId)), certificateName: p.certificateAttachmentId ? cn.get(String(p.certificateAttachmentId)) : undefined })) });
  }),
);

// ---------- the annual plan [HR §3.8.1] ----------
trainingRouter.get(
  '/plans',
  requireAuth(),
  authorize('hr.training', 'view'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await TrainingPlan.find().sort({ year: -1 }).lean() });
  }),
);
trainingRouter.put(
  '/plans/:year',
  requireAuth(),
  authorize('hr.training', 'edit'),
  validate(trainingPlanSchema.omit({ year: true })),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden('إعداد الخطة من صلاحية الموارد البشرية');
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000) throw badRequest('سنة غير صالحة');
    const body = req.body as z.infer<typeof trainingPlanSchema>;
    res.json(await training.savePlan(year, body.items, body.notes, actorFrom(req)));
  }),
);
trainingRouter.post(
  '/plans/:year/transition',
  requireAuth(),
  authorize('hr.training', 'view'),
  validate(trainingPlanTransitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const plan = await TrainingPlan.findOne({ year: Number(req.params.year) });
    if (!plan) throw notFound('الخطة غير موجودة');
    const body = req.body as z.infer<typeof trainingPlanTransitionSchema>;
    res.json(await training.transitionPlan(plan, body.transition, req.auth.user, actorFrom(req), body.reason));
  }),
);

// ---------- needs [HR §3.8.2–3.8.3] ----------
trainingRouter.get(
  '/needs',
  requireAuth(),
  authorize('hr.training', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const f: Record<string, unknown> = { deletedAt: null };
    if (typeof req.query.year === 'string') f.year = Number(req.query.year);
    if (typeof req.query.departmentId === 'string') f.departmentId = req.query.departmentId;
    if (req.authz!.scope === 'department') f.departmentId = { $in: req.authz!.departmentIds };
    if (req.authz!.scope === 'own' || req.authz!.scope === 'team') return res.json({ items: [] });
    res.json({ items: await TrainingNeed.find(f).sort({ createdAt: -1 }).limit(500).lean() });
  }),
);
trainingRouter.post(
  '/needs',
  requireAuth(),
  authorize('hr.training', 'create'),
  validate(createTrainingNeedSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.status(201).json(await training.createNeed(req.body as z.infer<typeof createTrainingNeedSchema>, req.auth.user, actorFrom(req)));
  }),
);
trainingRouter.patch(
  '/needs/:id/state',
  requireAuth(),
  authorize('hr.training', 'edit'),
  validate(trainingNeedStateSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    const body = req.body as z.infer<typeof trainingNeedStateSchema>;
    res.json(await training.setNeedState(req.params.id, body.state, body.note, actorFrom(req)));
  }),
);

// ---------- courses and participants [HR §3.8.4–3.8.7] ----------
trainingRouter.get(
  '/trainings',
  requireAuth(),
  authorize('hr.training', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const f: Record<string, unknown> = { deletedAt: null };
    if (typeof req.query.year === 'string') f.startAt = { $gte: new Date(`${req.query.year}-01-01T00:00:00+03:00`), $lte: new Date(`${req.query.year}-12-31T23:59:59+03:00`) };
    if (typeof req.query.state === 'string') f.state = req.query.state;
    if (req.authz!.scope === 'department') f.$or = [{ departmentIds: { $in: req.authz!.departmentIds } }, { departmentIds: { $size: 0 } }];
    const items = await Training.find(f).sort({ startAt: -1 }).limit(500).lean();
    const counts = await TrainingParticipant.aggregate<{ _id: unknown; n: number; completed: number }>([
      { $match: { trainingId: { $in: items.map((t) => t._id) } } },
      { $group: { _id: '$trainingId', n: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } },
    ]);
    const cn = new Map(counts.map((c) => [String(c._id), c]));
    res.json({ items: items.map((t) => ({ ...t, participants: cn.get(String(t._id))?.n ?? 0, completed: cn.get(String(t._id))?.completed ?? 0 })) });
  }),
);
trainingRouter.post(
  '/trainings',
  requireAuth(),
  authorize('hr.training', 'edit'),
  validate(createTrainingSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden('تسجيل الدورات من صلاحية الموارد البشرية');
    res.status(201).json(await training.createTraining(req.body as z.infer<typeof createTrainingSchema>, req.auth.user, actorFrom(req)));
  }),
);
async function trainingOrThrow(id: string) {
  const t = await Training.findOne({ _id: id, deletedAt: null });
  if (!t) throw notFound('الدورة غير موجودة');
  return t;
}
trainingRouter.get(
  '/trainings/:id',
  requireAuth(),
  authorize('hr.training', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const t = await trainingOrThrow(req.params.id);
    const ids = await scopedEmployeeIds(req);
    const pf: Record<string, unknown> = { trainingId: t._id };
    if (ids) pf.employeeId = { $in: ids };
    const parts = await TrainingParticipant.find(pf).lean();
    const emps = await Employee.find({ _id: { $in: parts.map((p) => p.employeeId) } }).select('fullNameAr employeeNumber departmentId').lean();
    const en = new Map(emps.map((e) => [String(e._id), e]));
    res.json({ ...t, participants: parts.map((p) => ({ ...p, employee: en.get(String(p.employeeId)) })) });
  }),
);
trainingRouter.patch(
  '/trainings/:id',
  requireAuth(),
  authorize('hr.training', 'edit'),
  validate(updateTrainingSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    res.json(await training.updateTraining(await trainingOrThrow(req.params.id), req.body as Record<string, unknown>, actorFrom(req)));
  }),
);
/** Nominate: HR anyone; a department manager / direct manager their own people («ترشيح»). */
trainingRouter.post(
  '/trainings/:id/participants',
  requireAuth(),
  authorize('hr.training', 'view'),
  validate(nominateParticipantsSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = req.body as z.infer<typeof nominateParticipantsSchema>;
    if (req.authz!.scope === 'own' || !(await allInScope(req, body.employeeIds))) throw forbidden('يمكنك ترشيح موظفي فريقك أو قسمك فقط');
    const t = await trainingOrThrow(req.params.id);
    res.status(201).json({ items: await training.nominate(t, body.employeeIds, req.auth.user, actorFrom(req)) });
  }),
);
trainingRouter.patch(
  '/participants/:id',
  requireAuth(),
  authorize('hr.training', 'view'),
  validate(updateParticipantSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await training.updateParticipant(req.params.id, req.body as z.infer<typeof updateParticipantSchema>, req.auth.user, actorFrom(req)));
  }),
);
trainingRouter.delete(
  '/participants/:id',
  requireAuth(),
  authorize('hr.training', 'edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    await training.removeParticipant(req.params.id, actorFrom(req));
    res.status(204).end();
  }),
);
