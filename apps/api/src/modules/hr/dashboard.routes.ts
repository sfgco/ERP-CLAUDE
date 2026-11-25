import { Router } from 'express';
import type { RoleAssignment } from '@eayni/shared';
import { OPEN_TASK_STATUSES } from '@eayni/shared';
import { asyncHandler } from '../../core/http/async';
import { riyadhDate, riyadhDayRange, startOfRiyadhWeek } from '../../core/dates/businessDays';
import type { AuthedRequest } from '../../core/http/context';
import { badRequest, forbidden } from '../../core/http/errors';
import { requireAuth } from '../../core/auth/middleware';
import { authorize } from '../../core/rbac/authorize';
import { effectivePermission } from '../../core/rbac/service';
import { Task } from '../../core/tasks/model';
import { CalendarEvent } from '../../core/calendar/model';
import { DocumentRecord } from '../../core/documents/model';
import { Department, Branch } from '../../core/org/model';
import { Ticket } from '../tickets/model';
import { teamTicketsFilter } from '../tickets/service';
import { Contract, Employee, EmployeeEvent } from './model';
import { HrRequest } from './requests.model';
import { PENDING_STATES } from './requests.routes';
import { EXPIRING_KINDS, expiringRows, type ExpiringKind } from './expiring';
import { EmployeeReport } from './reports.model';
import { AttendanceDay } from './attendance.model';
import { Appraisal, AppraisalCycle, Goal } from './performance.model';
import { Training } from './training.model';
import { Applicant, JobRequisition, Offer } from './recruitment.model';
import { Offboarding } from './offboarding.model';
import { legalSettingsStatus } from './offboarding.service';
import { saudizationStatus } from './recruitment.service';
import { dayTime, summarizeDays } from './attendance.service';

export const dashboardRouter = Router();
const DAY = 86_400_000;

/**
 * Direct-manager dashboard [EP §16]: my team (direct reports, plus the department for a department manager),
 * their tasks by status and overdue, requests waiting on me, reports awaiting review, team meetings this week.
 */
dashboardRouter.get(
  '/manager',
  requireAuth(),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = req.auth.user;
    const me = await Employee.findOne({ userId: user._id, deletedAt: null }).select('_id').lean();
    const eff = await effectivePermission(
      user.roles as RoleAssignment[],
      user.departmentId ? String(user.departmentId) : undefined,
      'hr.employees',
      'view',
      String(user._id),
    );
    const or: Record<string, unknown>[] = [];
    if (me) or.push({ directManagerId: me._id });
    if (eff?.scope === 'department' && eff.departmentIds.length)
      or.push({ departmentId: { $in: eff.departmentIds } });
    if (!or.length) throw forbidden('هذه اللوحة للمديرين المباشرين ومديري الأقسام');
    const team = await Employee.find({ $or: or, deletedAt: null, _id: { $ne: me?._id } })
      .select('status userId secondment')
      .lean();
    if (!team.length && eff?.scope !== 'department')
      throw forbidden('هذه اللوحة للمديرين المباشرين ومديري الأقسام');
    const userIds = team.map((t) => t.userId).filter(Boolean);
    const now = new Date();
    const weekStart = startOfRiyadhWeek(now); // review G11: shared Riyadh helper
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY);
    const [tasks, requestsPending, reportsPending, meetings, tickets] = await Promise.all([
      Task.find({ assigneeId: { $in: userIds }, deletedAt: null })
        .select('status dueAt')
        .lean(),
      HrRequest.countDocuments({ directManagerUserId: user._id, state: 'awaiting_manager', deletedAt: null }),
      EmployeeReport.countDocuments({ userId: { $in: userIds }, state: 'submitted', deletedAt: null }),
      CalendarEvent.countDocuments({
        deletedAt: null,
        status: { $in: ['scheduled', 'rescheduled'] },
        startAt: { $gte: weekStart, $lt: weekEnd },
        $or: [{ ownerId: user._id }, { participantIds: { $in: [user._id, ...userIds] } }],
      }),
      Ticket.countDocuments(await teamTicketsFilter(String(user._id), true)), // same filter as tickets?view=team (follow-up 5)
    ]);
    const byStatus: Record<string, number> = {};
    let overdue = 0;
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      if ((OPEN_TASK_STATUSES as readonly string[]).includes(t.status) && t.dueAt && t.dueAt < now) overdue++;
    }
    res.json({
      team: {
        total: team.length,
        active: team.filter((t) => t.status === 'active' || t.status === 'field_work').length,
        onLeave: team.filter((t) => t.status === 'on_leave').length,
        seconded: team.filter((t) => t.status === 'seconded').length,
        other: team.filter((t) => !['active', 'field_work', 'on_leave', 'seconded'].includes(t.status))
          .length,
      },
      tasks: {
        byStatus,
        overdue,
        open: tasks.filter((t) => (OPEN_TASK_STATUSES as readonly string[]).includes(t.status)).length,
      },
      tickets: { open: tickets },
      requestsPending,
      reportsPending,
      meetingsThisWeek: meetings,
    });
  }),
);

/**
 * HR dashboard [HR §5]: headcount by department / branch / nationality / contract type, expiring documents and
 * contracts (30 / 60 / 90 days), request queues by type and age, secondments without report, probation ending,
 * recent transfers and promotions. Cards for modules not built yet are absent, not zero.
 */
dashboardRouter.get(
  '/hr',
  requireAuth(),
  authorize('hr.employees', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.authz!.scope !== 'all') throw forbidden('لوحة الموارد البشرية لمن يرى كل الموظفين');
    const now = new Date();
    const d = (days: number) => new Date(now.getTime() + days * DAY);
    // Period of the request cards [HR §5 رابعاً]: Riyadh days, default the current month.
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    const today = riyadhDate(now);
    const period = {
      from: typeof req.query.from === 'string' && dayRe.test(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`,
      to: typeof req.query.to === 'string' && dayRe.test(req.query.to) ? req.query.to : today,
    };
    const createdIn = riyadhDayRange(period.from, period.to)!;
    const employees = await Employee.find({ deletedAt: null, status: { $nin: ['resigned', 'terminated'] } })
      .select('departmentId branchId nationality employmentType status secondment identity.expiryDate')
      .lean();
    const [depts, branches, contracts, documents, requests, probation, events, created, decided, pending, needsCompletion] = await Promise.all([
      Department.find().select('nameAr').lean(),
      Branch.find().select('nameAr').lean(),
      Contract.find({ status: { $in: ['active', 'renewing'] } })
        .select('employeeId type endDate probationEndDate')
        .lean(),
      DocumentRecord.find({ deletedAt: null, ownerType: 'employee', expiryDate: { $ne: null, $lte: d(90) } })
        .select('expiryDate ownerId type version')
        .sort({ version: -1 })
        .lean()
        // Latest version per owner + type only (review G5).
        .then((rows) =>
          rows.filter(
            (r, i, arr) => arr.findIndex((x) => x.ownerId === r.ownerId && x.type === r.type) === i,
          ),
        ),
      HrRequest.find({ deletedAt: null, closedAt: null })
        .select('type state pendingWith createdAt stateEnteredAt')
        .lean(),
      Contract.countDocuments({
        status: { $in: ['active', 'renewing'] },
        probationEndDate: { $gte: now, $lte: d(30) },
      }),
      EmployeeEvent.find({ type: { $in: ['transfer', 'promotion'] }, at: { $gte: d(-30) } })
        .sort({ at: -1 })
        .limit(20)
        .lean(),
      HrRequest.countDocuments({ deletedAt: null, createdAt: createdIn }),
      HrRequest.find({ deletedAt: null, 'decision.at': createdIn }).select('decision.outcome').lean(),
      HrRequest.countDocuments({ deletedAt: null, closedAt: null, state: { $in: PENDING_STATES } }),
      HrRequest.countDocuments({ deletedAt: null, state: 'needs_completion' }),
    ]);
    const count = <T>(items: T[], key: (x: T) => string | undefined) => {
      const m = new Map<string, number>();
      for (const i of items) {
        const k = key(i) ?? '—';
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
    };
    const deptName = new Map(depts.map((x) => [String(x._id), x.nameAr]));
    const branchName = new Map(branches.map((x) => [String(x._id), x.nameAr]));
    const buckets = (dates: (Date | null | undefined)[]) => ({
      d30: dates.filter((x) => x && x <= d(30)).length,
      d60: dates.filter((x) => x && x > d(30) && x <= d(60)).length,
      d90: dates.filter((x) => x && x > d(60) && x <= d(90)).length,
    });
    const ageDays = (r: { createdAt?: Date }) =>
      Math.floor((now.getTime() - new Date(r.createdAt ?? now).getTime()) / DAY);
    const employeeIds = new Set(employees.map((e) => String(e._id)));
    const liveContracts = contracts.filter((c) => employeeIds.has(String(c.employeeId)));
    // «الحضور والانصراف» [HR §5 ثانياً] over the same period, from the computed days; «في إجازة» = approved leave today.
    const [dayRows, onLeaveToday] = await Promise.all([
      AttendanceDay.find({ day: { $gte: period.from, $lte: period.to }, employeeId: { $in: [...employeeIds] } })
        .select('status scheduled workedMinutes lateMinutes overtimeMinutes overtimeApprovedMinutes earlyLeaveMinutes final')
        .lean(),
      HrRequest.countDocuments({
        deletedAt: null,
        type: 'leave',
        employeeId: { $in: [...employeeIds] },
        $or: [{ state: 'approved' }, { state: 'closed', 'decision.outcome': 'approved' }],
        'details.startDate': { $lte: dayTime(today, '23:59') },
        'details.endDate': { $gte: new Date(dayTime(today, '00:00').getTime() - DAY) },
      }),
    ]);
    const att = summarizeDays(dayRows as never);
    // «مؤشرات الأداء» [HR §5 خامساً]: appraisal completion of the open cycles, employees with goals, trainings done in the period.
    const openCycles = await AppraisalCycle.find({ state: 'open' }).select('_id').lean();
    const [apprTotal, apprDone, withGoals, trainingsDone] = await Promise.all([
      Appraisal.countDocuments({ cycleId: { $in: openCycles.map((c) => c._id) }, state: { $ne: 'cancelled' } }),
      Appraisal.countDocuments({ cycleId: { $in: openCycles.map((c) => c._id) }, state: { $in: ['approved', 'acknowledged'] } }),
      Goal.distinct('employeeId', { deletedAt: null, state: { $in: ['active', 'achieved'] }, employeeId: { $in: [...employeeIds] } }).then((x) => x.length),
      Training.countDocuments({ deletedAt: null, state: 'completed', endAt: createdIn }),
    ]);
    res.json({
      performance: {
        appraisalCompletionBp: apprTotal ? Math.round((apprDone / apprTotal) * 10_000) : null,
        appraisalsTotal: apprTotal,
        appraisalsDone: apprDone,
        employeesWithGoals: withGoals,
        trainingsCompleted: trainingsDone,
        promotions: events.filter((e) => e.type === 'promotion').length,
      },
      attendance: {
        period,
        absent: att.absentDays,
        late: att.lateDays,
        missingPunches: att.missingPunchDays,
        workedMinutes: att.workedMinutes,
        overtimeApprovedMinutes: att.overtimeApprovedMinutes,
        onLeaveToday,
      },
      headcount: {
        total: employees.length,
        byDepartment: count(employees, (e) => deptName.get(String(e.departmentId))).map((x) => ({
          ...x,
          departmentId: depts.find((dd) => dd.nameAr === x.key)?._id,
        })),
        byBranch: count(employees, (e) => (e.branchId ? branchName.get(String(e.branchId)) : undefined)),
        byNationality: count(employees, (e) => e.nationality),
        byContractType: count(liveContracts, (c) => c.type),
        // «توزيع الموظفين حسب الجنسية ونوع التوظيف» [HR §5 أولاً]
        byEmploymentType: count(employees, (e) => e.employmentType),
        byStatus: count(employees, (e) => e.status),
      },
      expiring: {
        contracts: buckets(liveContracts.map((c) => c.endDate)),
        identities: buckets(employees.map((e) => e.identity?.expiryDate)),
        documents: buckets(documents.map((x) => x.expiryDate)),
        // «المستندات التي تحتاج إلى تحديث» [HR §5 ثالثاً]: already past their expiry (documents and identities).
        needsUpdate:
          documents.filter((x) => x.expiryDate && x.expiryDate < now).length +
          employees.filter((e) => e.identity?.expiryDate && e.identity.expiryDate < now).length,
      },
      // «الطلبات الجديدة، المعلقة، المعتمدة، المرفوضة، التي تحتاج إلى استكمال» [HR §5 رابعاً]: new / approved / rejected
      // are counted in the period, pending and needs-completion are the live backlog whatever the submission date.
      requestsByState: {
        period,
        new: created,
        pending,
        approved: decided.filter((r) => r.decision?.outcome === 'approved').length,
        rejected: decided.filter((r) => r.decision?.outcome === 'rejected').length,
        needsCompletion,
      },
      requests: {
        open: requests.length,
        byType: count(requests, (r) => r.type),
        byPendingWith: count(requests, (r) => r.pendingWith ?? undefined),
        byAge: {
          d0_2: requests.filter((r) => ageDays(r) <= 2).length,
          d3_7: requests.filter((r) => ageDays(r) > 2 && ageDays(r) <= 7).length,
          d8plus: requests.filter((r) => ageDays(r) > 7).length,
        },
      },
      secondmentsWithoutReport: employees.filter((e) => e.secondment?.destination && !e.secondment.reportedAt)
        .length,
      probationEnding30: probation,
      // H3b [HR §5 «التوظيف», «إنهاء الخدمة»; DECISIONS §22 O2]: queues, the Saudization rate and the blank legal settings.
      recruitment: {
        openRequisitions: await JobRequisition.countDocuments({ deletedAt: null, state: { $in: ['submitted', 'approved', 'posted'] } }),
        awaitingApproval: await JobRequisition.countDocuments({ deletedAt: null, state: 'submitted' }),
        applicantsInPipeline: await Applicant.countDocuments({ deletedAt: null, stage: { $in: ['new', 'screened', 'shortlisted', 'interviewing', 'offered'] } }),
        offersPending: await Offer.countDocuments({ deletedAt: null, state: 'pending_approval' }),
        offersAccepted: await Offer.countDocuments({ deletedAt: null, state: 'accepted' }),
        govRegistrationMissing: await Offer.countDocuments({ deletedAt: null, state: { $in: ['contracted', 'onboarded'] }, $or: [{ 'govRegistration.qiwaRef': null }, { 'govRegistration.gosiRef': null }] }),
      },
      offboarding: {
        resignationsPending: await Offboarding.countDocuments({ deletedAt: null, state: { $in: ['resignation_submitted', 'resignation_postponed'] } }),
        awaitingReview: await Offboarding.countDocuments({ deletedAt: null, state: 'under_review' }),
        inProgress: await Offboarding.countDocuments({ deletedAt: null, state: 'approved' }),
        settlementsDueSoon: await Offboarding.countDocuments({ deletedAt: null, state: 'approved', 'settlement.state': { $ne: 'paid' }, 'settlement.dueAt': { $lte: d(3) } }),
      },
      saudization: await saudizationStatus().then((s) => ({ ratePct: s.ratePct, requiredRatePct: s.setting.requiredRatePct, below: s.below })),
      legalSettings: await legalSettingsStatus(),
      recentChanges: events.map((e) => ({
        _id: e._id,
        employeeId: e.employeeId,
        type: e.type,
        at: e.at,
        effectiveDate: e.effectiveDate,
      })),
    });
  }),
);

/** Drill-down behind the HR expiry cards (go-live review H5): the records expiring within N days, by kind. */
dashboardRouter.get(
  '/expiring',
  requireAuth(),
  authorize('hr.employees', 'view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.authz!.scope !== 'all') throw forbidden('لوحة الموارد البشرية لمن يرى كل الموظفين');
    const kind = String(req.query.kind ?? 'contracts') as ExpiringKind;
    if (!EXPIRING_KINDS.includes(kind)) throw badRequest('نوع غير معروف');
    const within = Math.min(Math.max(Number(req.query.within ?? 90) || 90, 1), 365);
    const rows = await expiringRows([kind], within, {});
    res.json({ kind, within, items: rows, total: rows.length });
  }),
);
