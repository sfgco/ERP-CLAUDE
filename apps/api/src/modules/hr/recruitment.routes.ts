import { Router } from 'express';
import type { z } from 'zod';
import {
  applicantNoteSchema,
  applicantStageSchema,
  createApplicantSchema,
  createOfferSchema,
  createRequisitionSchema,
  importApplicantsSchema,
  interviewResultSchema,
  listOffersQuerySchema,
  listRequisitionsQuerySchema,
  offerTransitionSchema,
  requisitionTransitionSchema,
  scheduleInterviewSchema,
  updateOfferSchema,
  updateRequisitionSchema,
} from '@eayni/shared';
import { asyncHandler } from '../../core/http/async';
import { validate } from '../../core/http/validate';
import { actorFrom, type AuthedRequest } from '../../core/http/context';
import { badRequest, forbidden, notFound } from '../../core/http/errors';
import { requireAuth } from '../../core/auth/middleware';
import { authorize } from '../../core/rbac/authorize';
import { recordAudit } from '../../core/audit/service';
import { StageLog } from '../../core/workflow/model';
import { Department, Position } from '../../core/org/model';
import { Applicant, ApplicantEvent, Interview, JobRequisition, Offer } from './recruitment.model';
import * as rec from './recruitment.service';

/** Recruitment [HR §3.2] — `/hr/recruitment/*` (requisitions, applicants, interviews, offers). Salary data is sensitive. */
export const recruitmentRouter = Router();
const HR_ROLES = ['hr_officer', 'hr_manager'];
const isHr = (req: AuthedRequest) => req.auth.user.roles.some((r) => HR_ROLES.includes(r.role));

async function requisitionOrThrow(req: AuthedRequest, id: string) {
  const r = await JobRequisition.findOne({ _id: id, deletedAt: null });
  if (!r) throw notFound('طلب التوظيف غير موجود');
  const filter = rec.requisitionVisibility(req.auth.user, req.authz!);
  if (Object.keys(filter).length && !(await JobRequisition.exists({ _id: r._id, ...filter }))) throw notFound('طلب التوظيف غير موجود');
  return r;
}
async function requisitionDetail(req: AuthedRequest, r: InstanceType<typeof JobRequisition>) {
  const [applicants, interviews, offers, stages, dept, pos] = await Promise.all([
    Applicant.find({ requisitionId: r._id, deletedAt: null }).sort({ createdAt: -1 }).lean(),
    Interview.find({ requisitionId: r._id }).sort({ scheduledAt: 1 }).lean(),
    Offer.find({ requisitionId: r._id, deletedAt: null }).sort({ createdAt: -1 }).lean(),
    StageLog.find({ recordType: 'hr_requisition', recordId: String(r._id) }).sort({ at: 1 }).lean(),
    Department.findById(r.departmentId).select('nameAr').lean(),
    r.positionId ? Position.findById(r.positionId).select('titleAr').lean() : null,
  ]);
  const hr = isHr(req);
  return {
    ...rec.redactRequisition(r.toObject(), req.auth.user),
    departmentName: dept?.nameAr,
    positionTitle: pos?.titleAr,
    actions: await rec.availableRequisitionActions(req.auth.user, r),
    applicants: applicants.map((a) => rec.serializeApplicant(a, req.auth.user)),
    interviews,
    offers: offers.map((o) => (hr ? o : { ...o, basicSalaryHalalas: undefined, allowances: undefined })),
    stages,
  };
}

recruitmentRouter.get(
  '/policy',
  requireAuth(),
  authorize('hr.recruitment', 'view'),
  asyncHandler(async (_req, res) => {
    const { policy, provisional } = await rec.recruitmentPolicy();
    res.json({ ...policy, provisional, saudization: await rec.saudizationStatus() });
  }),
);
recruitmentRouter.get(
  '/saudization',
  requireAuth(),
  authorize('hr.recruitment', 'view'),
  asyncHandler(async (_req, res) => res.json(await rec.saudizationStatus())),
);

// ---------- requisitions ----------
recruitmentRouter.get(
  '/requisitions',
  requireAuth(),
  authorize('hr.recruitment', 'view'),
  validate(listRequisitionsQuerySchema, 'query'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = req.query as unknown as z.infer<typeof listRequisitionsQuerySchema>;
    const f: Record<string, unknown> = { deletedAt: null, ...rec.requisitionVisibility(req.auth.user, req.authz!) };
    if (q.view === 'mine') f.requestedBy = req.auth.user._id;
    if (q.state) f.state = q.state;
    if (q.departmentId) f.departmentId = q.departmentId;
    const [items, total] = await Promise.all([JobRequisition.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), JobRequisition.countDocuments(f)]);
    const depts = new Map((await Department.find({ _id: { $in: items.map((i) => i.departmentId) } }).select('nameAr').lean()).map((d) => [String(d._id), d.nameAr]));
    res.json({ items: items.map((r) => ({ ...rec.redactRequisition(r, req.auth.user), departmentName: depts.get(String(r.departmentId)) })), total, page: q.page, limit: q.limit });
  }),
);
recruitmentRouter.post(
  '/requisitions',
  requireAuth(),
  authorize('hr.recruitment', 'create'),
  validate(createRequisitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const r = await rec.createRequisition(req.body as z.infer<typeof createRequisitionSchema>, req.auth.user, actorFrom(req));
    res.status(201).json(await requisitionDetail(req, r));
  }),
);
recruitmentRouter.get(
  '/requisitions/:id',
  requireAuth(),
  authorize('hr.recruitment', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const r = await requisitionOrThrow(req, req.params.id);
    if (isHr(req)) await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.recruitment', resourceId: String(r._id), sensitive: true });
    res.json(await requisitionDetail(req, r));
  }),
);
recruitmentRouter.patch(
  '/requisitions/:id',
  requireAuth(),
  authorize('hr.recruitment', 'create'),
  validate(updateRequisitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const r = await requisitionOrThrow(req, req.params.id);
    res.json(await requisitionDetail(req, await rec.updateRequisition(r, req.body as Record<string, unknown>, req.auth.user, actorFrom(req))));
  }),
);
recruitmentRouter.post(
  '/requisitions/:id/transition',
  requireAuth(),
  authorize('hr.recruitment', 'view'),
  validate(requisitionTransitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const r = await requisitionOrThrow(req, req.params.id);
    const body = req.body as z.infer<typeof requisitionTransitionSchema>;
    res.json(await requisitionDetail(req, await rec.transitionRequisition(r, body.transition, { user: req.auth.user, actor: actorFrom(req), reason: body.reason, posting: body.posting })));
  }),
);

// ---------- applicants ----------
recruitmentRouter.post(
  '/requisitions/:id/applicants',
  requireAuth(),
  authorize('hr.recruitment', 'edit'),
  validate(createApplicantSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const r = await requisitionOrThrow(req, req.params.id);
    const a = await rec.addApplicant(r, req.body as z.infer<typeof createApplicantSchema>, actorFrom(req));
    res.status(201).json(rec.serializeApplicant(a, req.auth.user));
  }),
);
/** CSV import (DECISIONS §22 Q6): the web parses the file; the server validates row by row and reports the rejects. */
recruitmentRouter.post(
  '/requisitions/:id/applicants/import',
  requireAuth(),
  authorize('hr.recruitment', 'edit'),
  validate(importApplicantsSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const r = await requisitionOrThrow(req, req.params.id);
    res.status(201).json(await rec.importApplicants(r, (req.body as z.infer<typeof importApplicantsSchema>).rows, actorFrom(req)));
  }),
);
async function applicantOrThrow(req: AuthedRequest, id: string) {
  const a = await Applicant.findOne({ _id: id, deletedAt: null });
  if (!a) throw notFound('المرشح غير موجود');
  await requisitionOrThrow(req, String(a.requisitionId));
  return a;
}
recruitmentRouter.get(
  '/applicants/:id',
  requireAuth(),
  authorize('hr.recruitment', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await applicantOrThrow(req, req.params.id);
    const [events, interviews, offers] = await Promise.all([ApplicantEvent.find({ applicantId: a._id }).sort({ at: 1 }).lean(), Interview.find({ applicantId: a._id }).sort({ round: 1 }).lean(), Offer.find({ applicantId: a._id }).sort({ createdAt: -1 }).select('number state startDate validUntil').lean()]);
    res.json({ ...rec.serializeApplicant(a, req.auth.user), events, interviews, offers });
  }),
);
/** The identity number of an applicant — HR only, audited (sensitive, HR_PLAN §6). */
recruitmentRouter.get(
  '/applicants/:id/identity',
  requireAuth(),
  authorize('hr.recruitment', 'edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isHr(req)) throw forbidden();
    const a = await applicantOrThrow(req, req.params.id);
    await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.recruitment', resourceId: String(a._id), sensitive: true, meta: { field: 'identityNumber' } });
    res.json({ identityNumber: rec.applicantIdentity(a) });
  }),
);
recruitmentRouter.post(
  '/applicants/:id/stage',
  requireAuth(),
  authorize('hr.recruitment', 'edit'),
  validate(applicantStageSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await applicantOrThrow(req, req.params.id);
    const body = req.body as z.infer<typeof applicantStageSchema>;
    res.json(rec.serializeApplicant(await rec.moveApplicant(a, body.stage, { actor: actorFrom(req), rejectionReason: body.rejectionReason, note: body.note }), req.auth.user));
  }),
);
recruitmentRouter.post(
  '/applicants/:id/notes',
  requireAuth(),
  authorize('hr.recruitment', 'edit'),
  validate(applicantNoteSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await applicantOrThrow(req, req.params.id);
    await rec.addApplicantNote(a, (req.body as { note: string }).note, actorFrom(req));
    res.status(201).json({ ok: true });
  }),
);

// ---------- interviews ----------
recruitmentRouter.post(
  '/applicants/:id/interviews',
  requireAuth(),
  authorize('hr.recruitment', 'edit'),
  validate(scheduleInterviewSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await applicantOrThrow(req, req.params.id);
    res.status(201).json(await rec.scheduleInterview(a, req.body as z.infer<typeof scheduleInterviewSchema>, req.auth.user, actorFrom(req)));
  }),
);
recruitmentRouter.post(
  '/interviews/:id/result',
  requireAuth(),
  authorize('hr.recruitment', 'view'),
  validate(interviewResultSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const iv = await Interview.findById(req.params.id);
    if (!iv) throw notFound('المقابلة غير موجودة');
    // A panel member records the result; HR too.
    const uid = String(req.auth.user._id);
    if (!isHr(req) && !iv.panelUserIds.map(String).includes(uid)) throw forbidden('تسجيل النتيجة من أعضاء لجنة المقابلة أو الموارد البشرية');
    res.json(await rec.recordInterviewResult(iv, req.body as z.infer<typeof interviewResultSchema>, req.auth.user, actorFrom(req)));
  }),
);

// ---------- offers ----------
async function offerDetail(req: AuthedRequest, o: InstanceType<typeof Offer>) {
  const [applicant, stages, dept, pos] = await Promise.all([
    Applicant.findById(o.applicantId).lean(),
    StageLog.find({ recordType: 'hr_offer', recordId: String(o._id) }).sort({ at: 1 }).lean(),
    Department.findById(o.departmentId).select('nameAr').lean(),
    o.positionId ? Position.findById(o.positionId).select('titleAr').lean() : null,
  ]);
  const obj = o.toObject() as Record<string, unknown>;
  if (!isHr(req)) {
    delete obj.basicSalaryHalalas;
    delete obj.allowances;
  }
  return { ...obj, applicant: applicant ? rec.serializeApplicant(applicant, req.auth.user) : null, departmentName: dept?.nameAr, positionTitle: pos?.titleAr, actions: await rec.availableOfferActions(req.auth.user, o), stages };
}
recruitmentRouter.get(
  '/offers',
  requireAuth(),
  authorize('hr.offers', 'view'),
  validate(listOffersQuerySchema, 'query'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = req.query as unknown as z.infer<typeof listOffersQuerySchema>;
    const f: Record<string, unknown> = { deletedAt: null };
    if (q.state) f.state = q.state;
    if (q.requisitionId) f.requisitionId = q.requisitionId;
    if (req.authz!.scope === 'department') f.departmentId = { $in: req.authz!.departmentIds };
    const [items, total] = await Promise.all([Offer.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Offer.countDocuments(f)]);
    const names = new Map((await Applicant.find({ _id: { $in: items.map((i) => i.applicantId) } }).select('fullNameAr').lean()).map((a) => [String(a._id), a.fullNameAr]));
    res.json({ items: items.map((o) => ({ ...(isHr(req) ? o : { ...o, basicSalaryHalalas: undefined, allowances: undefined }), applicantName: names.get(String(o.applicantId)) })), total, page: q.page, limit: q.limit });
  }),
);
recruitmentRouter.post(
  '/offers',
  requireAuth(),
  authorize('hr.offers', 'create'),
  validate(createOfferSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await rec.createOffer(req.body as z.infer<typeof createOfferSchema>, req.auth.user, actorFrom(req));
    res.status(201).json(await offerDetail(req, o));
  }),
);
recruitmentRouter.get(
  '/offers/:id',
  requireAuth(),
  authorize('hr.offers', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await Offer.findOne({ _id: req.params.id, deletedAt: null });
    if (!o) throw notFound('العرض غير موجود');
    if (req.authz!.scope === 'department' && !req.authz!.departmentIds.includes(String(o.departmentId))) throw notFound('العرض غير موجود');
    if (isHr(req)) await recordAudit(actorFrom(req), { action: 'view', resource: 'hr.offers', resourceId: String(o._id), sensitive: true });
    res.json(await offerDetail(req, o));
  }),
);
recruitmentRouter.patch(
  '/offers/:id',
  requireAuth(),
  authorize('hr.offers', 'edit'),
  validate(updateOfferSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await Offer.findOne({ _id: req.params.id, deletedAt: null });
    if (!o) throw notFound('العرض غير موجود');
    if (o.state !== 'draft') throw badRequest('يُعدَّل العرض وهو مسودة فقط');
    const before = { basicSalaryHalalas: o.basicSalaryHalalas, startDate: o.startDate };
    Object.assign(o, req.body);
    await o.save();
    await recordAudit(actorFrom(req), { action: 'update', resource: 'hr.offers', resourceId: String(o._id), before, after: { basicSalaryHalalas: o.basicSalaryHalalas, startDate: o.startDate }, sensitive: true });
    res.json(await offerDetail(req, o));
  }),
);
recruitmentRouter.post(
  '/offers/:id/transition',
  requireAuth(),
  authorize('hr.offers', 'view'),
  validate(offerTransitionSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await Offer.findOne({ _id: req.params.id, deletedAt: null });
    if (!o) throw notFound('العرض غير موجود');
    const body = req.body as z.infer<typeof offerTransitionSchema>;
    const r = await rec.transitionOffer(o, body.transition, { user: req.auth.user, actor: actorFrom(req), reason: body.reason, acceptedAt: body.acceptedAt, signedAttachmentId: body.signedAttachmentId, hire: body.hire as never, gov: body.gov });
    res.json({ ...(await offerDetail(req, r)), temporaryPassword: (r as { temporaryPassword?: string }).temporaryPassword });
  }),
);
