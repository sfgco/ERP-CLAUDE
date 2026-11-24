import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { get } from '@/lib/api';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { Card, PageHeader, QueryError, Spinner } from '@/shared/ui';
import { useHrLookups } from '../hr/_data';
import { Bars, Kpi } from './_ui';

interface Count {
  key: string;
  count: number;
  departmentId?: string;
}
interface Buckets {
  d30: number;
  d60: number;
  d90: number;
}
interface Data {
  headcount: {
    total: number;
    byDepartment: Count[];
    byBranch: Count[];
    byNationality: Count[];
    byContractType: Count[];
    byEmploymentType: Count[];
    byStatus: Count[];
  };
  expiring: { contracts: Buckets; identities: Buckets; documents: Buckets; needsUpdate: number };
  requestsByState: {
    period: { from: string; to: string };
    new: number;
    pending: number;
    approved: number;
    rejected: number;
    needsCompletion: number;
  };
  requests: {
    open: number;
    byType: Count[];
    byPendingWith: Count[];
    byAge: { d0_2: number; d3_7: number; d8plus: number };
  };
  attendance: { period: { from: string; to: string }; absent: number; late: number; missingPunches: number; workedMinutes: number; overtimeApprovedMinutes: number; onLeaveToday: number };
  secondmentsWithoutReport: number;
  probationEnding30: number;
  recentChanges: { _id: string; employeeId: string; type: string; at: string; effectiveDate?: string }[];
}

/** HR dashboard [HR §5]: only cards whose data exists in phase 1; attendance, appraisals and training come with their modules. */
export function HrDashboardPage() {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const lk = useHrLookups();
  const [period, setPeriod] = useState<'thisMonth' | 'lastMonth' | 'last90'>('thisMonth');
  const range = periodRange(period);
  const q = useQuery({
    queryKey: ['dashboard', 'hr', range.from, range.to],
    queryFn: () => get<Data>(`/hr/dashboard/hr?from=${range.from}&to=${range.to}`),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const d = q.data;
  const b = (x: Buckets) => `${x.d30} / ${x.d60} / ${x.d90}`;
  return (
    <>
      <PageHeader title={t('dash.hr.title')} subtitle={t('dash.hr.hint')} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi to="/hr/employees" label={t('dash.hr.headcount')} value={d.headcount.total} />
        <Kpi
          to="/hr/requests"
          label={t('dash.hr.openRequests')}
          value={d.requests.open}
          tone={d.requests.open ? 'amber' : 'slate'}
          hint={`${t('dash.hr.age8')}: ${d.requests.byAge.d8plus}`}
        />
        <Kpi
          to="/hr/secondments"
          label={t('dash.hr.secondmentsNoReport')}
          value={d.secondmentsWithoutReport}
          tone={d.secondmentsWithoutReport ? 'red' : 'green'}
        />
        <Kpi
          to="/hr/employees?probation=30"
          label={t('dash.hr.probation30')}
          value={d.probationEnding30}
          tone="blue"
        />
        <Kpi
          to="/hr/expiring?kind=contracts&within=90"
          label={t('dash.hr.contractsExpiring')}
          value={b(d.expiring.contracts)}
          hint={t('dash.hr.bucketsHint')}
          tone="amber"
        />
        <Kpi
          to="/hr/expiring?kind=identities&within=90"
          label={t('dash.hr.identitiesExpiring')}
          value={b(d.expiring.identities)}
          hint={t('dash.hr.bucketsHint')}
          tone="amber"
        />
        <Kpi
          to="/hr/expiring?kind=documents&within=90"
          label={t('dash.hr.documentsExpiring')}
          value={b(d.expiring.documents)}
          hint={t('dash.hr.bucketsHint')}
          tone="amber"
        />
        <Kpi
          to="/hr/expiring?kind=documents&within=30"
          label={t('dash.hr.needsUpdate')}
          value={d.expiring.needsUpdate}
          hint={t('dash.hr.needsUpdateHint')}
          tone={d.expiring.needsUpdate ? 'red' : 'green'}
        />
        <Kpi to="/hr/export" label={t('dash.hr.export')} value="↧" hint={t('dash.hr.exportHint')} />
      </div>
      {/* Request cards: new / pending / approved / rejected / needs completion [HR §5 fourth group] */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{t('dash.hr.requestsByState')}</h2>
        <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs" role="group" aria-label={t('dash.hr.period')}>
          {(['thisMonth', 'lastMonth', 'last90'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setPeriod(k)}
              className={`rounded-md px-2.5 py-1.5 ${period === k ? 'bg-brand-700 text-white' : 'text-slate-600'}`}
            >
              {t(k === 'thisMonth' ? 'dash.hr.periodThisMonth' : k === 'lastMonth' ? 'dash.hr.periodLastMonth' : 'dash.hr.period90')}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          to={`/hr/requests?view=all&from=${range.from}&to=${range.to}`}
          label={t('dash.hr.reqNew')}
          value={d.requestsByState.new}
          tone="blue"
        />
        <Kpi
          to="/hr/requests?view=all&pending=1"
          label={t('dash.hr.reqPending')}
          value={d.requestsByState.pending}
          tone={d.requestsByState.pending ? 'amber' : 'slate'}
          hint={t('dash.hr.reqPendingHint')}
        />
        <Kpi
          to={`/hr/requests?view=all&outcome=approved&from=${range.from}&to=${range.to}`}
          label={t('dash.hr.reqApproved')}
          value={d.requestsByState.approved}
          tone="green"
        />
        <Kpi
          to={`/hr/requests?view=all&outcome=rejected&from=${range.from}&to=${range.to}`}
          label={t('dash.hr.reqRejected')}
          value={d.requestsByState.rejected}
          tone={d.requestsByState.rejected ? 'red' : 'slate'}
        />
        <Kpi
          to="/hr/requests?view=all&state=needs_completion"
          label={t('dash.hr.reqNeedsCompletion')}
          value={d.requestsByState.needsCompletion}
          tone={d.requestsByState.needsCompletion ? 'amber' : 'slate'}
          hint={t('dash.hr.reqNeedsHint')}
        />
      </div>
      {/* Attendance cards [HR §5 second group]: absences, lateness, worked hours, missing punches, on leave today */}
      <h2 className="mt-4 text-sm font-semibold text-slate-700">{t('dash.hr.attendance')}</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi to={`/hr/attendance?from=${range.from}&to=${range.to}&status=absent`} label={t('dash.hr.attAbsent')} value={d.attendance.absent} tone={d.attendance.absent ? 'red' : 'slate'} />
        <Kpi to={`/hr/attendance?from=${range.from}&to=${range.to}&status=late`} label={t('dash.hr.attLate')} value={d.attendance.late} tone={d.attendance.late ? 'amber' : 'slate'} />
        <Kpi to={`/hr/attendance?from=${range.from}&to=${range.to}`} label={t('dash.hr.attHours')} value={Math.round(d.attendance.workedMinutes / 60)} hint={`${t('attendance.overtimeApproved')}: ${Math.round(d.attendance.overtimeApprovedMinutes / 60)}`} />
        <Kpi to={`/hr/attendance?from=${range.from}&to=${range.to}&exceptionsOnly=1`} label={t('dash.hr.attMissing')} value={d.attendance.missingPunches} tone={d.attendance.missingPunches ? 'amber' : 'slate'} />
        <Kpi to="/hr/employees?status=on_leave" label={t('dash.hr.attOnLeave')} value={d.attendance.onLeaveToday} tone="blue" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={t('dash.hr.byDepartment')}>
          <Bars
            items={d.headcount.byDepartment}
            linkFor={(k) => {
              const id = d.headcount.byDepartment.find((x) => x.key === k.key)?.departmentId;
              return id ? `/hr/employees?departmentId=${id}` : undefined;
            }}
          />
        </Card>
        <Card title={t('dash.hr.byBranch')}>
          <Bars
            items={d.headcount.byBranch}
            linkFor={(k) => {
              const id = lk.branches.find((b) => b.nameAr === k.key)?._id;
              return id ? `/hr/employees?branchId=${id}` : undefined;
            }}
          />
        </Card>
        <Card title={t('dash.hr.byNationality')}>
          <Bars
            items={d.headcount.byNationality.map((x) => ({
              ...x,
              to: `/hr/employees?nationality=${encodeURIComponent(x.key)}`,
            }))}
          />
        </Card>
        <Card title={t('dash.hr.byEmploymentType')}>
          <Bars
            items={d.headcount.byEmploymentType.map((x) => ({
              key: t(`hr.employmentTypes.${x.key}`, x.key),
              count: x.count,
              to: `/hr/employees?employmentType=${x.key}`,
            }))}
          />
        </Card>
        <Card title={t('dash.hr.byContractType')}>
          <Bars
            items={d.headcount.byContractType.map((x) => ({
              ...x,
              key: t(`hr.contractTypes.${x.key}`, x.key),
            }))}
          />
        </Card>
        <Card title={t('dash.hr.byStatus')}>
          <Bars
            items={d.headcount.byStatus.map((x) => ({
              key: t(`hr.status.${x.key}`, x.key),
              count: x.count,
              to: `/hr/employees?status=${x.key}`,
            }))}
          />
        </Card>
        <Card title={t('dash.hr.requestsByType')}>
          <Bars
            items={d.requests.byType.map((x) => ({
              key: t(`requests.types.${x.key}`, x.key),
              count: x.count,
              to: `/hr/requests?type=${x.key}`,
            }))}
          />
          <div className="mt-3 text-xs text-slate-500">
            {t('dash.hr.pendingWith')}:{' '}
            {d.requests.byPendingWith
              .map((x) => `${t(`requests.pendingWith.${x.key}`, x.key)} ${x.count}`)
              .join(' · ') || '—'}
            <br />
            {t('dash.hr.age')}: 0–2: {d.requests.byAge.d0_2} · 3–7: {d.requests.byAge.d3_7} · 8+:{' '}
            {d.requests.byAge.d8plus}
          </div>
        </Card>
        <Card title={t('dash.hr.recentChanges')}>
          {d.recentChanges.length ? (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.recentChanges.map((c) => (
                <li key={c._id} className="flex items-center justify-between py-1.5">
                  <Link to={`/hr/employees/${c.employeeId}`} className="text-brand-800 hover:underline">
                    {lk.employeeName(c.employeeId) || t(`hr.events.${c.type}`, c.type)}
                  </Link>
                  <span className="text-xs text-slate-500">
                    {t(`hr.events.${c.type}`, c.type)} · {formatDate(c.effectiveDate ?? c.at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">{t('common.empty')}</p>
          )}
        </Card>
      </div>
    </>
  );
}

/** Riyadh-day window for the request cards: this month, last month, or the last 90 days. */
function periodRange(kind: 'thisMonth' | 'lastMonth' | 'last90'): { from: string; to: string } {
  const today = riyadhToday();
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (kind === 'thisMonth') return { from: `${y}-${pad(m)}-01`, to: today };
  if (kind === 'lastMonth') {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(last)}` };
  }
  return { from: riyadhToday(new Date(Date.now() - 90 * 86_400_000)), to: today };
}
