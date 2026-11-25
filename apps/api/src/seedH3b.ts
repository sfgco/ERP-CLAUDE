import { User } from './core/auth/model';
import type { Actor } from './core/http/context';
import { Department, Position } from './core/org/model';
import { riyadhDate } from './core/dates/businessDays';
import { Employee } from './modules/hr/model';
import { addDays } from './modules/hr/attendance.service';
import { JobRequisition, Offer } from './modules/hr/recruitment.model';
import * as rec from './modules/hr/recruitment.service';
import * as eos from './modules/hr/offboarding.service';

/**
 * Sample recruitment and end-of-service data [HR §3.2, §3.10] for local testing (H3b). Idempotent (skipped once a
 * requisition exists). Everything goes through the services so stage logs, audit rows, tasks and notifications exist.
 */
export async function seedH3b(): Promise<{ requisitions: number; applicants: number; offers: number; offboardings: number }> {
  if (await JobRequisition.countDocuments()) return { requisitions: 0, applicants: 0, offers: 0, offboardings: 0 };
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
  const [noura, sara, khalid, sultan, talalUser] = await Promise.all(['noura', 'sara', 'khalid', 'sultan', 'talal'].map((u) => byEmail(`${u}@eayni.local`)));
  const ops = await Department.findOne({ code: 'ops' });
  const sales = await Department.findOne({ code: 'sales' });
  if (!ops || !sales) throw new Error('seed: departments missing');
  const fieldPos = await Position.findOne({ departmentId: ops._id }).lean();
  const today = riyadhDate(new Date());

  // ---- Recruitment [HR §3.2]: an approved and posted requisition with applicants, an interview and an accepted offer; a draft for Sales.
  const r1 = await rec.createRequisition(
    { departmentId: String(ops._id), positionId: fieldPos ? String(fieldPos._id) : undefined, titleAr: 'عامل ميداني', headcount: 2, justification: 'توسّع مسارات الجمع في الرياض', employmentType: 'full_time', contractType: 'fixed_term', durationMonths: 12, salaryRange: { minHalalas: 400_000, maxHalalas: 650_000 }, requirements: 'رخصة قيادة سارية، لياقة بدنية، التزام بتعليمات السلامة', neededBy: addDays(today, 45), recruitmentCosts: [], draft: false },
    khalid,
    actorOf(khalid),
  );
  await rec.transitionRequisition(r1, 'approve', { user: noura, actor: actorOf(noura) });
  let req1 = (await JobRequisition.findById(r1._id))!;
  await rec.transitionRequisition(req1, 'post', { user: sara, actor: actorOf(sara), posting: { channels: ['jadarat', 'internal'], closesAt: addDays(today, 20), externalRefs: [{ channel: 'jadarat', reference: 'JD-2026-5521' }] } });
  req1 = (await JobRequisition.findById(r1._id))!;
  const applicants = [
    { fullNameAr: 'سعد بن ناصر العتيبي', phone: '0551112233', email: 'saad.applicant@example.com', nationality: 'سعودي', birthDate: '1998-04-12', source: 'jadarat', qualificationAr: 'ثانوية عامة', experienceYears: 3, expectedSalaryHalalas: 500_000 },
    { fullNameAr: 'محمد علي حسين', phone: '0552223344', nationality: 'سوداني', birthDate: '1990-09-01', source: 'jadarat', qualificationAr: 'دبلوم', experienceYears: 6, expectedSalaryHalalas: 450_000 },
    { fullNameAr: 'عبدالله فهد الشمري', phone: '0553334455', nationality: 'سعودي', birthDate: '2001-01-20', source: 'internal', qualificationAr: 'ثانوية عامة', experienceYears: 1 },
    { fullNameAr: 'ياسر أحمد القرني', phone: '0554445566', nationality: 'سعودي', birthDate: '1995-06-30', source: 'linkedin', qualificationAr: 'دبلوم', experienceYears: 4 },
  ];
  const created = [] as Awaited<ReturnType<typeof rec.addApplicant>>[];
  for (const a of applicants) created.push(await rec.addApplicant(req1, a as never, actorOf(sara)));
  let app0 = await rec.moveApplicant(created[0], 'screened', { actor: actorOf(sara) });
  app0 = await rec.moveApplicant(app0, 'shortlisted', { actor: actorOf(sara) });
  const app1 = await rec.moveApplicant(created[1], 'screened', { actor: actorOf(sara) });
  await rec.moveApplicant(app1, 'shortlisted', { actor: actorOf(sara) });
  await rec.moveApplicant(await rec.moveApplicant(created[3], 'screened', { actor: actorOf(sara) }), 'rejected', { actor: actorOf(sara), rejectionReason: 'experience' }); // T1: a professional reason from the list
  const iv = await rec.scheduleInterview(app0, { round: 1, scheduledAt: new Date(Date.now() + 3 * 86_400_000), durationMinutes: 45, mode: 'in_person', location: 'المقر الرئيسي — قاعة الاجتماعات', panelUserIds: [String(khalid._id), String(sara._id)], notes: 'مقابلة أولى' }, sara, actorOf(sara));
  await rec.recordInterviewResult(iv, { state: 'done', scores: [{ criterion: 'qualification', value: 4 }, { criterion: 'experience', value: 4 }, { criterion: 'skills', value: 5 }, { criterion: 'fit', value: 4 }], recommendation: 'proceed', notes: 'مرشح مناسب' }, khalid, actorOf(khalid));
  const offer = await rec.createOffer(
    { applicantId: String(created[0]._id), positionId: fieldPos ? String(fieldPos._id) : undefined, directManagerId: String((await emp('khalid@eayni.local'))._id), employmentType: 'full_time', contractType: 'fixed_term', durationMonths: 12, probationDays: 90, wagePeriod: 'monthly', basicSalaryHalalas: 450_000, allowances: [{ type: 'سكن', amountHalalas: 100_000 }, { type: 'نقل', amountHalalas: 40_000 }], renewalClause: { enabled: true, periodMonths: 12 }, awardExcludesVariableWage: false, startDate: addDays(today, 30), validUntil: addDays(today, 10) },
    sara,
    actorOf(sara),
  );
  const reload = async () => (await Offer.findById(offer._id))!;
  await rec.transitionOffer(offer, 'submit', { user: sara, actor: actorOf(sara) });
  await rec.transitionOffer(await reload(), 'approve', { user: noura, actor: actorOf(noura) });
  await rec.transitionOffer(await reload(), 'send', { user: sara, actor: actorOf(sara) });
  await rec.transitionOffer(await reload(), 'accept', { user: sara, actor: actorOf(sara), acceptedAt: today });
  await rec.createRequisition({ departmentId: String(sales._id), titleAr: 'مندوب مبيعات', headcount: 1, justification: 'تغطية المنطقة الشرقية', employmentType: 'full_time', contractType: 'open_ended', requirements: 'خبرة سنتان في البيع المؤسسي', recruitmentCosts: [], draft: true }, sultan, actorOf(sultan));

  // ---- End of service [HR §3.10]: a resignation under the art. 79 bis clock (talal), and an HR-initiated ending in progress (fahad).
  const talal = await emp('talal@eayni.local');
  await eos.resign(talal, { reason: 'فرصة عمل أخرى', attachmentIds: [] }, talalUser, actorOf(talalUser));
  const fahad = await emp('fahad@eayni.local');
  const o = await eos.createOffboarding({ employeeId: String(fahad._id), reason: 'employer_notice', noticeDate: addDays(today, -5), lastWorkingDay: addDays(today, 60), details: 'إعادة هيكلة فريق التشغيل', attachmentIds: [] }, sara, actorOf(sara));
  const approved = await eos.transitionOffboarding(o, 'approve', { user: noura, actor: actorOf(noura) });
  await eos.computeSettlement(approved, sara, actorOf(sara));
  return { requisitions: 2, applicants: applicants.length, offers: 1, offboardings: 2 };
}
