import { registerJob } from '../../core/jobs/registry';
import { registerTeamResolver } from '../../core/rbac/scope';
import { registerExpiryRecipients } from '../../core/documents/service';
import {
  registerRecordAccess,
  registerSensitiveOwnerType,
  registerSensitiveViewer,
} from '../../core/access/registry';
import { effectivePermission } from '../../core/rbac/service';
import type { RoleAssignment } from '@eayni/shared';
import type { AuthedRequest } from '../../core/http/context';
import { ProfileChangeRequest } from './profileChanges.model';
import { HrRequest } from './requests.model';
import { EmployeeReport } from './reports.model';
import { visibilityFilter as reportsVisibility } from './reports.service';
import { registerExportResource } from '../../core/export/service';
import { Employee } from './model';
import { EXPIRING_KINDS, EXPIRING_KIND_AR, expiringRows, type ExpiringKind } from './expiring';
import { employeeScopeFilter, hrUserIds, teamUserIdsOf } from './service';
import {
  registerRequestHandlers,
  runRequestAutoClose,
  runRequestOverdueReminders,
  visibilityFilter,
} from './requests.service';
import { registerAssigneeDirectory, registerTaskSourceResolver } from '../../core/tasks/service';
import { registerPeopleSearch } from '../../core/records/resolvers';
import { registerCalendarSource } from '../../core/calendar/sources';
import { arabicSearchRegex } from '@eayni/shared';
import { ON_DUTY_STATUSES } from './service';
import { runAttendanceCompute } from './attendance.service';
import { runLeaveAccrual } from './leave.service';
import { registerAttendanceExports } from './attendance.exports';
import { registerH3aExports } from './h3a.exports';
import { runPayrollCutoffReminder } from './payroll.service';
import { registerPerformanceHandlers, runAppraisalJobs, runPerformanceFollowUps } from './performance.service';
import { runTrainingReminders } from './training.service';
import { Training } from './training.model';
import { ImprovementPlan } from './performance.model';
import type { RoleDefinition } from '@eayni/shared';
import {
  runAccountDeactivation,
  runBirthdayGreetings,
  runContractAlerts,
  runIdentityAlerts,
  runProbationAlerts,
  runSecondmentReportReminders,
} from './jobs';

let registered = false;
/** Wire the HR module into the platform core (scopes, documents, jobs, exports). Idempotent. */
export function registerHrModule(): void {
  if (registered) return;
  registered = true;

  registerTeamResolver(teamUserIdsOf);
  registerRequestHandlers();
  // Tasks: who may be assigned work comes from the employee file (EP §16); requests can be a task's source.
  registerAssigneeDirectory({
    async lookup(userId) {
      const e = await Employee.findOne({ userId, deletedAt: null })
        .select('fullNameAr departmentId directManagerId status')
        .lean();
      if (!e) return null;
      const mgr = e.directManagerId
        ? await Employee.findById(e.directManagerId).select('userId').lean()
        : null;
      return {
        userId,
        employeeId: String(e._id),
        fullNameAr: e.fullNameAr,
        departmentId: String(e.departmentId),
        managerUserId: mgr?.userId ? String(mgr.userId) : undefined,
        active: (ON_DUTY_STATUSES as readonly string[]).includes(e.status),
      };
    },
  });
  registerTaskSourceResolver('hr_request', async (idOrNumber) => {
    const r = await HrRequest.findOne({
      deletedAt: null,
      $or: [
        /^[0-9a-f]{24}$/i.test(idOrNumber) ? { _id: idOrNumber } : { number: idOrNumber },
        { number: idOrNumber },
      ],
    })
      .select('number type')
      .lean();
    return r ? { id: String(r._id), label: r.number } : null;
  });
  registerJob('hr.requests.overdue', (now) => runRequestOverdueReminders(now));
  registerJob('hr.requests.autoclose', (now) => runRequestAutoClose(now));

  // Employee documents: expiry recipients and who may read them [HR §3.9, EP §5.2].
  registerExpiryRecipients('employee', async (ownerId) => {
    const e = await Employee.findById(ownerId).select('userId directManagerId').lean();
    const ids = await hrUserIds();
    if (e?.userId) ids.push(String(e.userId));
    return ids;
  });
  // Record access for files, documents and comments hanging on HR records (security review A3/A4).
  // Each checker evaluates the user's permission on the HR resource itself, not on the calling resource.
  const permissionOn = async (req: AuthedRequest, resource: string) =>
    effectivePermission(
      req.auth.user.roles as RoleAssignment[],
      req.auth.user.departmentId ? String(req.auth.user.departmentId) : undefined,
      resource,
      'view',
    );
  registerRecordAccess('employee', async (req, ownerId, ctx) => {
    const eff = await permissionOn(req, 'hr.employees');
    if (!eff) return false;
    if (eff.scope === 'all') return true;
    // Team scope comes from the org chart alone (DECISIONS §4, §19): it never widens file access, so only a real
    // grant (department) or the own record passes here; the direct-manager branch below handles the team.
    const filter =
      eff.scope === 'team'
        ? { userId: req.auth.user._id }
        : await employeeScopeFilter({ resource: 'hr.employees', action: 'view', ...eff }, req.auth.user);
    if (await Employee.exists({ _id: ownerId, deletedAt: null, ...filter })) return true;
    // A direct manager (org chart, not a role) sees the record; of its files only the photo and secondment reports (review E2, §19).
    const me = await Employee.findOne({ userId: req.auth.user._id, deletedAt: null }).select('_id').lean();
    if (!me) return false;
    const report = await Employee.findOne({ _id: ownerId, deletedAt: null, directManagerId: me._id })
      .select('photoAttachmentId secondment.reportAttachmentId secondmentHistory.reportAttachmentId')
      .lean();
    if (!report) return false;
    if (!ctx?.attachmentId) return true;
    const allowed = [
      report.photoAttachmentId,
      report.secondment?.reportAttachmentId,
      ...(report.secondmentHistory ?? []).map((s) => s.reportAttachmentId),
    ]
      .filter(Boolean)
      .map(String);
    return allowed.includes(ctx.attachmentId);
  });
  // Sensitive employee files and documents: the employee themself, or a role with an explicit right to sensitive fields (review E2).
  registerSensitiveViewer('employee', async (req, ownerId) => {
    const e = await Employee.findById(ownerId).select('userId').lean();
    if (e?.userId && String(e.userId) === String(req.auth.user._id)) return true;
    const { fieldRestrictions } = await import('../../core/rbac/service');
    const { hidden } = await fieldRestrictions(req.auth.user.roles as RoleAssignment[], 'hr.employees');
    return !hidden.has('identity.number');
  });
  registerRecordAccess('hr_request', async (req, id) => {
    const eff = await permissionOn(req, 'hr.requests');
    if (!eff) return false;
    const filter = await visibilityFilter(req.auth.user, { resource: 'hr.requests', action: 'view', ...eff });
    return !!(await HrRequest.exists({ _id: id, deletedAt: null, ...filter }));
  });
  registerRecordAccess('profile_change', async (req, id) => {
    const eff = await permissionOn(req, 'hr.profile_changes');
    if (!eff) return false;
    const filter = eff.scope === 'own' ? { userId: req.auth.user._id } : {};
    return !!(await ProfileChangeRequest.exists({ _id: id, ...filter }));
  });
  for (const t of ['hr_request', 'profile_change']) registerSensitiveOwnerType(t);
  registerRecordAccess('employee_report', async (req, id) => {
    const eff = await permissionOn(req, 'hr.reports');
    if (!eff) return false;
    const filter = await reportsVisibility(req.auth.user, { resource: 'hr.reports', action: 'view', ...eff });
    return !!(await EmployeeReport.exists({ _id: id, deletedAt: null, ...filter }));
  });
  // Field-picker export of employee reports [EP §14.3, HR §4].
  registerExportResource({
    resource: 'employee_reports',
    labelAr: 'تقارير الموظفين',
    permissionResource: 'hr.reports',
    fields: [
      { key: 'number', labelAr: 'رقم التقرير' },
      { key: 'employeeName', labelAr: 'الموظف' },
      { key: 'type', labelAr: 'النوع' },
      { key: 'title', labelAr: 'العنوان' },
      { key: 'submittedAt', labelAr: 'التاريخ', kind: 'datetime' },
      { key: 'periodFrom', labelAr: 'من', kind: 'date' },
      { key: 'periodTo', labelAr: 'إلى', kind: 'date' },
      { key: 'state', labelAr: 'الحالة' },
      { key: 'notesCount', labelAr: 'عدد الملاحظات' },
    ],
    query: async ({ filters, authz, userId, limit }) => {
      const { User } = await import('../../core/auth/model');
      const user = await User.findById(userId);
      if (!user) return [];
      const f: Record<string, unknown> = { deletedAt: null, ...(await reportsVisibility(user, authz)) };
      if (typeof filters.type === 'string') f.type = filters.type;
      if (typeof filters.employeeId === 'string') f.employeeId = filters.employeeId;
      const rows = await EmployeeReport.find(f).sort({ submittedAt: -1 }).limit(limit).lean();
      const emps = await Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } })
        .select('fullNameAr')
        .lean();
      const names = new Map(emps.map((e) => [String(e._id), e.fullNameAr]));
      return rows.map((r) => ({
        ...r,
        employeeName: names.get(String(r.employeeId)) ?? '',
        notesCount: r.notes.length,
      })) as unknown as Record<string, unknown>[];
    },
  });

  // People picker (participants, assignees) over the employee file; secondments on the calendar [EP §13.7].
  registerPeopleSearch(async (q, limit) => {
    const filter: Record<string, unknown> = {
      deletedAt: null,
      userId: { $ne: null },
      status: { $nin: ['resigned', 'terminated'] },
    };
    if (q) filter.fullNameAr = arabicSearchRegex(q);
    const rows = await Employee.find(filter)
      .select('userId fullNameAr departmentId positionId')
      .sort({ fullNameAr: 1 })
      .limit(limit)
      .lean();
    return rows.map((r) => ({
      userId: String(r.userId),
      fullNameAr: r.fullNameAr,
      departmentId: String(r.departmentId),
      positionId: r.positionId ? String(r.positionId) : undefined,
    }));
  });
  registerCalendarSource('secondments', async (req, from, to) => {
    const e = await Employee.findOne({ userId: req.auth.user._id, deletedAt: null })
      .select('secondment secondmentHistory')
      .lean();
    if (!e) return [];
    const all = [...(e.secondmentHistory ?? []), ...(e.secondment?.destination ? [e.secondment] : [])];
    return all
      .filter((s) => s.startDate && s.endDate && s.startDate < to && s.endDate >= from)
      .map((s, i) => ({
        _id: `secondment:${e._id}:${i}`,
        title: `انتداب — ${s.destination}`,
        type: 'secondment',
        status: s.endDate! < new Date() ? 'done' : 'scheduled',
        startAt: s.startDate!,
        endAt: s.endDate!,
        allDay: true,
        readOnly: true as const,
        link: { type: 'employee', id: String(e._id) },
      }));
  });

  registerJob('hr.contracts.alerts', (now) => runContractAlerts(now));
  registerJob('hr.probation.alerts', (now) => runProbationAlerts(now));
  registerJob('hr.identity.alerts', (now) => runIdentityAlerts(now));
  registerJob('hr.accounts.deactivate', (now) => runAccountDeactivation(now), 'frequent');
  registerJob('hr.birthdays', (now) => runBirthdayGreetings(now));
  registerJob('hr.secondments.reminders', (now) => runSecondmentReportReminders(now));
  // H2 [HR §3.4 رابعاً, §3.5.1]: the computed day and the missed-punch reminders every 5 minutes; leave accrual daily.
  registerJob('hr.attendance.compute', (now) => runAttendanceCompute(now), 'frequent');
  registerJob('hr.leave.accrual', (now) => runLeaveAccrual(now));
  registerAttendanceExports();
  // H3a [HR §3.6–3.8]: payroll cut-off reminder, appraisal cycles and reminders, improvement-plan reviews and appeal windows, training reminders.
  registerJob('hr.payroll.cutoff', (now) => runPayrollCutoffReminder(now));
  registerJob('hr.appraisals', (now) => runAppraisalJobs(now));
  registerJob('hr.performance.followups', (now) => runPerformanceFollowUps(now));
  registerJob('hr.training.reminders', (now) => runTrainingReminders(now));
  registerPerformanceHandlers();
  registerH3aExports();
  registerTaskSourceResolver('training', async (idOrNumber) => {
    const t = await Training.findOne({ deletedAt: null, $or: [...(/^[0-9a-f]{24}$/i.test(idOrNumber) ? [{ _id: idOrNumber }] : []), { number: idOrNumber }] }).select('number title').lean();
    return t ? { id: String(t._id), label: `${t.number} ${t.title}` } : null;
  });
  registerTaskSourceResolver('improvement_plan', async (id) => {
    const p = /^[0-9a-f]{24}$/i.test(id) ? await ImprovementPlan.findById(id).select('to').lean() : null;
    return p ? { id: String(p._id), label: `خطة تحسين أداء حتى ${p.to}` } : null;
  });

  // Field-picker export [HR §4]; sensitive columns need field-level permission.
  registerExportResource({
    resource: 'employees',
    labelAr: 'الموظفون',
    permissionResource: 'hr.employees',
    fields: [
      { key: 'employeeNumber', labelAr: 'الرقم الوظيفي' },
      { key: 'fullNameAr', labelAr: 'الاسم' },
      { key: 'nationality', labelAr: 'الجنسية' },
      { key: 'gender', labelAr: 'الجنس' },
      { key: 'employmentType', labelAr: 'نوع الدوام' },
      { key: 'medicalInsurance', labelAr: 'وجود تأمين طبي', format: (v) => (v ? 'نعم' : 'لا') },
      { key: 'status', labelAr: 'حالة الموظف' },
      { key: 'hireDate', labelAr: 'تاريخ المباشرة', kind: 'date' },
      { key: 'gosiJoinDate', labelAr: 'تاريخ الانضمام للتأمينات الاجتماعية', kind: 'date' },
      { key: 'siteName', labelAr: 'موقع العمل' },
      { key: 'workEmail', labelAr: 'البريد الوظيفي' },
      { key: 'mobile', labelAr: 'الجوال' },
      { key: 'departmentName', labelAr: 'القسم' },
      { key: 'positionName', labelAr: 'المسمى الوظيفي' },
      { key: 'branchName', labelAr: 'الفرع' },
      { key: 'directManagerName', labelAr: 'المدير المباشر' },
      { key: 'contractType', labelAr: 'نوع العقد' },
      { key: 'contractEndDate', labelAr: 'نهاية العقد', kind: 'date' },
      { key: 'identityType', labelAr: 'نوع الهوية' },
      { key: 'identityExpiry', labelAr: 'انتهاء الهوية', kind: 'date' },
      { key: 'birthDate', labelAr: 'تاريخ الميلاد', sensitive: true, kind: 'date' },
      { key: 'identity.number', labelAr: 'رقم الهوية', sensitive: true },
      { key: 'religion', labelAr: 'الديانة', sensitive: true },
      {
        key: 'basicSalaryHalalas',
        labelAr: 'الراتب الأساسي (ر.س)',
        sensitive: true,
        kind: 'money',
        format: (v) => (typeof v === 'number' ? v / 100 : ''),
      },
    ],
    query: async ({ filters, authz, userId, limit }) => {
      const { User } = await import('../../core/auth/model');
      const user = await User.findById(userId);
      const scope = user ? await employeeScopeFilter(authz, user) : { _id: null };
      const f: Record<string, unknown> = { deletedAt: null, ...scope };
      if (typeof filters.departmentId === 'string') f.departmentId = filters.departmentId;
      if (typeof filters.status === 'string') f.status = filters.status;
      if (typeof filters.branchId === 'string') f.branchId = filters.branchId;
      if (typeof filters.nationality === 'string' && filters.nationality) f.nationality = filters.nationality;
      // «تحديد الموظفين المستهدفين» [HR §4 step 2]: an explicit list, intersected with the viewer's scope.
      const chosen = employeeIdsFilter(filters);
      if (chosen) f.$and = [...((f.$and as unknown[] | undefined) ?? []), chosen];
      const rows = await Employee.find(f).limit(limit).lean();
      const { Department, Position, Branch, Site } = await import('../../core/org/model');
      const { Contract } = await import('./model');
      const { decrypt } = await import('../../core/auth/crypto');
      const [depts, positions, branches, sites, managers, contracts] = await Promise.all([
        Department.find().select('nameAr').lean(),
        Position.find().select('titleAr').lean(),
        Branch.find().select('nameAr').lean(),
        Site.find().select('nameAr').lean(),
        Employee.find({ _id: { $in: rows.map((r) => r.directManagerId).filter(Boolean) } })
          .select('fullNameAr')
          .lean(),
        Contract.find({
          employeeId: { $in: rows.map((r) => r._id) },
          status: { $in: ['active', 'renewing'] },
        })
          .select('employeeId type endDate')
          .lean(),
      ]);
      const name = <T extends { _id: unknown }>(list: T[], pick: (x: T) => string) =>
        new Map(list.map((x) => [String(x._id), pick(x)]));
      const dn = name(depts, (x) => x.nameAr);
      const pn = name(positions, (x) => x.titleAr);
      const bn = name(branches, (x) => x.nameAr);
      const sn = name(sites, (x) => x.nameAr);
      const mn = name(managers, (x) => x.fullNameAr);
      const ct = new Map(contracts.map((c) => [String(c.employeeId), c]));
      return rows.map((r) => ({
        ...r,
        departmentName: dn.get(String(r.departmentId)) ?? '',
        positionName: r.positionId ? (pn.get(String(r.positionId)) ?? '') : '',
        branchName: r.branchId ? (bn.get(String(r.branchId)) ?? '') : '',
        siteName: r.siteId ? (sn.get(String(r.siteId)) ?? '') : '',
        directManagerName: r.directManagerId ? (mn.get(String(r.directManagerId)) ?? '') : '',
        contractType: ct.get(String(r._id))?.type ?? '',
        contractEndDate: ct.get(String(r._id))?.endDate ?? '',
        identityType: r.identity?.type ?? '',
        identityExpiry: r.identity?.expiryDate ?? '',
        'identity.number': r.identity?.numberEnc ? decrypt(r.identity.numberEnc) : '',
      })) as unknown as Record<string, unknown>[];
    },
  });

  // «استخراج تقارير بالوثائق التي قاربت على الانتهاء» [HR §3.9]: the same rows as the dashboard drill-down, as Excel.
  registerExportResource({
    resource: 'hr.documents_expiring',
    labelAr: 'الوثائق والعقود القريبة من الانتهاء',
    permissionResource: 'hr.employees',
    fields: [
      { key: 'kindAr', labelAr: 'النوع' },
      { key: 'titleAr', labelAr: 'الوثيقة' },
      { key: 'employeeNumber', labelAr: 'الرقم الوظيفي' },
      { key: 'fullNameAr', labelAr: 'الاسم' },
      { key: 'departmentName', labelAr: 'القسم' },
      { key: 'expiryDate', labelAr: 'تاريخ الانتهاء', kind: 'date' },
      { key: 'daysLeft', labelAr: 'الأيام المتبقية' },
    ],
    query: async ({ filters, authz, userId, limit }) => {
      const { User } = await import('../../core/auth/model');
      const user = await User.findById(userId);
      const scope: Record<string, unknown> = user ? await employeeScopeFilter(authz, user) : { _id: null };
      if (typeof filters.departmentId === 'string') scope.departmentId = filters.departmentId;
      if (typeof filters.branchId === 'string') scope.branchId = filters.branchId;
      const chosen = employeeIdsFilter(filters);
      if (chosen) scope.$and = [...((scope.$and as unknown[] | undefined) ?? []), chosen];
      const within = Math.min(Math.max(Number(filters.within ?? 90) || 90, 1), 365);
      const kinds =
        typeof filters.kind === 'string' && (EXPIRING_KINDS as string[]).includes(filters.kind)
          ? [filters.kind as ExpiringKind]
          : EXPIRING_KINDS;
      const { Department } = await import('../../core/org/model');
      const depts = await Department.find().select('nameAr').lean();
      const dn = new Map(depts.map((x) => [String(x._id), x.nameAr]));
      const rows = await expiringRows(kinds, within, scope);
      return rows.slice(0, limit).map((r) => ({
        ...r,
        kindAr: EXPIRING_KIND_AR[r.kind],
        departmentName: r.departmentId ? (dn.get(String(r.departmentId)) ?? '') : '',
      })) as unknown as Record<string, unknown>[];
    },
  });

  // «ويجب أن تشمل التقارير … والطلبات» [HR §4]: employee requests with their route, state and decision.
  registerExportResource({
    resource: 'hr.requests',
    labelAr: 'طلبات الموظفين',
    permissionResource: 'hr.requests',
    fields: [
      { key: 'number', labelAr: 'رقم الطلب' },
      { key: 'typeAr', labelAr: 'نوع الطلب' },
      { key: 'employeeNumber', labelAr: 'الرقم الوظيفي' },
      { key: 'employeeName', labelAr: 'اسم مقدم الطلب' },
      { key: 'departmentName', labelAr: 'القسم' },
      { key: 'createdAt', labelAr: 'تاريخ تقديم الطلب', kind: 'datetime' },
      { key: 'stateAr', labelAr: 'حالة الطلب' },
      { key: 'pendingWithAr', labelAr: 'المسؤول عن الموافقة' },
      { key: 'decisionOutcomeAr', labelAr: 'النتيجة' },
      { key: 'decisionAt', labelAr: 'تاريخ القرار', kind: 'datetime' },
      { key: 'decisionReason', labelAr: 'سبب القرار' },
      { key: 'closedAt', labelAr: 'تاريخ الإغلاق', kind: 'datetime' },
      { key: 'notes', labelAr: 'الملاحظات' },
    ],
    query: async ({ filters, authz, userId, limit }) => {
      const { User } = await import('../../core/auth/model');
      const user = await User.findById(userId);
      if (!user) return [];
      const f: Record<string, unknown> = { deletedAt: null, ...(await visibilityFilter(user, authz)) };
      if (typeof filters.type === 'string' && filters.type) f.type = filters.type;
      if (typeof filters.state === 'string' && filters.state) f.state = filters.state;
      if (typeof filters.departmentId === 'string' && filters.departmentId) f.departmentId = filters.departmentId;
      const { riyadhDayRange } = await import('../../core/dates/businessDays');
      const created = riyadhDayRange(
        typeof filters.from === 'string' ? filters.from : undefined,
        typeof filters.to === 'string' ? filters.to : undefined,
      );
      if (created) f.createdAt = created;
      const chosen = employeeIdsFilter(filters);
      if (chosen) f.employeeId = (chosen._id as { $in: string[] });
      const rows = await HrRequest.find(f).sort({ createdAt: -1 }).limit(limit).lean();
      const { Department } = await import('../../core/org/model');
      const [employees, depts] = await Promise.all([
        Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } })
          .select('fullNameAr employeeNumber')
          .lean(),
        Department.find().select('nameAr').lean(),
      ]);
      const en = new Map(employees.map((e) => [String(e._id), e]));
      const dn = new Map(depts.map((x) => [String(x._id), x.nameAr]));
      const { HR_REQUEST_TYPE_AR, HR_REQUEST_STATE_AR } = await import('@eayni/shared');
      const PENDING_AR: Record<string, string> = {
        manager: 'المدير المباشر',
        hr: 'الموارد البشرية',
        finance: 'المالية',
        requester: 'مقدم الطلب',
      };
      return rows.map((r) => ({
        number: r.number,
        typeAr: HR_REQUEST_TYPE_AR[r.type as keyof typeof HR_REQUEST_TYPE_AR] ?? r.type,
        employeeNumber: en.get(String(r.employeeId))?.employeeNumber ?? '',
        employeeName: en.get(String(r.employeeId))?.fullNameAr ?? '',
        departmentName: r.departmentId ? (dn.get(String(r.departmentId)) ?? '') : '',
        createdAt: r.createdAt,
        stateAr: HR_REQUEST_STATE_AR[r.state] ?? r.state,
        pendingWithAr: r.pendingWith ? (PENDING_AR[r.pendingWith] ?? r.pendingWith) : '',
        decisionOutcomeAr: r.decision?.outcome ? (HR_REQUEST_STATE_AR[r.decision.outcome] ?? r.decision.outcome) : '',
        decisionAt: r.decision?.at ?? '',
        decisionReason: r.decision?.reason ?? '',
        closedAt: r.closedAt ?? '',
        notes: r.notes ?? '',
      })) as unknown as Record<string, unknown>[];
    },
  });
}

/** `filters.employeeIds`: an array (or comma list) of employee ids chosen in the export builder [HR §4 step 2]. */
function employeeIdsFilter(filters: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = Array.isArray(filters.employeeIds)
    ? filters.employeeIds
    : typeof filters.employeeIds === 'string' && filters.employeeIds
      ? filters.employeeIds.split(',')
      : [];
  const ids = raw.map(String).filter((x) => /^[0-9a-f]{24}$/i.test(x));
  return ids.length ? { _id: { $in: ids } } : undefined;
}

/**
 * Grants the Finance roles need for the thin payroll stage [HR §3.6.7, FIN §5, §12] — merged into the core Finance role
 * definitions by the baseline, like the invoice register. Finance staff review and return; the manager approves and
 * either of them records the payment (never the one who approved — enforced in the service).
 */
export function HR_FINANCE_GRANTS(roleCode: string): RoleDefinition['grants'] {
  if (roleCode === 'finance_manager')
    return [
      { resource: 'finance.payroll', actions: ['view', 'approve', 'edit'], scope: 'all' },
      { resource: 'hr.payslips', actions: ['view'], scope: 'all' },
    ];
  if (roleCode === 'finance_staff')
    return [
      { resource: 'finance.payroll', actions: ['view', 'edit'], scope: 'all' },
      { resource: 'hr.payslips', actions: ['view'], scope: 'all' },
    ];
  return [];
}
