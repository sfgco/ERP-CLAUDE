import {
  ATTENDANCE_DAY_STATUS_AR,
  CORRECTION_KIND_AR,
  HR_REQUEST_STATE_AR,
  LEAVE_TYPE_AR,
  LEAVE_TYPES,
  PUNCH_SOURCE_AR,
  PUNCH_TYPE_AR,
  type AttendanceDayStatus,
  type LeaveType,
} from '@eayni/shared';
import { registerExportResource, type ExportResource } from '../../core/export/service';
import type { Authz } from '../../core/http/context';
import { riyadhDate } from '../../core/dates/businessDays';
import { Branch, Department, Site } from '../../core/org/model';
import { User } from '../../core/auth/model';
import { Employee } from './model';
import { HrRequest } from './requests.model';
import { AttendanceDay, AttendancePunch, LeaveLedger } from './attendance.model';
import { employeeScopeFilter } from './service';
import { daysQuery, ensureDaysComputed, summarizeDays } from './attendance.service';
import { balancesFor, leaveDaysCount, leaveDaysInWindow } from './leave.service';

type Filters = Record<string, unknown>;
type Row = Record<string, unknown>;

/** Employees in the viewer's scope narrowed by the common filters (department, branch, chosen employees). */
async function scopedEmployees(filters: Filters, authz: Authz, userId: string) {
  const user = await User.findById(userId);
  if (!user) return [];
  const f: Record<string, unknown> = { deletedAt: null, ...(await employeeScopeFilter(authz, user)) };
  if (typeof filters.departmentId === 'string' && filters.departmentId) f.departmentId = filters.departmentId;
  if (typeof filters.branchId === 'string' && filters.branchId) f.branchId = filters.branchId;
  const raw = Array.isArray(filters.employeeIds)
    ? filters.employeeIds
    : typeof filters.employeeIds === 'string' && filters.employeeIds
      ? filters.employeeIds.split(',')
      : [];
  const ids = raw.map(String).filter((x) => /^[0-9a-f]{24}$/i.test(x));
  if (ids.length) f.$and = [{ _id: { $in: ids } }];
  return Employee.find(f).select('fullNameAr employeeNumber departmentId branchId positionId').lean();
}

/** `from` / `to` Riyadh days from the filters; `month` (YYYY-MM) wins; default the current month. */
function window(filters: Filters): { from: string; to: string } {
  const today = riyadhDate(new Date());
  if (typeof filters.month === 'string' && /^\d{4}-\d{2}$/.test(filters.month)) {
    const [y, m] = filters.month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${filters.month}-01`, to: `${filters.month}-${String(last).padStart(2, '0')}` };
  }
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = typeof filters.from === 'string' && dayRe.test(filters.from) ? filters.from : `${today.slice(0, 7)}-01`;
  const to = typeof filters.to === 'string' && dayRe.test(filters.to) ? filters.to : today;
  return { from, to };
}

async function names() {
  const [depts, branches, sites] = await Promise.all([
    Department.find().select('nameAr').lean(),
    Branch.find().select('nameAr').lean(),
    Site.find().select('nameAr').lean(),
  ]);
  const m = <T extends { _id: unknown; nameAr: string }>(list: T[]) => new Map(list.map((x) => [String(x._id), x.nameAr]));
  return { dept: m(depts), branch: m(branches), site: m(sites) };
}
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const EMPLOYEE_FIELDS = [
  { key: 'employeeNumber', labelAr: 'الرقم الوظيفي' },
  { key: 'fullNameAr', labelAr: 'الاسم' },
  { key: 'departmentName', labelAr: 'القسم' },
  { key: 'branchName', labelAr: 'الفرع' },
];

/** Day rows of the window for the scoped employees, joined with names. */
async function dayRows(filters: Filters, authz: Authz, userId: string, limit: number, extra: Record<string, unknown> = {}) {
  const employees = await scopedEmployees(filters, authz, userId);
  const { from, to } = window(filters);
  const ids = employees.map((e) => e._id);
  await ensureDaysComputed(ids, from, to);
  const rows = await AttendanceDay.find({ ...daysQuery({ employeeIds: ids, from, to }), ...extra })
    .sort({ day: -1, employeeId: 1 })
    .limit(limit)
    .lean();
  const n = await names();
  const byId = new Map(employees.map((e) => [String(e._id), e]));
  return rows.map((r) => {
    const e = byId.get(String(r.employeeId));
    return {
      ...r,
      employeeNumber: e?.employeeNumber ?? '',
      fullNameAr: e?.fullNameAr ?? '',
      departmentName: e ? (n.dept.get(String(e.departmentId)) ?? '') : '',
      branchName: e?.branchId ? (n.branch.get(String(e.branchId)) ?? '') : '',
      statusAr: ATTENDANCE_DAY_STATUS_AR[r.status as AttendanceDayStatus] ?? r.status,
      workedHours: hours(r.workedMinutes),
      overtimeHours: hours(r.overtimeMinutes),
      overtimeApprovedHours: hours(r.overtimeApprovedMinutes),
    } as Row;
  });
}

/** The eight reports of HR §3.4 خامساً plus the two leave reports (HR_PLAN §7.5), on the core export builder [HR §4]. */
export function registerAttendanceExports(): void {
  const permissionResource = 'hr.attendance.reports';
  const resources: ExportResource[] = [
    {
      resource: 'hr.attendance_log',
      labelAr: 'سجل الحضور والانصراف',
      permissionResource,
      fields: [
        ...EMPLOYEE_FIELDS,
        { key: 'day', labelAr: 'اليوم' },
        { key: 'typeAr', labelAr: 'العملية' },
        { key: 'at', labelAr: 'الوقت', kind: 'datetime' },
        { key: 'siteName', labelAr: 'الموقع' },
        { key: 'withinAr', labelAr: 'داخل النطاق' },
        { key: 'distanceM', labelAr: 'المسافة (م)' },
        { key: 'sourceAr', labelAr: 'المصدر' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const { from, to } = window(filters);
        const rows = await AttendancePunch.find({ employeeId: { $in: employees.map((e) => e._id) }, day: { $gte: from, $lte: to } })
          .sort({ at: -1 })
          .limit(limit)
          .lean();
        const n = await names();
        const byId = new Map(employees.map((e) => [String(e._id), e]));
        return rows.map((p) => {
          const e = byId.get(String(p.employeeId));
          return {
            employeeNumber: e?.employeeNumber ?? '',
            fullNameAr: e?.fullNameAr ?? '',
            departmentName: e ? (n.dept.get(String(e.departmentId)) ?? '') : '',
            branchName: e?.branchId ? (n.branch.get(String(e.branchId)) ?? '') : '',
            day: p.day,
            typeAr: PUNCH_TYPE_AR[p.type as 'in' | 'out'],
            at: p.at,
            siteName: p.siteId ? (n.site.get(String(p.siteId)) ?? '') : '',
            withinAr: p.withinGeofence === null || p.withinGeofence === undefined ? '—' : p.withinGeofence ? 'نعم' : p.exceptionId ? 'لا (استثناء معتمد)' : 'لا',
            distanceM: p.distanceM ?? '',
            sourceAr: PUNCH_SOURCE_AR[p.source as keyof typeof PUNCH_SOURCE_AR] ?? p.source,
          };
        });
      },
    },
    {
      resource: 'hr.lateness_log',
      labelAr: 'سجل التأخير',
      permissionResource,
      fields: [
        ...EMPLOYEE_FIELDS,
        { key: 'day', labelAr: 'اليوم' },
        { key: 'expectedStart', labelAr: 'بداية الدوام', kind: 'datetime' },
        { key: 'firstInAt', labelAr: 'وقت الحضور', kind: 'datetime' },
        { key: 'lateMinutes', labelAr: 'دقائق التأخير' },
        { key: 'permissionMinutes', labelAr: 'دقائق الاستئذان المعتمد' },
      ],
      query: ({ filters, authz, userId, limit }) => dayRows(filters, authz, userId, limit, { lateMinutes: { $gt: 0 } }),
    },
    {
      resource: 'hr.absence_log',
      labelAr: 'سجل الغياب',
      permissionResource,
      fields: [
        ...EMPLOYEE_FIELDS,
        { key: 'day', labelAr: 'اليوم' },
        { key: 'statusAr', labelAr: 'الحالة' },
        { key: 'expectedStart', labelAr: 'بداية الدوام', kind: 'datetime' },
        { key: 'expectedEnd', labelAr: 'نهاية الدوام', kind: 'datetime' },
      ],
      query: ({ filters, authz, userId, limit }) => dayRows(filters, authz, userId, limit, { status: 'absent' }),
    },
    {
      resource: 'hr.hours_overtime',
      labelAr: 'إجمالي ساعات العمل والعمل الإضافي',
      permissionResource,
      fields: [
        ...EMPLOYEE_FIELDS,
        { key: 'day', labelAr: 'اليوم' },
        { key: 'statusAr', labelAr: 'الحالة' },
        { key: 'firstInAt', labelAr: 'الحضور', kind: 'datetime' },
        { key: 'lastOutAt', labelAr: 'الانصراف', kind: 'datetime' },
        { key: 'workedHours', labelAr: 'ساعات العمل الفعلية' },
        { key: 'overtimeHours', labelAr: 'ساعات إضافية (مسجّلة)' },
        { key: 'overtimeApprovedHours', labelAr: 'ساعات إضافية (معتمدة)' },
      ],
      query: ({ filters, authz, userId, limit }) => dayRows(filters, authz, userId, limit, { scheduled: true }),
    },
    {
      resource: 'hr.corrections',
      labelAr: 'طلبات تعديل البصمة',
      permissionResource,
      fields: [
        { key: 'number', labelAr: 'رقم الطلب' },
        ...EMPLOYEE_FIELDS,
        { key: 'day', labelAr: 'اليوم' },
        { key: 'kindAr', labelAr: 'نوع التعديل' },
        { key: 'requestedTime', labelAr: 'الوقت المطلوب' },
        { key: 'reason', labelAr: 'السبب' },
        { key: 'createdAt', labelAr: 'تاريخ الطلب', kind: 'datetime' },
        { key: 'stateAr', labelAr: 'الحالة' },
        { key: 'decisionAt', labelAr: 'تاريخ القرار', kind: 'datetime' },
        { key: 'decisionReason', labelAr: 'سبب القرار' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const { from, to } = window(filters);
        const rows = await HrRequest.find({
          deletedAt: null,
          type: 'attendance_correction',
          employeeId: { $in: employees.map((e) => e._id) },
          'details.day': { $gte: from, $lte: to },
        })
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean();
        const n = await names();
        const byId = new Map(employees.map((e) => [String(e._id), e]));
        return rows.map((r) => {
          const e = byId.get(String(r.employeeId));
          const d = r.details as { day: string; kind: keyof typeof CORRECTION_KIND_AR; requestedTime: string; reason: string };
          return {
            number: r.number,
            employeeNumber: e?.employeeNumber ?? '',
            fullNameAr: e?.fullNameAr ?? '',
            departmentName: e ? (n.dept.get(String(e.departmentId)) ?? '') : '',
            branchName: e?.branchId ? (n.branch.get(String(e.branchId)) ?? '') : '',
            day: d.day,
            kindAr: CORRECTION_KIND_AR[d.kind] ?? d.kind,
            requestedTime: d.requestedTime,
            reason: d.reason,
            createdAt: r.createdAt,
            stateAr: HR_REQUEST_STATE_AR[r.state] ?? r.state,
            decisionAt: r.decision?.at ?? '',
            decisionReason: r.decision?.reason ?? '',
          };
        });
      },
    },
    {
      resource: 'hr.attendance_monthly_employee',
      labelAr: 'تقرير الحضور الشهري لكل موظف',
      permissionResource,
      fields: [
        ...EMPLOYEE_FIELDS,
        { key: 'period', labelAr: 'الفترة' },
        { key: 'scheduledDays', labelAr: 'أيام العمل المجدولة' },
        { key: 'presentDays', labelAr: 'أيام الحضور' },
        { key: 'lateDays', labelAr: 'أيام التأخير' },
        { key: 'lateMinutes', labelAr: 'دقائق التأخير' },
        { key: 'absentDays', labelAr: 'أيام الغياب' },
        { key: 'leaveDays', labelAr: 'أيام الإجازة' },
        { key: 'remoteDays', labelAr: 'أيام العمل عن بُعد' },
        { key: 'missingPunchDays', labelAr: 'أيام بلا تسجيل حضور أو انصراف' },
        { key: 'earlyLeaveDays', labelAr: 'أيام الانصراف المبكر' },
        { key: 'workedHours', labelAr: 'ساعات العمل الفعلية' },
        { key: 'overtimeApprovedHours', labelAr: 'ساعات إضافية معتمدة' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const { from, to } = window(filters);
        const ids = employees.map((e) => e._id);
        await ensureDaysComputed(ids, from, to);
        const rows = await AttendanceDay.find(daysQuery({ employeeIds: ids, from, to })).lean();
        const n = await names();
        const byEmp = new Map<string, typeof rows>();
        for (const r of rows) {
          const k = String(r.employeeId);
          byEmp.set(k, [...(byEmp.get(k) ?? []), r]);
        }
        return employees.slice(0, limit).map((e) => {
          const s = summarizeDays((byEmp.get(String(e._id)) ?? []) as never);
          return {
            employeeNumber: e.employeeNumber,
            fullNameAr: e.fullNameAr,
            departmentName: n.dept.get(String(e.departmentId)) ?? '',
            branchName: e.branchId ? (n.branch.get(String(e.branchId)) ?? '') : '',
            period: `${from} → ${to}`,
            ...s,
            workedHours: hours(s.workedMinutes),
            overtimeApprovedHours: hours(s.overtimeApprovedMinutes),
          };
        });
      },
    },
    {
      resource: 'hr.attendance_totals',
      labelAr: 'تقرير إجمالي الحضور لكل قسم أو فرع',
      permissionResource,
      fields: [
        { key: 'groupAr', labelAr: 'القسم / الفرع' },
        { key: 'period', labelAr: 'الفترة' },
        { key: 'employees', labelAr: 'عدد الموظفين' },
        { key: 'scheduledDays', labelAr: 'أيام العمل المجدولة' },
        { key: 'presentDays', labelAr: 'أيام الحضور' },
        { key: 'lateDays', labelAr: 'أيام التأخير' },
        { key: 'absentDays', labelAr: 'أيام الغياب' },
        { key: 'leaveDays', labelAr: 'أيام الإجازة' },
        { key: 'missingPunchDays', labelAr: 'أيام بلا تسجيل' },
        { key: 'workedHours', labelAr: 'ساعات العمل الفعلية' },
        { key: 'overtimeApprovedHours', labelAr: 'ساعات إضافية معتمدة' },
        { key: 'attendanceRateBp', labelAr: 'نسبة الحضور %' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const { from, to } = window(filters);
        const ids = employees.map((e) => e._id);
        await ensureDaysComputed(ids, from, to);
        const rows = await AttendanceDay.find(daysQuery({ employeeIds: ids, from, to })).lean();
        const n = await names();
        const by = filters.groupBy === 'branch' ? 'branch' : 'department';
        const groupOf = (e: { departmentId?: unknown; branchId?: unknown }) =>
          by === 'branch' ? (e.branchId ? (n.branch.get(String(e.branchId)) ?? '—') : '—') : (n.dept.get(String(e.departmentId)) ?? '—');
        const empGroup = new Map(employees.map((e) => [String(e._id), groupOf(e)]));
        const groups = new Map<string, { employees: Set<string>; days: typeof rows }>();
        for (const e of employees) {
          const g = empGroup.get(String(e._id))!;
          if (!groups.has(g)) groups.set(g, { employees: new Set(), days: [] });
          groups.get(g)!.employees.add(String(e._id));
        }
        for (const r of rows) {
          const g = empGroup.get(String(r.employeeId));
          if (g) groups.get(g)!.days.push(r);
        }
        return [...groups.entries()].slice(0, limit).map(([groupAr, g]) => {
          const s = summarizeDays(g.days as never);
          const denominator = s.scheduledDays - s.leaveDays;
          return {
            groupAr,
            period: `${from} → ${to}`,
            employees: g.employees.size,
            ...s,
            workedHours: hours(s.workedMinutes),
            overtimeApprovedHours: hours(s.overtimeApprovedMinutes),
            attendanceRateBp: denominator > 0 ? Math.round(((s.presentDays + s.remoteDays) / denominator) * 100) : '',
          };
        });
      },
    },
    {
      resource: 'hr.leave_balances',
      labelAr: 'أرصدة الإجازات',
      permissionResource: 'hr.leave',
      fields: [
        ...EMPLOYEE_FIELDS,
        { key: 'year', labelAr: 'السنة' },
        { key: 'leaveTypeAr', labelAr: 'نوع الإجازة' },
        { key: 'entitlementDays', labelAr: 'الاستحقاق السنوي' },
        { key: 'accrued', labelAr: 'المستحق حتى الآن' },
        { key: 'taken', labelAr: 'المأخوذ' },
        { key: 'balance', labelAr: 'الرصيد' },
        { key: 'provisionalAr', labelAr: 'مؤقت حتى اعتماد الموارد البشرية' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const year = Number(filters.year) || Number(riyadhDate(new Date()).slice(0, 4));
        const types = typeof filters.leaveType === 'string' && (LEAVE_TYPES as readonly string[]).includes(filters.leaveType) ? [filters.leaveType as LeaveType] : ['annual', 'sick'];
        const n = await names();
        const out: Row[] = [];
        for (const e of employees) {
          if (out.length >= limit) break;
          const full = await Employee.findById(e._id);
          if (!full) continue;
          for (const b of (await balancesFor(full, year)).filter((b) => types.includes(b.leaveType))) {
            out.push({
              employeeNumber: e.employeeNumber,
              fullNameAr: e.fullNameAr,
              departmentName: n.dept.get(String(e.departmentId)) ?? '',
              branchName: e.branchId ? (n.branch.get(String(e.branchId)) ?? '') : '',
              year,
              leaveTypeAr: b.labelAr,
              entitlementDays: b.entitlementDays ?? 'غير محدد',
              accrued: b.accrued,
              taken: b.taken,
              balance: b.balance,
              provisionalAr: b.provisional ? 'نعم' : '',
            });
          }
        }
        return out;
      },
    },
    {
      resource: 'hr.leave_taken',
      labelAr: 'الإجازات المعتمدة',
      permissionResource: 'hr.leave',
      fields: [
        { key: 'number', labelAr: 'رقم الطلب' },
        ...EMPLOYEE_FIELDS,
        { key: 'leaveTypeAr', labelAr: 'نوع الإجازة' },
        { key: 'startDate', labelAr: 'من', kind: 'date' },
        { key: 'endDate', labelAr: 'إلى', kind: 'date' },
        { key: 'days', labelAr: 'الأيام' },
        { key: 'daysInPeriod', labelAr: 'الأيام داخل الفترة' },
        { key: 'decisionAt', labelAr: 'تاريخ الاعتماد', kind: 'datetime' },
      ],
      query: async ({ filters, authz, userId, limit }) => {
        const employees = await scopedEmployees(filters, authz, userId);
        const { from, to } = window(filters);
        const rows = await HrRequest.find({
          deletedAt: null,
          type: 'leave',
          employeeId: { $in: employees.map((e) => e._id) },
          $or: [{ state: 'approved' }, { state: 'closed', 'decision.outcome': 'approved' }],
          'details.startDate': { $lte: new Date(`${to}T23:59:59+03:00`) },
          'details.endDate': { $gte: new Date(`${from}T00:00:00+03:00`) },
        })
          .sort({ 'details.startDate': -1 })
          .limit(limit)
          .lean();
        const n = await names();
        const byId = new Map(employees.map((e) => [String(e._id), e]));
        return rows.map((r) => {
          const e = byId.get(String(r.employeeId));
          const d = r.details as { leaveType: LeaveType; startDate: Date; endDate: Date };
          return {
            number: r.number,
            employeeNumber: e?.employeeNumber ?? '',
            fullNameAr: e?.fullNameAr ?? '',
            departmentName: e ? (n.dept.get(String(e.departmentId)) ?? '') : '',
            branchName: e?.branchId ? (n.branch.get(String(e.branchId)) ?? '') : '',
            leaveTypeAr: LEAVE_TYPE_AR[d.leaveType] ?? d.leaveType,
            startDate: d.startDate,
            endDate: d.endDate,
            days: leaveDaysCount(new Date(d.startDate), new Date(d.endDate)),
            daysInPeriod: leaveDaysInWindow(new Date(d.startDate), new Date(d.endDate), from, to),
            decisionAt: r.decision?.at ?? '',
          };
        });
      },
    },
  ];
  for (const r of resources) registerExportResource(r);
  void LeaveLedger;
}
