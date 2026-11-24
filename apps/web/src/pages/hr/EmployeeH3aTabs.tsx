import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get } from '@/lib/api';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, EmptyState, QueryError, Spinner, Table, Td } from '@/shared/ui';
import { appraisalTone, disciplineTone, goalTone, participantTone, pct, riyals, type AppraisalRow, type DisciplinaryRow, type GoalRow, type ParticipantRow, type PayslipRow, type PlanRow } from './_h3a';
import { GoalDialog } from './GoalDialog';

/** Employee file → tab «الرواتب» (HR / Finance only) [HR §3.6.8–3.6.9]: the payslips of this employee. */
export function EmployeePayrollTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['payslips', 'employee', employeeId], queryFn: () => get<{ items: PayslipRow[] }>(`/hr/payslips?employeeId=${employeeId}&limit=36`) });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  return (
    <Card title={t('hr.tabs.payroll')}>
      {!q.data.items.length ? (
        <EmptyState title={t('payslips.empty')} />
      ) : (
        <Table head={[t('payroll.period'), t('payroll.gross'), t('payroll.deductions'), t('payroll.net'), t('payroll.attendanceShort'), '']}>
          {q.data.items.map((p) => (
            <tr key={p._id}>
              <Td className="tabular">{p.period}</Td>
              <Td className="tabular text-xs">{riyals(p.grossHalalas)}</Td>
              <Td className="tabular text-xs">{riyals(p.deductionsHalalas)}</Td>
              <Td className="tabular font-semibold">{riyals(p.netHalalas)}</Td>
              <Td className="text-xs text-slate-600">{t('payroll.attLine', { present: p.attendance?.presentDays ?? 0, absent: p.attendance?.absentDays ?? 0, late: p.attendance?.lateMinutes ?? 0, ot: p.attendance?.overtimeApprovedMinutes ?? 0 })}</Td>
              <Td>
                <Link to={`/hr/payroll/${p.runId}`} className="text-xs text-brand-700 hover:underline">
                  {t('payroll.run')}
                </Link>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/** Employee file → tab «الأداء والتدريب» [HR §3.7, §3.8]: goals, appraisals, plans, courses. */
export function EmployeePerformanceTab({ employeeId, fullNameAr, employeeNumber }: { employeeId: string; fullNameAr: string; employeeNumber: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate } = usePrefs();
  const [goalDialog, setGoalDialog] = useState(false);
  const goals = useQuery({ queryKey: ['perf', 'goals', employeeId], queryFn: () => get<{ items: GoalRow[] }>(`/hr/performance/goals?employeeId=${employeeId}`) });
  const appraisals = useQuery({ queryKey: ['perf', 'appraisals', employeeId], queryFn: () => get<{ items: AppraisalRow[] }>(`/hr/performance/appraisals?employeeId=${employeeId}&limit=50`) });
  const plans = useQuery({ queryKey: ['perf', 'plans', employeeId], queryFn: () => get<{ items: PlanRow[] }>(`/hr/performance/plans?employeeId=${employeeId}`) });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t('performance.tabs.goals')} actions={can('hr.goals', 'create') && <Button variant="secondary" onClick={() => setGoalDialog(true)}>{t('performance.newGoal')}</Button>}>
        {goals.isLoading ? (
          <Spinner />
        ) : !goals.data?.items.length ? (
          <p className="text-sm text-slate-500">{t('performance.noGoals')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {goals.data.items.map((g) => (
              <li key={g._id} className="flex items-center justify-between gap-2 py-2">
                <div>
                  <div className="font-medium">{g.title}</div>
                  <div className="text-xs text-slate-500">
                    {g.kpiNameAr ?? ''} · {pct(g.weightBp)}
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
      <Card title={t('performance.tabs.appraisals')}>
        {appraisals.isLoading ? (
          <Spinner />
        ) : !appraisals.data?.items.length ? (
          <p className="text-sm text-slate-500">{t('common.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {appraisals.data.items.map((a) => (
              <li key={a._id} className="flex items-center justify-between gap-2 py-2">
                <Link to={`/hr/performance/appraisals/${a._id}`} className="font-medium text-brand-800 hover:underline">
                  {a.cycleName}
                </Link>
                <div className="text-end">
                  <div className="tabular font-semibold">
                    {pct(a.overallScoreBp)} {a.overallRatingLabel ? `· ${a.overallRatingLabel}` : ''}
                  </div>
                  <Badge tone={appraisalTone[a.state]}>{t(`performance.states.${a.state}`)}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('performance.tabs.plans')}>
        {plans.isLoading ? (
          <Spinner />
        ) : !plans.data?.items.length ? (
          <p className="text-sm text-slate-500">{t('common.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {plans.data.items.map((p) => (
              <li key={p._id} className="flex items-center justify-between py-2">
                <Link to={`/hr/performance/plans/${p._id}`} className="text-brand-800 hover:underline tabular">
                  {formatDate(p.from)} → {formatDate(p.to)}
                </Link>
                <Badge tone={p.state === 'active' ? 'blue' : p.state === 'completed' ? 'green' : 'red'}>{t(`performance.planStates.${p.state}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <EmployeeTrainingCard employeeId={employeeId} />
      <GoalDialog open={goalDialog} onClose={() => setGoalDialog(false)} employees={[{ _id: employeeId, fullNameAr, employeeNumber }]} employeeId={employeeId} />
    </div>
  );
}

function EmployeeTrainingCard({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const q = useQuery({
    queryKey: ['training', 'employee', employeeId],
    queryFn: async () => {
      const courses = await get<{ items: { _id: string; title: string; startAt: string; endAt: string; providerName?: string }[] }>('/hr/training/trainings');
      const details = await Promise.all(courses.items.map((c) => get<{ participants: ParticipantRow[] }>(`/hr/training/trainings/${c._id}`)));
      return courses.items.flatMap((c, i) => details[i].participants.filter((p) => p.employeeId === employeeId).map((p) => ({ ...p, training: c })));
    },
  });
  return (
    <Card title={t('hr.tabs.training')}>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.length ? (
        <p className="text-sm text-slate-500">{t('training.noMyCourses')}</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {q.data.map((p) => (
            <li key={p._id} className="flex items-center justify-between gap-2 py-2">
              <div>
                <div className="font-medium">{p.training?.title}</div>
                <div className="text-xs text-slate-500">
                  {p.training?.providerName} · {p.training ? formatDate(p.training.startAt) : ''}
                  {p.certificateAttachmentId ? ` · ${t('training.certificate')} ✓` : ''}
                </div>
              </div>
              <Badge tone={participantTone[p.status]}>{t(`training.participantStatuses.${p.status}`)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Employee file → tab «الإجراءات الإدارية» [HR §3.7]. */
export function EmployeeDisciplineTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const q = useQuery({ queryKey: ['discipline', 'employee', employeeId], queryFn: () => get<{ items: DisciplinaryRow[] }>(`/hr/discipline?employeeId=${employeeId}`) });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  return (
    <Card title={t('hr.tabs.discipline')}>
      {!q.data.items.length ? (
        <EmptyState title={t('discipline.none')} />
      ) : (
        <Table head={[t('common.number'), t('discipline.kind'), t('discipline.violationDate'), t('common.status'), t('discipline.fine')]}>
          {q.data.items.map((d) => (
            <tr key={d._id}>
              <Td className="tabular text-xs">
                <Link to={`/hr/discipline/${d._id}`} className="text-brand-800 hover:underline">
                  {d.number}
                </Link>
              </Td>
              <Td>{d.kindLabelAr}</Td>
              <Td className="tabular text-xs">{formatDate(d.violationDate)}</Td>
              <Td>
                <Badge tone={disciplineTone[d.state]}>{t(`discipline.states.${d.state}`)}</Badge>
              </Td>
              <Td className="tabular text-xs">{d.fineHalalas ? riyals(d.fineHalalas) : '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
