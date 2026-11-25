import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { get, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, PageHeader, QueryError, Spinner } from '@/shared/ui';
import { Kpi } from '../dashboards/_ui';

interface Dash {
  headcount: { total: number };
  expiring: { contracts: { d30: number }; identities: { d30: number }; documents: { d30: number } };
  requestsByState: { pending: number; needsCompletion: number };
  secondmentsWithoutReport: number;
  probationEnding30: number;
  attendance: { missingPunches: number; late: number; absent: number; onLeaveToday: number };
  performance: { appraisalsTotal: number; appraisalsDone: number; appraisalCompletionBp: number | null };
  recruitment?: { openRequisitions: number; awaitingApproval: number; applicantsInPipeline: number; offersPending: number; offersAccepted: number; govRegistrationMissing: number };
  offboarding?: { resignationsPending: number; awaitingReview: number; inProgress: number; settlementsDueSoon: number };
  saudization?: { ratePct: number | null; requiredRatePct: number | null; below: boolean };
  legalSettings?: { complete: boolean; missing: { key: string; labelAr: string }[] };
}

/**
 * «واجهة رئيسية لقسم الموارد البشرية» [HR §9.1]: the HR officer's work queues and alerts in one place, each card
 * opening the records behind it. Queues of later slices (attendance, payroll, performance, recruitment, end of
 * service) are added by H2–H3 and are not shown as zeros (DECISIONS §18 rule).
 */
export function HrHomePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const dash = useQuery({ queryKey: ['dashboard', 'hr', 'home'], queryFn: () => get<Dash>('/hr/dashboard/hr') });
  const queue = useQuery({
    queryKey: ['hr-requests', 'queue', 'count'],
    queryFn: () => get<Paged<unknown>>('/hr/requests?view=queue&limit=1'),
    enabled: can('hr.requests', 'approve'),
  });
  const payroll = useQuery({
    queryKey: ['payroll', 'hr', 'home'],
    queryFn: () => get<{ items: { state: string }[] }>('/hr/payroll?limit=12'),
    enabled: can('hr.payroll', 'view'),
  });
  const appraisalsQueue = useQuery({
    queryKey: ['perf', 'appraisals', 'queue'],
    queryFn: () => get<{ total: number }>('/hr/performance/appraisals?view=all&state=manager_submitted&limit=1'),
    enabled: can('hr.appraisals', 'approve'),
  });
  const changes = useQuery({
    queryKey: ['profile-changes', 'pending', 'count'],
    queryFn: () => get<Paged<unknown>>('/hr/profile-changes?state=pending&limit=1'),
    enabled: can('hr.profile_changes', 'view'),
  });
  if (dash.isError) return <QueryError error={dash.error} onRetry={() => dash.refetch()} />;
  if (!dash.data) return <Spinner />;
  const d = dash.data;
  const expiring30 = d.expiring.contracts.d30 + d.expiring.identities.d30 + d.expiring.documents.d30;
  return (
    <>
      <PageHeader title={t('hr.home.title')} subtitle={t('hr.home.hint')} />
      <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('hr.home.queues')}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {can('hr.requests', 'approve') && (
          <Kpi
            to="/hr/requests"
            label={t('hr.home.requestsQueue')}
            value={queue.data?.total ?? '…'}
            tone={queue.data?.total ? 'amber' : 'slate'}
          />
        )}
        <Kpi
          to="/hr/requests?view=all&state=needs_completion"
          label={t('dash.hr.reqNeedsCompletion')}
          value={d.requestsByState.needsCompletion}
          tone={d.requestsByState.needsCompletion ? 'amber' : 'slate'}
        />
        {can('hr.profile_changes', 'view') && (
          <Kpi
            to="/hr/profile-changes"
            label={t('hr.home.profileChanges')}
            value={changes.data?.total ?? '…'}
            tone={changes.data?.total ? 'amber' : 'slate'}
          />
        )}
        <Kpi
          to="/hr/secondments"
          label={t('hr.home.secondmentsNoReport')}
          value={d.secondmentsWithoutReport}
          tone={d.secondmentsWithoutReport ? 'red' : 'green'}
        />
        {can('hr.payroll', 'view') && payroll.data && (
          <Kpi
            to="/hr/payroll"
            label={t('hr.home.payrollOpen')}
            value={payroll.data.items.filter((r) => !['paid', 'closed', 'cancelled'].includes(r.state)).length}
            tone={payroll.data.items.some((r) => ['under_hr_review', 'returned', 'finance_returned'].includes(r.state)) ? 'amber' : 'slate'}
          />
        )}
        {can('hr.appraisals', 'approve') && (
          <Kpi to="/hr/performance" label={t('hr.home.appraisalsQueue')} value={appraisalsQueue.data?.total ?? '…'} tone={appraisalsQueue.data?.total ? 'amber' : 'slate'} />
        )}
        {can('hr.attendance', 'view') && (
          <Kpi
            to="/hr/attendance?exceptionsOnly=1"
            label={t('hr.home.attendanceExceptions')}
            value={d.attendance.late + d.attendance.absent + d.attendance.missingPunches}
            tone={d.attendance.late + d.attendance.absent + d.attendance.missingPunches ? 'amber' : 'green'}
            hint={t('hr.home.attendanceExceptionsHint')}
          />
        )}
      </div>
      <h2 className="mb-2 mt-4 text-sm font-semibold text-slate-700">{t('hr.home.alerts')}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          to="/hr/expiring?kind=contracts&within=30"
          label={t('hr.home.expiring30')}
          value={expiring30}
          tone={expiring30 ? 'amber' : 'green'}
        />
        <Kpi to="/hr/employees?probation=30" label={t('hr.home.probation')} value={d.probationEnding30} tone="blue" />
        <Kpi to="/hr/employees" label={t('dash.hr.headcount')} value={d.headcount.total} />
      </div>
      <h2 className="mb-2 mt-4 text-sm font-semibold text-slate-700">{t('hr.home.shortcuts')}</h2>
      <Card>
        <div className="flex flex-wrap gap-2 text-sm">
          {can('hr.employees', 'create') && (
            <Link to="/hr/employees?new=1" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              {t('hr.home.newEmployee')}
            </Link>
          )}
          <Link to="/hr/org-chart" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
            {t('hr.home.orgChart')}
          </Link>
          <Link to="/hr/employees" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
            {t('hr.home.employees')}
          </Link>
          <Link to="/hr/dashboard" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
            {t('hr.home.dashboard')}
          </Link>
          {can('hr.shifts', 'create') && (
            <Link to="/hr/shifts" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              {t('hr.home.shifts')}
            </Link>
          )}
          {can('hr.leave', 'create') && (
            <Link to="/hr/leave" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              {t('hr.home.leave')}
            </Link>
          )}
          {can('hr.payroll', 'view') && (
            <Link to="/hr/payroll" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              {t('nav.payroll')}
            </Link>
          )}
          {can('hr.appraisals', 'approve') && (
            <Link to="/hr/performance" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              {t('nav.performance')}
            </Link>
          )}
          {can('hr.training', 'edit') && (
            <Link to="/hr/training" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              {t('nav.training')}
            </Link>
          )}
          {can('hr.employees', 'export') && (
            <Link to="/hr/export" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              {t('hr.home.export')}
            </Link>
          )}
        </div>
      </Card>
      {/* H3b [HR §3.2, §3.10; DECISIONS §22 O2]: recruitment and end-of-service queues, the Saudization rate, the blank legal settings. */}
      {(d.recruitment || d.offboarding) && (
        <>
          <h2 className="mb-2 mt-6 text-sm font-semibold text-slate-700">{t('hr.home.recruitment')} · {t('hr.home.offboarding')}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {d.recruitment && can('hr.recruitment', 'view') && (
              <>
                <Kpi to="/hr/recruitment?state=submitted" label={t('hr.home.recruitmentQueue')} value={d.recruitment.awaitingApproval} tone={d.recruitment.awaitingApproval ? 'amber' : 'slate'} />
                <Kpi to="/hr/recruitment" label={t('hr.home.offersAccepted')} value={d.recruitment.offersAccepted} tone={d.recruitment.offersAccepted ? 'amber' : 'slate'} />
              </>
            )}
            {d.offboarding && can('hr.offboarding', 'view') && (
              <>
                <Kpi to="/hr/offboarding?state=resignation_submitted" label={t('hr.home.resignations')} value={d.offboarding.resignationsPending} tone={d.offboarding.resignationsPending ? 'amber' : 'slate'} />
                <Kpi to="/hr/offboarding?state=under_review" label={t('hr.home.offboardingReview')} value={d.offboarding.awaitingReview} tone={d.offboarding.awaitingReview ? 'amber' : 'slate'} />
                <Kpi to="/hr/offboarding?state=approved" label={t('hr.home.offboardingInProgress')} value={d.offboarding.inProgress} tone="blue" />
                <Kpi to="/hr/offboarding?state=approved" label={t('hr.home.settlementsDue')} value={d.offboarding.settlementsDueSoon} tone={d.offboarding.settlementsDueSoon ? 'red' : 'slate'} />
              </>
            )}
            {d.saudization && <Kpi to="/hr/recruitment" label={t('hr.home.saudization')} value={d.saudization.ratePct === null ? '—' : `${d.saudization.ratePct}%`} tone={d.saudization.below ? 'red' : 'green'} />}
            {d.legalSettings && !d.legalSettings.complete && <Kpi to="/admin/settings" label={t('hr.home.legalSettings')} value={d.legalSettings.missing.length} tone="amber" />}
          </div>
          {d.legalSettings && !d.legalSettings.complete && (
            <p className="mt-2 text-xs text-slate-500">
              {t('hr.home.legalSettingsHint')}: {d.legalSettings.missing.map((m) => m.labelAr).join(' · ')}
            </p>
          )}
        </>
      )}
    </>
  );
}
