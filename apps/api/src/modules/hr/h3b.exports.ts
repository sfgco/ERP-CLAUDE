import { APPLICANT_STAGE_AR, EOS_REASON_AR, OFFBOARDING_STATE_AR, OFFER_STATE_AR, REQUISITION_STATE_AR, SETTLEMENT_STATE_AR, type ApplicantStage, type EosReason, type OffboardingState, type OfferState, type RequisitionState, type SettlementState } from '@eayni/shared';
import { registerExportResource, type ExportResource } from '../../core/export/service';
import { Department } from '../../core/org/model';
import { User } from '../../core/auth/model';
import { Employee } from './model';
import { Applicant, JobRequisition, Offer } from './recruitment.model';
import { Offboarding } from './offboarding.model';
import { requisitionVisibility, visibilityFilter } from './h3b.visibility';

type Filters = Record<string, unknown>;
const riyals = (h: unknown) => (typeof h === 'number' ? h / 100 : '');

/** H3b export resources (HR_PLAN §7.5): requisitions, applicants, offers (salary sensitive), end-of-service records (settlement sensitive). */
export function registerH3bExports(): void {
  const resources: ExportResource[] = [
    {
      resource: 'hr.requisitions',
      labelAr: 'طلبات التوظيف',
      permissionResource: 'hr.recruitment',
      fields: [
        { key: 'number', labelAr: 'رقم الطلب' },
        { key: 'titleAr', labelAr: 'الوظيفة' },
        { key: 'departmentName', labelAr: 'القسم' },
        { key: 'headcount', labelAr: 'العدد المطلوب' },
        { key: 'hiredCount', labelAr: 'تم تعيينهم' },
        { key: 'stateAr', labelAr: 'الحالة' },
        { key: 'createdAt', labelAr: 'تاريخ الطلب', kind: 'datetime' },
        { key: 'postedAt', labelAr: 'تاريخ الإعلان', kind: 'datetime' },
        { key: 'salaryMin', labelAr: 'الحد الأدنى للراتب (ر.س)', sensitive: true, kind: 'money' },
        { key: 'salaryMax', labelAr: 'الحد الأعلى للراتب (ر.س)', sensitive: true, kind: 'money' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const user = await User.findById(userId);
        if (!user) return [];
        const f: Filters = { deletedAt: null, ...requisitionVisibility(user, authz) };
        if (typeof filters.state === 'string' && filters.state) f.state = filters.state;
        if (typeof filters.departmentId === 'string' && filters.departmentId) f.departmentId = filters.departmentId;
        const rows = await JobRequisition.find(f).sort({ createdAt: -1 }).limit(limit).lean();
        const depts = new Map((await Department.find().select('nameAr').lean()).map((d) => [String(d._id), d.nameAr]));
        return rows.map((r) => ({ ...r, departmentName: depts.get(String(r.departmentId)) ?? '', stateAr: REQUISITION_STATE_AR[r.state as RequisitionState], postedAt: r.posting?.postedAt, salaryMin: riyals(r.salaryRange?.minHalalas), salaryMax: riyals(r.salaryRange?.maxHalalas) })) as unknown as Record<string, unknown>[];
      },
    },
    {
      resource: 'hr.applicants',
      labelAr: 'المرشحون',
      permissionResource: 'hr.recruitment',
      fields: [
        { key: 'requisitionNumber', labelAr: 'رقم طلب التوظيف' },
        { key: 'fullNameAr', labelAr: 'الاسم' },
        { key: 'nationality', labelAr: 'الجنسية' },
        { key: 'phone', labelAr: 'الجوال' },
        { key: 'email', labelAr: 'البريد' },
        { key: 'source', labelAr: 'المصدر' },
        { key: 'stageAr', labelAr: 'المرحلة' },
        { key: 'rejectionReason', labelAr: 'سبب الرفض' },
        { key: 'createdAt', labelAr: 'تاريخ التقديم', kind: 'datetime' },
        { key: 'expectedSalary', labelAr: 'الراتب المتوقع (ر.س)', sensitive: true, kind: 'money' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const user = await User.findById(userId);
        if (!user) return [];
        const reqs = await JobRequisition.find({ deletedAt: null, ...requisitionVisibility(user, authz), ...(typeof filters.requisitionId === 'string' && filters.requisitionId ? { _id: filters.requisitionId } : {}) }).select('number').lean();
        const numbers = new Map(reqs.map((r) => [String(r._id), r.number]));
        const f: Filters = { deletedAt: null, requisitionId: { $in: reqs.map((r) => r._id) } };
        if (typeof filters.stage === 'string' && filters.stage) f.stage = filters.stage;
        const rows = await Applicant.find(f).sort({ createdAt: -1 }).limit(limit).lean();
        return rows.map((a) => ({ ...a, identityNumberEnc: undefined, requisitionNumber: numbers.get(String(a.requisitionId)) ?? '', stageAr: APPLICANT_STAGE_AR[a.stage as ApplicantStage], expectedSalary: riyals(a.expectedSalaryHalalas) })) as unknown as Record<string, unknown>[];
      },
    },
    {
      resource: 'hr.offers',
      labelAr: 'العروض الوظيفية',
      permissionResource: 'hr.offers',
      fields: [
        { key: 'number', labelAr: 'رقم العرض' },
        { key: 'applicantName', labelAr: 'المرشح' },
        { key: 'departmentName', labelAr: 'القسم' },
        { key: 'contractType', labelAr: 'نوع العقد' },
        { key: 'startDate', labelAr: 'تاريخ المباشرة' },
        { key: 'stateAr', labelAr: 'الحالة' },
        { key: 'qiwaRef', labelAr: 'مرجع قوى' },
        { key: 'gosiRef', labelAr: 'مرجع التأمينات' },
        { key: 'basic', labelAr: 'الراتب الأساسي (ر.س)', sensitive: true, kind: 'money' },
      ],
      query: async ({ filters, authz, limit }) => {
        const f: Filters = { deletedAt: null };
        if (authz.scope === 'department') f.departmentId = { $in: authz.departmentIds };
        if (typeof filters.state === 'string' && filters.state) f.state = filters.state;
        const rows = await Offer.find(f).sort({ createdAt: -1 }).limit(limit).lean();
        const [depts, apps] = await Promise.all([Department.find().select('nameAr').lean(), Applicant.find({ _id: { $in: rows.map((o) => o.applicantId) } }).select('fullNameAr').lean()]);
        const dn = new Map(depts.map((d) => [String(d._id), d.nameAr]));
        const an = new Map(apps.map((a) => [String(a._id), a.fullNameAr]));
        return rows.map((o) => ({ ...o, applicantName: an.get(String(o.applicantId)) ?? '', departmentName: dn.get(String(o.departmentId)) ?? '', stateAr: OFFER_STATE_AR[o.state as OfferState], qiwaRef: o.govRegistration?.qiwaRef ?? '', gosiRef: o.govRegistration?.gosiRef ?? '', basic: riyals(o.basicSalaryHalalas) })) as unknown as Record<string, unknown>[];
      },
    },
    {
      resource: 'hr.offboardings',
      labelAr: 'إنهاء الخدمة',
      permissionResource: 'hr.offboarding',
      fields: [
        { key: 'number', labelAr: 'رقم الإجراء' },
        { key: 'employeeNumber', labelAr: 'الرقم الوظيفي' },
        { key: 'employeeName', labelAr: 'الموظف' },
        { key: 'departmentName', labelAr: 'القسم' },
        { key: 'reasonAr', labelAr: 'السبب (المادة)' },
        { key: 'lastWorkingDay', labelAr: 'آخر يوم عمل' },
        { key: 'stateAr', labelAr: 'الحالة' },
        { key: 'settlementStateAr', labelAr: 'حالة المخالصة' },
        { key: 'settlementDue', labelAr: 'مهلة السداد (المادة 88)', kind: 'datetime' },
        { key: 'completedAt', labelAr: 'تاريخ الإقفال', kind: 'datetime' },
        { key: 'eosAward', labelAr: 'مكافأة نهاية الخدمة (ر.س)', sensitive: true, kind: 'money' },
        { key: 'settlementNet', labelAr: 'صافي المخالصة (ر.س)', sensitive: true, kind: 'money' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const user = await User.findById(userId);
        if (!user) return [];
        const me = await Employee.findOne({ userId: user._id, deletedAt: null }).select('_id').lean();
        const f: Filters = { deletedAt: null, ...visibilityFilter(user, authz, me?._id) };
        if (typeof filters.state === 'string' && filters.state) f.state = filters.state;
        if (typeof filters.departmentId === 'string' && filters.departmentId) f.departmentId = filters.departmentId;
        const rows = await Offboarding.find(f).sort({ createdAt: -1 }).limit(limit).lean();
        const [depts, emps] = await Promise.all([Department.find().select('nameAr').lean(), Employee.find({ _id: { $in: rows.map((o) => o.employeeId) } }).select('fullNameAr employeeNumber').lean()]);
        const dn = new Map(depts.map((d) => [String(d._id), d.nameAr]));
        const en = new Map(emps.map((e) => [String(e._id), e]));
        return rows.map((o) => ({
          ...o,
          employeeName: en.get(String(o.employeeId))?.fullNameAr ?? '',
          employeeNumber: en.get(String(o.employeeId))?.employeeNumber ?? '',
          departmentName: dn.get(String(o.departmentId)) ?? '',
          reasonAr: EOS_REASON_AR[o.reason as EosReason],
          stateAr: OFFBOARDING_STATE_AR[o.state as OffboardingState],
          settlementStateAr: SETTLEMENT_STATE_AR[(o.settlement?.state ?? 'pending') as SettlementState],
          settlementDue: o.settlement?.dueAt,
          eosAward: riyals(o.settlement?.lines?.find((l) => l.code === 'eos_award')?.amountHalalas),
          settlementNet: riyals(o.settlement?.netHalalas),
        })) as unknown as Record<string, unknown>[];
      },
    },
  ];
  for (const r of resources) registerExportResource(r);
}
