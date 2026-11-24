import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { get, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Card, PageHeader, QueryError, Spinner } from '@/shared/ui';
import { Kpi } from '../dashboards/_ui';

interface Dash {
  headcount: { total: number };
  expiring: { contracts: { d30: number }; identities: { d30: number }; documents: { d30: number } };
  requestsByState: { pending: number; needsCompletion: number };
  secondmentsWithoutReport: number;
  probationEnding30: number;
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
          {can('hr.employees', 'export') && (
            <Link to="/hr/export" className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              {t('hr.home.export')}
            </Link>
          )}
        </div>
      </Card>
      <Alert kind="info">{t('hr.home.comingSoon')}</Alert>
    </>
  );
}
