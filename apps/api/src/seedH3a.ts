import { DEFAULT_APPRAISAL_TEMPLATE } from '@eayni/shared';
import { User } from './core/auth/model';
import { SYSTEM_ACTOR, type Actor } from './core/http/context';
import { Attachment } from './core/files/model';
import { Department } from './core/org/model';
import { riyadhDate } from './core/dates/businessDays';
import { Employee } from './modules/hr/model';
import { addDays } from './modules/hr/attendance.service';
import { PayrollRun } from './modules/hr/payroll.model';
import { addAdjustment, createRun, currentPeriod, previousPeriod, transitionRun } from './modules/hr/payroll.service';
import { AppraisalCycle, AppraisalTemplate } from './modules/hr/performance.model';
import * as perf from './modules/hr/performance.service';
import * as training from './modules/hr/training.service';
import { Training } from './modules/hr/training.model';

/**
 * Sample payroll, performance and training data [HR §3.6–3.8] for local testing. Idempotent (skipped once a payroll
 * run exists). Everything goes through the services so the stage logs, audit rows and notifications exist too.
 */
export async function seedH3a(): Promise<{ runs: number; appraisals: number; trainings: number }> {
  if (await PayrollRun.countDocuments()) return { runs: 0, appraisals: 0, trainings: 0 };
  const byEmail = async (email: string) => {
    const u = await User.findOne({ email });
    if (!u) throw new Error(`seed: user ${email} missing`);
    return u;
  };
  const actorOf = (u: InstanceType<typeof User>): Actor => ({ userId: String(u._id), email: u.email, roleCodes: u.roles.map((r) => r.role) });
  const emp = async (email: string) => {
    const e = await Employee.findOne({ workEmail: email });
    if (!e) throw new Error(`seed: employee ${email} missing`);
    return e;
  };
  const [noura, sara, abdulaziz, shahad, khalid, sultan] = await Promise.all(['noura', 'sara', 'abdulaziz', 'shahad', 'khalid', 'sultan'].map((u) => byEmail(`${u}@eayni.local`)));
  const [omar, rashed, yousef, reem, majed, fahad, lama] = await Promise.all(['omar', 'rashed', 'yousef', 'reem', 'majed', 'fahad', 'lama'].map((u) => emp(`${u}@eayni.local`)));
  const today = riyadhDate(new Date());
  const year = Number(today.slice(0, 4));

  // ---- Payroll [HR §3.6]: last month paid end to end (sara prepares, noura approves, abdulaziz approves, shahad pays); this month in draft.
  await addAdjustment({ employeeId: String(omar._id), kind: 'earning', amountHalalas: 50_000, reason: 'مكافأة تميّز ميداني' }, actorOf(noura));
  const prev = previousPeriod(currentPeriod());
  let run = await createRun(prev, sara, actorOf(sara), 'مسير تجريبي للشهر الماضي');
  run = await transitionRun(run, 'submit_for_review', { user: sara, actor: actorOf(sara) });
  run = await transitionRun(run, 'hr_approve', { user: noura, actor: actorOf(noura) });
  run = await transitionRun(run, 'finance_approve', { user: abdulaziz, actor: actorOf(abdulaziz) });
  await transitionRun(run, 'record_payment', { user: shahad, actor: actorOf(shahad), payment: { paidAt: new Date(), paymentRef: `WPS-${prev}-001` } });
  await createRun(currentPeriod(), sara, actorOf(sara), 'مسير الشهر الجاري (مسودة)');

  // ---- Performance [HR §3.7]: template, an open semi-annual cycle, goals, a scored and approved appraisal, a plan, a delivered warning.
  const tpl = (await AppraisalTemplate.findOne({ active: true })) ?? (await perf.saveTemplate(DEFAULT_APPRAISAL_TEMPLATE, actorOf(noura)));
  await perf.createGoal({ employeeId: String(omar._id), title: 'الالتزام بجدول الدوام الميداني بنسبة 98%', weightBp: 6000, kpiCode: 'hr.attendance_rate', targetValue: 98, unit: '%' }, actorOf(khalid));
  const g2 = await perf.createGoal({ employeeId: String(omar._id), title: 'إكمال دورة السلامة المهنية', weightBp: 4000, kpiCode: 'hr.training_completion' }, actorOf(khalid));
  await perf.addGoalProgress(String(g2._id), 60, 'حضر اليوم الأول', actorOf(omar.userId ? await byEmail('omar@eayni.local') : khalid));
  await perf.createGoal({ employeeId: String(reem._id), title: 'تحقيق مستهدف المبيعات الشهري', weightBp: 10_000, kpiCode: 'sales.revenue' }, actorOf(sultan));
  await perf.createGoal({ employeeId: String(majed._id), title: 'تحويل 40% من عروض الأسعار', weightBp: 10_000, kpiCode: 'sales.quote_conversion' }, actorOf(sultan));
  const kind = Number(today.slice(5, 7)) >= 7 ? 'semi_annual_1' : 'annual';
  const cycle =
    (await AppraisalCycle.findOne({ year, kind })) ??
    (await perf.createCycle(
      kind === 'semi_annual_1'
        ? { year, kind, from: `${year}-01-01`, to: `${year}-06-30`, opensAt: today, dueAt: addDays(today, 30), templateId: String(tpl._id) }
        : { year: year - 1, kind: 'annual', from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, opensAt: today, dueAt: addDays(today, 30), templateId: String(tpl._id) },
      actorOf(noura),
    ));
  const { created } = await perf.openCycle(cycle, actorOf(noura));
  const { Appraisal } = await import('./modules/hr/performance.model');
  const apprOmar = await Appraisal.findOne({ cycleId: cycle._id, employeeId: omar._id });
  if (apprOmar) {
    await perf.scoreAppraisal(apprOmar, khalid, [{ key: 'quality', value: 4 }, { key: 'teamwork', value: 5 }, { key: 'initiative', value: 4 }, { key: 'communication', value: 4 }, { key: 'tasks', value: 4 }], 'أداء ميداني جيد مع التزام بالسلامة', actorOf(khalid));
    const r = await perf.transitionAppraisal(apprOmar, 'submit', { user: khalid, actor: actorOf(khalid) });
    await perf.transitionAppraisal(r.appraisal, 'approve', { user: noura, actor: actorOf(noura), hrNotes: 'معتمد' });
  }
  const apprRashed = await Appraisal.findOne({ cycleId: cycle._id, employeeId: rashed._id });
  if (apprRashed) {
    await perf.scoreAppraisal(apprRashed, khalid, [{ key: 'goals', value: 2 }, { key: 'quality', value: 2 }, { key: 'teamwork', value: 3 }, { key: 'initiative', value: 2 }, { key: 'communication', value: 2 }, { key: 'tasks', value: 2 }], 'يحتاج متابعة في الالتزام بالمواعيد', actorOf(khalid));
    const r = await perf.transitionAppraisal(apprRashed, 'submit', { user: khalid, actor: actorOf(khalid) });
    await perf.transitionAppraisal(r.appraisal, 'approve', { user: noura, actor: actorOf(noura) });
    await perf.createImprovementPlan({ employeeId: String(rashed._id), appraisalId: String(apprRashed._id), from: today, to: addDays(today, 90), objectives: [{ text: 'الالتزام بمواعيد الحضور', measure: 'لا تأخير خلال 30 يوماً' }, { text: 'تسليم تقارير الرحلات في يومها' }] }, khalid, actorOf(khalid));
  }
  const warning = await perf.createDisciplinary({ employeeId: String(yousef._id), kind: 'written_notice', violationDate: addDays(today, -3), description: 'التأخر عن الدوام الميداني ثلاث مرات في أسبوع واحد رغم التنبيه الشفهي', evidenceAttachmentIds: [] }, khalid, actorOf(khalid));
  let d = await perf.transitionDisciplinary(warning, 'submit', { user: khalid, actor: actorOf(khalid) });
  d = await perf.transitionDisciplinary(d, 'approve', { user: noura, actor: actorOf(noura) });
  await perf.transitionDisciplinary(d, 'deliver', { user: sara, actor: actorOf(sara) });

  // ---- Training [HR §3.8]: needs, an approved plan, a completed course with certificates, an upcoming course.
  const ops = await Department.findOne({ code: 'ops' });
  const sales = await Department.findOne({ code: 'sales' });
  const need1 = await training.createNeed({ departmentId: String(ops!._id), year, title: 'السلامة المهنية في مواقع الفرز والجمع', justification: 'حوادث بسيطة متكررة في مواقع التشغيل', source: 'department', employeeIds: [String(omar._id), String(yousef._id), String(fahad._id)], priority: 'high' }, khalid, actorOf(khalid));
  const need2 = await training.createNeed({ departmentId: String(sales!._id), year, title: 'مهارات التفاوض وإغلاق الصفقات', source: 'appraisal', employeeIds: [String(majed._id)], priority: 'medium' }, sultan, actorOf(sultan));
  await training.setNeedState(String(need1._id), 'accepted', undefined, actorOf(sara));
  await training.savePlan(year, [
    { title: 'السلامة المهنية', departmentIds: [String(ops!._id)], quarter: Math.min(4, Math.ceil(Number(today.slice(5, 7)) / 3)), estimatedCostHalalas: 900_000, needIds: [String(need1._id)] },
    { title: 'مهارات البيع والتفاوض', departmentIds: [String(sales!._id)], quarter: 4, estimatedCostHalalas: 600_000, needIds: [String(need2._id)] },
    { title: 'إدارة الوقت للجميع', departmentIds: [], quarter: 2, estimatedCostHalalas: 200_000, needIds: [] },
  ], 'خطة تجريبية', actorOf(sara));
  const { TrainingPlan } = await import('./modules/hr/training.model');
  let plan = (await TrainingPlan.findOne({ year }))!;
  plan = await training.transitionPlan(plan, 'submit', sara, actorOf(sara));
  await training.transitionPlan(plan, 'approve', noura, actorOf(noura), undefined);
  const done = await training.createTraining({ title: 'السلامة المهنية في مواقع الفرز والجمع', providerName: 'المعهد السعودي للسلامة المهنية', kind: 'external', startAt: new Date(Date.now() - 20 * 86_400_000), endAt: new Date(Date.now() - 18 * 86_400_000), location: 'الدمام — قاعة التدريب', needIds: [String(need1._id)], departmentIds: [String(ops!._id)], costHalalas: 850_000 }, noura, actorOf(noura));
  const parts = await training.nominate(done, [String(omar._id), String(yousef._id), String(fahad._id)], noura, actorOf(noura));
  for (const p of parts) {
    const e = await Employee.findById(p.employeeId);
    const cert = await Attachment.create({ key: `seed/${p.employeeId}-safety-cert.pdf`, originalName: `شهادة-السلامة-${e?.firstNameAr ?? ''}.pdf`, mimeType: 'application/pdf', size: 2048, status: 'uploaded', uploadedBy: e?.userId, uploadedAt: new Date(), ownerType: 'employee', ownerId: String(p.employeeId) });
    await training.updateParticipant(String(p._id), { status: String(p.employeeId) === String(fahad._id) ? 'not_completed' : 'completed', result: String(p.employeeId) === String(fahad._id) ? 'لم يحضر اليوم الثاني' : 'ناجح', certificateAttachmentId: String(p.employeeId) === String(fahad._id) ? undefined : String(cert._id) }, noura, actorOf(noura));
  }
  await training.updateTraining(done, { state: 'completed' }, actorOf(noura));
  const upcoming = await training.createTraining({ title: 'مهارات التفاوض وإغلاق الصفقات', providerName: 'غرفة الشرقية — مركز التدريب', kind: 'external', startAt: new Date(Date.now() + 12 * 86_400_000), endAt: new Date(Date.now() + 13 * 86_400_000), location: 'الدمام', needIds: [String(need2._id)], departmentIds: [String(sales!._id)], costHalalas: 400_000 }, noura, actorOf(noura));
  await training.nominate(upcoming, [String(majed._id), String(reem._id), String(lama._id)], noura, actorOf(noura));
  void SYSTEM_ACTOR;
  return { runs: await PayrollRun.countDocuments(), appraisals: created, trainings: await Training.countDocuments() };
}
