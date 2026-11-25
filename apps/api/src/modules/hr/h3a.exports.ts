import {
  APPRAISAL_STATE_AR,
  DISCIPLINARY_STATE_AR,
  GOAL_STATE_AR,
  INVESTIGATION_MODE_AR,
  PARTICIPANT_STATUS_AR,
  PAYROLL_RUN_STATE_AR,
  TRAINING_KIND_AR,
  TRAINING_STATE_AR,
  type AppraisalState,
  type DisciplinaryState,
  type GoalState,
  type InvestigationMode,
  type ParticipantStatus,
  type PayrollRunState,
  type TrainingState,
} from '@eayni/shared';
import { registerExportResource, type ExportResource } from '../../core/export/service';
import type { Authz } from '../../core/http/context';
import { Department } from '../../core/org/model';
import { User } from '../../core/auth/model';
import { Employee } from './model';
import { employeeScopeFilter } from './service';
import { PayrollRun, Payslip } from './payroll.model';
import { Appraisal, AppraisalCycle, DisciplinaryAction, Goal } from './performance.model';
import { Training, TrainingParticipant } from './training.model';

type Filters = Record<string, unknown>;
const riyals = (h: unknown) => (typeof h === 'number' ? h / 100 : '');

async function scopedEmployees(filters: Filters, authz: Authz, userId: string) {
  const user = await User.findById(userId);
  if (!user) return [];
  const f: Record<string, unknown> = { deletedAt: null, ...(await employeeScopeFilter(authz, user)) };
  if (typeof filters.departmentId === 'string' && filters.departmentId) f.departmentId = filters.departmentId;
  if (typeof filters.branchId === 'string' && filters.branchId) f.branchId = filters.branchId;
  const raw = Array.isArray(filters.employeeIds) ? filters.employeeIds : typeof filters.employeeIds === 'string' && filters.employeeIds ? filters.employeeIds.split(',') : [];
  const ids = raw.map(String).filter((x) => /^[0-9a-f]{24}$/i.test(x));
  if (ids.length) f.$and = [{ _id: { $in: ids } }];
  return Employee.find(f).select('fullNameAr employeeNumber departmentId branchId').lean();
}
async function deptNames() {
  const d = await Department.find().select('nameAr').lean();
  return new Map(d.map((x) => [String(x._id), x.nameAr]));
}
const EMP = [
  { key: 'employeeNumber', labelAr: 'الرقم الوظيفي' },
  { key: 'fullNameAr', labelAr: 'الاسم' },
  { key: 'departmentName', labelAr: 'القسم' },
];

/** H3a export resources (HR_PLAN §7.5): payroll register (sensitive), appraisals, goals, trainings, participants, discipline. */
export function registerH3aExports(): void {
  const resources: ExportResource[] = [
    {
      resource: 'hr.payroll_register',
      labelAr: 'سجل مسير الرواتب',
      permissionResource: 'hr.payroll',
      fields: [
        { key: 'runNumber', labelAr: 'رقم المسير' },
        { key: 'period', labelAr: 'الفترة' },
        { key: 'stateAr', labelAr: 'حالة المسير' },
        ...EMP,
        { key: 'basic', labelAr: 'الراتب الأساسي', sensitive: true, kind: 'money' },
        { key: 'allowances', labelAr: 'البدلات', sensitive: true, kind: 'money' },
        { key: 'overtime', labelAr: 'العمل الإضافي', sensitive: true, kind: 'money' },
        { key: 'gross', labelAr: 'إجمالي الاستحقاق', sensitive: true, kind: 'money' },
        { key: 'absence', labelAr: 'خصم الغياب', sensitive: true, kind: 'money' },
        { key: 'advance', labelAr: 'قسط السلفة', sensitive: true, kind: 'money' },
        { key: 'gosiEmployee', labelAr: 'التأمينات (الموظف)', sensitive: true, kind: 'money' },
        { key: 'gosiEmployer', labelAr: 'التأمينات (صاحب العمل)', sensitive: true, kind: 'money' },
        { key: 'deductions', labelAr: 'إجمالي الاستقطاعات', sensitive: true, kind: 'money' },
        { key: 'net', labelAr: 'صافي الراتب', sensitive: true, kind: 'money' },
        { key: 'absentDays', labelAr: 'أيام الغياب' },
        { key: 'lateMinutes', labelAr: 'دقائق التأخير' },
        { key: 'bankLast4', labelAr: 'آخر 4 أرقام من الآيبان', sensitive: true },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const f: Record<string, unknown> = { employeeId: { $in: employees.map((e) => e._id) } };
        if (typeof filters.period === 'string' && filters.period) f.period = filters.period;
        else if (typeof filters.year === 'string' && filters.year) f.period = { $regex: `^${filters.year}-` };
        const slips = await Payslip.find(f).sort({ period: -1, employeeNumber: 1 }).limit(limit).lean();
        const runs = await PayrollRun.find({ _id: { $in: slips.map((s) => s.runId) } }).select('number state').lean();
        const rn = new Map(runs.map((r) => [String(r._id), r]));
        const dn = await deptNames();
        const sum = (lines: { code: string; amountHalalas: number }[], pred: (c: string) => boolean) => lines.filter((l) => pred(l.code)).reduce((s, l) => s + l.amountHalalas, 0);
        return slips.map((p) => ({
          runNumber: rn.get(String(p.runId))?.number ?? '',
          period: p.period,
          stateAr: PAYROLL_RUN_STATE_AR[(rn.get(String(p.runId))?.state ?? 'draft') as PayrollRunState],
          employeeNumber: p.employeeNumber,
          fullNameAr: p.fullNameAr,
          departmentName: p.departmentId ? (dn.get(String(p.departmentId)) ?? '') : '',
          basic: riyals(p.basicHalalas),
          allowances: riyals(sum(p.earnings as never, (c) => c.startsWith('allowance'))),
          overtime: riyals(sum(p.earnings as never, (c) => c === 'overtime')),
          gross: riyals(p.grossHalalas),
          absence: riyals(sum(p.deductions as never, (c) => c === 'absence')),
          advance: riyals(sum(p.deductions as never, (c) => c === 'advance_instalment')),
          gosiEmployee: riyals(p.gosiEmployeeHalalas),
          gosiEmployer: riyals(p.gosiEmployerHalalas),
          deductions: riyals(p.deductionsHalalas),
          net: riyals(p.netHalalas),
          absentDays: p.attendance?.absentDays ?? 0,
          lateMinutes: p.attendance?.lateMinutes ?? 0,
          bankLast4: p.bankLast4 ?? '',
        }));
      },
    },
    {
      resource: 'hr.appraisals',
      labelAr: 'تقييمات الأداء',
      permissionResource: 'hr.appraisals',
      fields: [
        ...EMP,
        { key: 'cycleName', labelAr: 'الدورة' },
        { key: 'stateAr', labelAr: 'الحالة' },
        { key: 'overallScore', labelAr: 'الدرجة الإجمالية %', sensitive: true },
        { key: 'rating', labelAr: 'التقدير', sensitive: true },
        { key: 'managerNotes', labelAr: 'ملاحظات المدير المباشر', sensitive: true },
        { key: 'approvedAt', labelAr: 'تاريخ الاعتماد', kind: 'datetime' },
        { key: 'hasPlan', labelAr: 'خطة تحسين' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const f: Record<string, unknown> = { employeeId: { $in: employees.map((e) => e._id) } };
        if (typeof filters.cycleId === 'string' && filters.cycleId) f.cycleId = filters.cycleId;
        if (typeof filters.state === 'string' && filters.state) f.state = filters.state;
        const rows = await Appraisal.find(f).sort({ createdAt: -1 }).limit(limit).lean();
        const cycles = await AppraisalCycle.find({ _id: { $in: rows.map((r) => r.cycleId) } }).select('nameAr').lean();
        const cn = new Map(cycles.map((c) => [String(c._id), c.nameAr]));
        const dn = await deptNames();
        const en = new Map(employees.map((e) => [String(e._id), e]));
        return rows.map((a) => {
          const e = en.get(String(a.employeeId));
          return {
            employeeNumber: e?.employeeNumber ?? '',
            fullNameAr: e?.fullNameAr ?? '',
            departmentName: e ? (dn.get(String(e.departmentId)) ?? '') : '',
            cycleName: cn.get(String(a.cycleId)) ?? '',
            stateAr: APPRAISAL_STATE_AR[a.state as AppraisalState],
            overallScore: typeof a.overallScoreBp === 'number' ? a.overallScoreBp / 100 : '',
            rating: a.overallRatingLabel ?? '',
            managerNotes: a.managerNotes ?? '',
            approvedAt: a.approvedAt ?? '',
            hasPlan: a.improvementPlanId ? 'نعم' : '',
          };
        });
      },
    },
    {
      resource: 'hr.goals',
      labelAr: 'الأهداف الوظيفية',
      permissionResource: 'hr.goals',
      fields: [
        ...EMP,
        { key: 'title', labelAr: 'الهدف' },
        { key: 'kpiNameAr', labelAr: 'مؤشر الأداء المرتبط' },
        { key: 'weight', labelAr: 'الوزن %' },
        { key: 'percent', labelAr: 'نسبة الإنجاز %' },
        { key: 'stateAr', labelAr: 'الحالة' },
        { key: 'dueDate', labelAr: 'تاريخ الاستحقاق' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const f: Record<string, unknown> = { deletedAt: null, employeeId: { $in: employees.map((e) => e._id) } };
        if (typeof filters.state === 'string' && filters.state) f.state = filters.state;
        const rows = await Goal.find(f).sort({ createdAt: -1 }).limit(limit).lean();
        const dn = await deptNames();
        const en = new Map(employees.map((e) => [String(e._id), e]));
        return rows.map((g) => {
          const e = en.get(String(g.employeeId));
          return { employeeNumber: e?.employeeNumber ?? '', fullNameAr: e?.fullNameAr ?? '', departmentName: e ? (dn.get(String(e.departmentId)) ?? '') : '', title: g.title, kpiNameAr: g.kpiNameAr ?? '', weight: g.weightBp / 100, percent: g.percent, stateAr: GOAL_STATE_AR[g.state as GoalState], dueDate: g.dueDate ?? '' };
        });
      },
    },
    {
      resource: 'hr.trainings',
      labelAr: 'الدورات التدريبية',
      permissionResource: 'hr.training',
      fields: [
        { key: 'number', labelAr: 'رقم الدورة' },
        { key: 'title', labelAr: 'اسم الدورة' },
        { key: 'providerName', labelAr: 'الجهة المقدمة' },
        { key: 'kindAr', labelAr: 'النوع' },
        { key: 'startAt', labelAr: 'تاريخ البداية', kind: 'date' },
        { key: 'endAt', labelAr: 'تاريخ النهاية', kind: 'date' },
        { key: 'stateAr', labelAr: 'الحالة' },
        { key: 'participants', labelAr: 'المشاركون' },
        { key: 'completed', labelAr: 'أكملوا' },
        { key: 'cost', labelAr: 'التكلفة', kind: 'money' },
      ],
      query: async ({ filters, limit }) => {
        const f: Record<string, unknown> = { deletedAt: null };
        if (typeof filters.year === 'string' && filters.year) f.startAt = { $gte: new Date(`${filters.year}-01-01T00:00:00+03:00`), $lte: new Date(`${filters.year}-12-31T23:59:59+03:00`) };
        const rows = await Training.find(f).sort({ startAt: -1 }).limit(limit).lean();
        const counts = await TrainingParticipant.aggregate<{ _id: unknown; n: number; completed: number }>([
          { $match: { trainingId: { $in: rows.map((t) => t._id) } } },
          { $group: { _id: '$trainingId', n: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } },
        ]);
        const cn = new Map(counts.map((c) => [String(c._id), c]));
        return rows.map((t) => ({ number: t.number, title: t.title, providerName: t.providerName ?? '', kindAr: TRAINING_KIND_AR[t.kind as keyof typeof TRAINING_KIND_AR], startAt: t.startAt, endAt: t.endAt, stateAr: TRAINING_STATE_AR[t.state as TrainingState], participants: cn.get(String(t._id))?.n ?? 0, completed: cn.get(String(t._id))?.completed ?? 0, cost: riyals(t.costHalalas) }));
      },
    },
    {
      resource: 'hr.training_participants',
      labelAr: 'تقرير التدريب لكل موظف وقسم',
      permissionResource: 'hr.training',
      fields: [
        ...EMP,
        { key: 'trainingNumber', labelAr: 'رقم الدورة' },
        { key: 'title', labelAr: 'الدورة' },
        { key: 'providerName', labelAr: 'الجهة المقدمة' },
        { key: 'startAt', labelAr: 'البداية', kind: 'date' },
        { key: 'endAt', labelAr: 'النهاية', kind: 'date' },
        { key: 'statusAr', labelAr: 'حالة المشاركة' },
        { key: 'result', labelAr: 'النتيجة' },
        { key: 'certificate', labelAr: 'شهادة مرفوعة' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const f: Record<string, unknown> = { employeeId: { $in: employees.map((e) => e._id) } };
        if (typeof filters.status === 'string' && filters.status) f.status = filters.status;
        const parts = await TrainingParticipant.find(f).sort({ createdAt: -1 }).limit(limit).lean();
        const trainings = await Training.find({ _id: { $in: parts.map((p) => p.trainingId) } }).lean();
        const tn = new Map(trainings.map((t) => [String(t._id), t]));
        const dn = await deptNames();
        const en = new Map(employees.map((e) => [String(e._id), e]));
        return parts
          .filter((p) => !filters.year || tn.get(String(p.trainingId))?.startAt.toISOString().startsWith(String(filters.year)))
          .map((p) => {
            const e = en.get(String(p.employeeId));
            const t = tn.get(String(p.trainingId));
            return { employeeNumber: e?.employeeNumber ?? '', fullNameAr: e?.fullNameAr ?? '', departmentName: e ? (dn.get(String(e.departmentId)) ?? '') : '', trainingNumber: t?.number ?? '', title: t?.title ?? '', providerName: t?.providerName ?? '', startAt: t?.startAt ?? '', endAt: t?.endAt ?? '', statusAr: PARTICIPANT_STATUS_AR[p.status as ParticipantStatus], result: p.result ?? '', certificate: p.certificateAttachmentId ? 'نعم' : '' };
          });
      },
    },
    {
      resource: 'hr.discipline',
      labelAr: 'الإنذارات والإجراءات الإدارية',
      permissionResource: 'hr.discipline',
      fields: [
        { key: 'number', labelAr: 'رقم الإجراء' },
        ...EMP,
        { key: 'kindLabelAr', labelAr: 'نوع الإجراء' },
        { key: 'violationDate', labelAr: 'تاريخ المخالفة' },
        { key: 'discoveryDate', labelAr: 'تاريخ اكتشاف المخالفة' },
        { key: 'investigationEndDate', labelAr: 'تاريخ انتهاء التحقيق' },
        { key: 'investigationModeAr', labelAr: 'طريقة التحقيق' },
        { key: 'courtObjectionDeadline', labelAr: 'آخر موعد للاعتراض أمام المحكمة' },
        { key: 'description', labelAr: 'الوصف', sensitive: true },
        { key: 'stateAr', labelAr: 'الحالة' },
        { key: 'fine', labelAr: 'الخصم', sensitive: true, kind: 'money' },
        { key: 'deliveredAt', labelAr: 'تاريخ الإبلاغ', kind: 'datetime' },
        { key: 'appealOutcome', labelAr: 'نتيجة الاعتراض' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const f: Record<string, unknown> = { deletedAt: null, employeeId: { $in: employees.map((e) => e._id) } };
        if (typeof filters.state === 'string' && filters.state) f.state = filters.state;
        if (typeof filters.from === 'string' && filters.from) f.violationDate = { ...(f.violationDate as object), $gte: filters.from };
        if (typeof filters.to === 'string' && filters.to) f.violationDate = { ...(f.violationDate as object), $lte: filters.to };
        const rows = await DisciplinaryAction.find(f).sort({ violationDate: -1 }).limit(limit).lean();
        const dn = await deptNames();
        const en = new Map(employees.map((e) => [String(e._id), e]));
        return rows.map((d) => {
          const e = en.get(String(d.employeeId));
          return { number: d.number, employeeNumber: e?.employeeNumber ?? '', fullNameAr: e?.fullNameAr ?? '', departmentName: e ? (dn.get(String(e.departmentId)) ?? '') : '', kindLabelAr: d.kindLabelAr, violationDate: d.violationDate, discoveryDate: d.discoveryDate ?? '', investigationEndDate: d.investigationEndDate ?? '', investigationModeAr: d.investigationMode ? INVESTIGATION_MODE_AR[d.investigationMode as InvestigationMode] : '', courtObjectionDeadline: d.courtObjectionDeadline ?? '', description: d.description, stateAr: DISCIPLINARY_STATE_AR[d.state as DisciplinaryState], fine: riyals(d.fineHalalas), deliveredAt: d.deliveredAt ?? '', appealOutcome: d.appeal?.outcome ?? '' };
        });
      },
    },
  ];
  for (const r of resources) registerExportResource(r);
}
