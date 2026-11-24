import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Spinner, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { appraisalTone, disciplineTone, goalTone, pct, type AppraisalRow, type DisciplinaryRow, type GoalRow, type PlanRow } from '../hr/_h3a';

interface Me {
  goals: GoalRow[];
  appraisals: (AppraisalRow & { actions: string[] })[];
  plans: PlanRow[];
  disciplinaryActions: DisciplinaryRow[];
}

/** «أدائي وتدريبي» [HR §3.7]: my goals and progress, my approved appraisals (acknowledge), my improvement plan, actions delivered to me. */
export function MyPerformancePage() {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['perf', 'me'], queryFn: () => get<Me>('/hr/performance/me') });
  const [progress, setProgress] = useState<{ id: string; percent: number; note: string } | null>(null);
  const [appeal, setAppeal] = useState<{ id: string; note: string } | null>(null);
  const addProgress = useMutation({
    mutationFn: () => post(`/hr/performance/goals/${progress!.id}/progress`, { percent: progress!.percent, note: progress!.note || undefined }),
    onSuccess: () => {
      toast(t('actions.save'));
      setProgress(null);
      qc.invalidateQueries({ queryKey: ['perf'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const discipline = useMutation({
    mutationFn: (body: { id: string; transition: string; note?: string }) => post(`/hr/discipline/${body.id}/transition`, { transition: body.transition, note: body.note }),
    onSuccess: () => {
      toast(t('actions.save'));
      setAppeal(null);
      qc.invalidateQueries({ queryKey: ['perf'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const d = q.data;
  return (
    <>
      <PageHeader
        title={t('performance.myTitle')}
        subtitle={t('performance.myHint')}
        actions={
          <Link to="/me/training" className="text-sm text-brand-700 hover:underline">
            {t('nav.myTraining')}
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('performance.tabs.goals')}>
          {!d.goals.length ? (
            <EmptyState title={t('performance.noMyGoals')} />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.goals.map((g) => (
                <li key={g._id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{g.title}</div>
                      <div className="text-xs text-slate-500">
                        {g.kpiNameAr ? `${t('performance.kpi')}: ${g.kpiNameAr} · ` : ''}
                        {t('performance.weight')} {pct(g.weightBp)}
                        {g.dueDate ? ` · ${t('performance.dueDate')} ${formatDate(g.dueDate)}` : ''}
                      </div>
                    </div>
                    <div className="text-end">
                      <div className="text-lg font-bold tabular">{g.percent}%</div>
                      <Badge tone={goalTone[g.state]}>{t(`performance.goalStates.${g.state}`)}</Badge>
                    </div>
                  </div>
                  <div className="mt-1 h-2 rounded bg-slate-100">
                    <div className="h-2 rounded bg-brand-500" style={{ width: `${g.percent}%` }} />
                  </div>
                  {g.state === 'active' && (
                    <button type="button" className="mt-1 text-xs text-brand-700 hover:underline" onClick={() => setProgress({ id: g._id, percent: g.percent, note: '' })}>
                      {t('performance.updateProgress')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('performance.tabs.appraisals')}>
          {!d.appraisals.length ? (
            <EmptyState title={t('performance.noMyAppraisals')} hint={t('performance.noMyAppraisalsHint')} />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.appraisals.map((a) => (
                <li key={a._id} className="flex items-center justify-between gap-2 py-2">
                  <div>
                    <Link to={`/hr/performance/appraisals/${a._id}`} className="font-medium text-brand-800 hover:underline">
                      {a.cycleName}
                    </Link>
                    <div className="text-xs text-slate-500">{a.managerNotes}</div>
                  </div>
                  <div className="text-end">
                    <div className="font-bold tabular">
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
          {!d.plans.length ? (
            <p className="text-sm text-slate-500">{t('common.empty')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.plans.map((p) => (
                <li key={p._id} className="rounded-lg border border-slate-100 p-2">
                  <div className="flex items-center justify-between">
                    <span className="tabular">
                      {formatDate(p.from)} → {formatDate(p.to)}
                    </span>
                    <Badge tone={p.state === 'active' ? 'blue' : p.state === 'completed' ? 'green' : 'red'}>{t(`performance.planStates.${p.state}`)}</Badge>
                  </div>
                  <ul className="mt-1 list-disc ps-5 text-xs text-slate-600">
                    {p.objectives.map((o, i) => (
                      <li key={i} className={o.done ? 'line-through' : ''}>
                        {o.text}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('discipline.myTitle')}>
          {!d.disciplinaryActions.length ? (
            <p className="text-sm text-slate-500">{t('discipline.none')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.disciplinaryActions.map((a) => (
                <li key={a._id} className="rounded-lg border border-slate-100 p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {a.kindLabelAr} <span className="text-xs text-slate-500">{a.number}</span>
                    </span>
                    <Badge tone={disciplineTone[a.state]}>{t(`discipline.states.${a.state}`)}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">{a.description}</p>
                  <div className="mt-1 text-xs text-slate-500">
                    {t('discipline.violationDate')}: {formatDate(a.violationDate)}
                    {a.deliveredAt ? ` · ${t('discipline.deliveredAt')}: ${formatDate(a.deliveredAt)}` : ''}
                    {a.appealDeadline && a.state === 'delivered' ? ` · ${t('discipline.appealUntil', { date: formatDate(a.appealDeadline) })}` : ''}
                  </div>
                  {a.state === 'delivered' && (
                    <div className="mt-2 flex gap-2">
                      <Button variant="secondary" onClick={() => discipline.mutate({ id: a._id, transition: 'acknowledge' })}>
                        {t('discipline.actions.acknowledge')}
                      </Button>
                      <Button variant="secondary" onClick={() => setAppeal({ id: a._id, note: '' })}>
                        {t('discipline.actions.appeal')}
                      </Button>
                    </div>
                  )}
                  {a.appeal?.outcome && <Alert kind="info">{t(`discipline.appealOutcome.${a.appeal.outcome}`, a.appeal.outcome)} {a.appeal.decisionNote ? `— ${a.appeal.decisionNote}` : ''}</Alert>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Dialog open={!!progress} onClose={() => setProgress(null)} title={t('performance.updateProgress')}>
        {progress && (
          <div className="space-y-3">
            <Field label={t('performance.progress')}>
              <Input type="number" dir="ltr" min={0} max={100} value={progress.percent} onChange={(e) => setProgress({ ...progress, percent: Number(e.target.value) })} />
            </Field>
            <Field label={t('hr.notes')}>
              <Textarea rows={2} value={progress.note} onChange={(e) => setProgress({ ...progress, note: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setProgress(null)}>
                {t('actions.cancel')}
              </Button>
              <Button onClick={() => addProgress.mutate()} loading={addProgress.isPending}>
                {t('actions.save')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog open={!!appeal} onClose={() => setAppeal(null)} title={t('discipline.actions.appeal')}>
        {appeal && (
          <div className="space-y-3">
            <Field label={t('discipline.appealNote')} required>
              <Textarea rows={3} value={appeal.note} onChange={(e) => setAppeal({ ...appeal, note: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAppeal(null)}>
                {t('actions.cancel')}
              </Button>
              <Button onClick={() => discipline.mutate({ id: appeal.id, transition: 'appeal', note: appeal.note })} loading={discipline.isPending} disabled={appeal.note.trim().length < 3}>
                {t('discipline.actions.appeal')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
