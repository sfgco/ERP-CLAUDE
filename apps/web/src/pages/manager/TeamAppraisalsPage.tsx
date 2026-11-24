import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get } from '@/lib/api';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, EmptyState, PageHeader, QueryError, Spinner, Table, Td } from '@/shared/ui';
import { appraisalTone, goalTone, pct, type AppraisalRow, type GoalRow } from '../hr/_h3a';
import { GoalDialog } from '../hr/GoalDialog';
import { useTeam } from '../tasks/_data';

/** «تقييم فريقي» [HR §3.7]: the direct manager's appraisals to score and submit, and the team's goals. */
export function TeamAppraisalsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate } = usePrefs();
  const team = useTeam();
  const q = useQuery({ queryKey: ['perf', 'appraisals', 'team'], queryFn: () => get<{ items: AppraisalRow[] }>('/hr/performance/appraisals?view=team&limit=200') });
  const goals = useQuery({ queryKey: ['perf', 'goals', 'team'], queryFn: () => get<{ items: GoalRow[] }>('/hr/performance/goals') });
  const [goalDialog, setGoalDialog] = useState(false);
  const open = q.data?.items.filter((a) => ['open', 'returned'].includes(a.state)) ?? [];
  return (
    <>
      <PageHeader title={t('performance.teamTitle')} subtitle={t('performance.teamHint')} actions={can('hr.goals', 'create') && <Button onClick={() => setGoalDialog(true)}>{t('performance.newGoal')}</Button>} />
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card title={t('performance.tabs.appraisals')}>
          {q.isError ? (
            <QueryError error={q.error} onRetry={() => q.refetch()} />
          ) : q.isLoading ? (
            <Spinner />
          ) : !q.data?.items.length ? (
            <EmptyState title={t('performance.noTeamAppraisals')} />
          ) : (
            <>
              {open.length > 0 && <p className="mb-2 text-xs text-amber-700">{t('performance.pendingYours', { n: open.length })}</p>}
              <Table head={[t('hr.employee'), t('performance.cycle'), t('common.status'), t('performance.score'), t('performance.dueAt'), '']}>
                {q.data.items.map((a) => (
                  <tr key={a._id}>
                    <Td className="font-medium">{a.employee?.fullNameAr ?? '—'}</Td>
                    <Td className="text-xs">{a.cycleName}</Td>
                    <Td>
                      <Badge tone={appraisalTone[a.state]}>{t(`performance.states.${a.state}`)}</Badge>
                    </Td>
                    <Td className="tabular">{pct(a.overallScoreBp)}</Td>
                    <Td className="tabular text-xs">{a.dueAt ? formatDate(a.dueAt) : '—'}</Td>
                    <Td>
                      <Link to={`/hr/performance/appraisals/${a._id}`} className="text-xs text-brand-700 hover:underline">
                        {['open', 'returned'].includes(a.state) ? t('performance.scoreNow') : t('performance.view')}
                      </Link>
                    </Td>
                  </tr>
                ))}
              </Table>
            </>
          )}
        </Card>
        <Card title={t('performance.tabs.goals')}>
          {goals.isLoading ? (
            <Spinner />
          ) : !goals.data?.items.length ? (
            <EmptyState title={t('performance.noGoals')} hint={t('performance.noGoalsHint')} />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {goals.data.items.map((g) => (
                <li key={g._id} className="flex items-center justify-between gap-2 py-2">
                  <div>
                    <div className="font-medium">{g.title}</div>
                    <div className="text-xs text-slate-500">
                      {g.employee?.fullNameAr} {g.kpiNameAr ? `· ${g.kpiNameAr}` : ''} · {pct(g.weightBp)}
                    </div>
                  </div>
                  <div className="text-end">
                    <div className="tabular font-semibold">{g.percent}%</div>
                    <Badge tone={goalTone[g.state]}>{t(`performance.goalStates.${g.state}`)}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <GoalDialog open={goalDialog} onClose={() => setGoalDialog(false)} employees={(team.data?.items ?? []).map((m) => ({ _id: m._id, fullNameAr: m.fullNameAr, employeeNumber: m.employeeNumber }))} />
    </>
  );
}
