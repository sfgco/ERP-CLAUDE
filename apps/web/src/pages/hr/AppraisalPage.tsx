import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { post, get } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { addDays, riyadhToday } from '@/lib/dates';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, QueryError, Select, Spinner, Textarea, cx } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { appraisalTone, pct, type AppraisalRow, type PlanRow, type TemplateShape } from './_h3a';

interface Detail extends AppraisalRow {
  cycle: { _id: string; nameAr: string; from: string; to: string; dueAt: string; template: TemplateShape } | null;
  events: { _id: string; type: string; fromState?: string; toState?: string; note?: string; actorEmail?: string; at: string }[];
  plan?: PlanRow | null;
  actions: string[];
  canScore: boolean;
}

/**
 * One appraisal [HR §3.7]: the goals snapshot and tasks completion, the manager's scores and notes on the template's
 * criteria, HR's review, the employee's acknowledgement and comment, and the improvement-plan offer under the threshold.
 */
export function AppraisalPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { formatDate, formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['perf', 'appraisal', id], queryFn: () => get<Detail>(`/hr/performance/appraisals/${id}`) });
  const [scores, setScores] = useState<Record<string, { value: number; note: string }>>({});
  const [notes, setNotes] = useState('');
  const [dialog, setDialog] = useState<'return' | 'cancel' | 'acknowledge' | 'approve' | 'plan' | null>(null);
  const [reason, setReason] = useState('');
  const [plan, setPlan] = useState({ to: riyadhToday(addDays(new Date(), 90)), objectives: [{ text: '', measure: '' }] });
  useEffect(() => {
    if (!q.data) return;
    const next: Record<string, { value: number; note: string }> = {};
    for (const s of q.data.scores) next[s.key] = { value: s.value, note: s.note ?? '' };
    setScores(next);
    setNotes(q.data.managerNotes ?? '');
  }, [q.data]);
  const score = useMutation({
    mutationFn: () => post(`/hr/performance/appraisals/${id}/score`, { scores: Object.entries(scores).map(([key, v]) => ({ key, value: v.value, note: v.note || undefined })), managerNotes: notes || undefined }),
    onSuccess: () => {
      toast(t('performance.scored'));
      qc.invalidateQueries({ queryKey: ['perf'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<{ offerImprovementPlan?: boolean }>(`/hr/performance/appraisals/${id}/transition`, body),
    onSuccess: (r) => {
      toast(t('actions.save'));
      setDialog(r.offerImprovementPlan ? 'plan' : null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['perf'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const createPlan = useMutation({
    mutationFn: () => post('/hr/performance/plans', { employeeId: q.data!.employeeId, appraisalId: id, from: riyadhToday(), to: plan.to, objectives: plan.objectives.filter((o) => o.text.trim()).map((o) => ({ text: o.text, measure: o.measure || undefined })) }),
    onSuccess: () => {
      toast(t('performance.planCreated'));
      setDialog(null);
      qc.invalidateQueries({ queryKey: ['perf'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const a = q.data;
  const tpl = a.cycle?.template;
  const has = (x: string) => a.actions.includes(x);
  const goalsPct = a.goalsSnapshot?.length ? Math.round(a.goalsSnapshot.reduce((s, g) => s + g.percent * g.weightBp, 0) / a.goalsSnapshot.reduce((s, g) => s + g.weightBp, 0)) : null;
  return (
    <>
      <PageHeader
        title={`${t('performance.appraisal')} — ${a.employee?.fullNameAr ?? ''}`}
        subtitle={a.cycle ? `${a.cycle.nameAr} · ${formatDate(a.cycle.from)} → ${formatDate(a.cycle.to)} · ${t('performance.dueAt')} ${formatDate(a.cycle.dueAt)}` : undefined}
        actions={
          <>
            <Badge tone={appraisalTone[a.state]}>{t(`performance.states.${a.state}`)}</Badge>
            <Link to="/manager/appraisals" className="text-sm text-brand-700 hover:underline">
              {t('actions.back')}
            </Link>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <Card title={t('performance.snapshot')}>
            <div className="grid gap-3 sm:grid-cols-2 text-sm">
              <div>
                <div className="text-xs text-slate-500">{t('performance.goalsSnapshot')}</div>
                {a.goalsSnapshot?.length ? (
                  <ul className="mt-1 space-y-1">
                    {a.goalsSnapshot.map((g) => (
                      <li key={g._id} className="flex items-center justify-between gap-2">
                        <span>
                          {g.title} <span className="text-xs text-slate-500">({pct(g.weightBp)})</span>
                        </span>
                        <span className="tabular font-medium">{g.percent}%</span>
                      </li>
                    ))}
                    <li className="border-t border-slate-100 pt-1 text-xs text-slate-600">{t('performance.goalsWeighted', { n: goalsPct ?? 0 })}</li>
                  </ul>
                ) : (
                  <p className="text-xs text-slate-500">{t('performance.noGoalsSnapshot')}</p>
                )}
              </div>
              <div>
                <div className="text-xs text-slate-500">{t('performance.tasksCompletion')}</div>
                {a.tasksCompletion && a.tasksCompletion.assigned ? (
                  <p className="mt-1 tabular">{t('performance.tasksLine', { done: a.tasksCompletion.done, assigned: a.tasksCompletion.assigned, late: a.tasksCompletion.late, pct: Math.round((a.tasksCompletion.percentBp ?? 0) / 100) })}</p>
                ) : (
                  <p className="text-xs text-slate-500">{t('performance.noTasks')}</p>
                )}
              </div>
            </div>
          </Card>

          <Card title={t('performance.scoresTitle')}>
            {tpl ? (
              <div className="space-y-4">
                {tpl.sections.map((sec) => (
                  <div key={sec.titleAr}>
                    <h3 className="mb-1 text-sm font-semibold">
                      {sec.titleAr} <span className="text-xs text-slate-500">({pct(sec.weightBp)})</span>
                    </h3>
                    <div className="space-y-2">
                      {sec.criteria.map((c) => {
                        const auto = c.source !== 'manual';
                        const current = scores[c.key];
                        return (
                          <div key={c.key} className={cx('grid gap-2 rounded-lg border border-slate-100 p-2 sm:grid-cols-[1fr_140px_1fr]', auto && 'bg-slate-50')}>
                            <div className="text-sm">
                              {c.labelAr} <span className="text-xs text-slate-500">({pct(c.weightBp)})</span>
                              {auto && <div className="text-xs text-slate-500">{t(`performance.autoFrom.${c.source}`)}</div>}
                            </div>
                            {a.canScore && (!auto || (c.source === 'goals' && !a.goalsSnapshot?.length) || (c.source === 'tasks' && !a.tasksCompletion?.assigned)) ? (
                              <Select value={current?.value ?? ''} onChange={(e) => setScores({ ...scores, [c.key]: { value: Number(e.target.value), note: current?.note ?? '' } })}>
                                <option value="">—</option>
                                {tpl.scale.map((s) => (
                                  <option key={s.value} value={s.value}>
                                    {s.value} — {s.labelAr}
                                  </option>
                                ))}
                              </Select>
                            ) : (
                              <div className="tabular text-sm font-medium">{current ? `${current.value} — ${tpl.scale.find((s) => s.value === current.value)?.labelAr ?? ''}` : '—'}</div>
                            )}
                            {a.canScore && !auto ? <Input placeholder={t('hr.notes')} value={current?.note ?? ''} onChange={(e) => setScores({ ...scores, [c.key]: { value: current?.value ?? 0, note: e.target.value } })} /> : <div className="text-xs text-slate-600">{current?.note}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <Field label={t('performance.managerNotes')}>
                  {a.canScore ? <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /> : <p className="text-sm">{a.managerNotes || '—'}</p>}
                </Field>
                {a.canScore && (
                  <Button onClick={() => score.mutate()} loading={score.isPending}>
                    {t('performance.saveScores')}
                  </Button>
                )}
                <div className="flex items-center justify-between rounded-lg bg-brand-50 p-3">
                  <span className="font-semibold">{t('performance.overall')}</span>
                  <span className="text-xl font-bold tabular text-brand-800">
                    {pct(a.overallScoreBp)} {a.overallRatingLabel ? `· ${a.overallRatingLabel}` : ''}
                  </span>
                </div>
                {a.overallScoreBp !== undefined && tpl.improvementThresholdBp > (a.overallScoreBp ?? 0) && <Alert kind="warning">{t('performance.belowThreshold', { n: pct(tpl.improvementThresholdBp) })}</Alert>}
              </div>
            ) : (
              <Alert kind="error">{t('performance.noTemplateSnapshot')}</Alert>
            )}
            {a.hrNotes && (
              <p className="mt-3 text-sm">
                <strong>{t('performance.hrNotes')}:</strong> {a.hrNotes}
              </p>
            )}
            {a.employeeComment && (
              <p className="mt-2 text-sm">
                <strong>{t('performance.employeeComment')}:</strong> {a.employeeComment}
              </p>
            )}
          </Card>

          {a.actions.length > 0 && (
            <Card title={t('requests.actions')}>
              <div className="flex flex-wrap gap-2">
                {has('submit') && <Button onClick={() => act.mutate({ transition: 'submit' })}>{t('performance.actions.submit')}</Button>}
                {has('approve') && <Button onClick={() => setDialog('approve')}>{t('performance.actions.approve')}</Button>}
                {has('return') && (
                  <Button variant="secondary" onClick={() => setDialog('return')}>
                    {t('performance.actions.return')}
                  </Button>
                )}
                {has('acknowledge') && <Button onClick={() => setDialog('acknowledge')}>{t('performance.actions.acknowledge')}</Button>}
                {has('cancel') && (
                  <Button variant="danger" onClick={() => setDialog('cancel')}>
                    {t('performance.actions.cancel')}
                  </Button>
                )}
              </div>
            </Card>
          )}
          {a.plan && (
            <Card title={t('performance.tabs.plans')}>
              <Link to={`/hr/performance/plans/${a.plan._id}`} className="text-sm text-brand-700 hover:underline">
                {t('performance.planLink', { to: formatDate(a.plan.to) })}
              </Link>
            </Card>
          )}
        </div>
        <Card title={t('requests.log')}>
          <ol className="relative space-y-3 border-s border-slate-200 ps-4 text-sm">
            {a.events.map((e) => (
              <li key={e._id} className="relative">
                <span className="absolute -start-[21px] top-1.5 size-2.5 rounded-full bg-brand-600" aria-hidden />
                <div className="font-medium">
                  {t(`performance.events.${e.type}`, e.type)}
                  {e.toState && <span className="ms-2 text-xs text-slate-500">← {t(`performance.states.${e.toState}`, e.toState)}</span>}
                </div>
                {e.note && <div className="text-xs text-slate-600">{e.note}</div>}
                <div className="text-xs text-slate-400 tabular">
                  {formatDateTime(e.at)} · {e.actorEmail}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Dialog open={dialog === 'return' || dialog === 'cancel' || dialog === 'approve' || dialog === 'acknowledge'} onClose={() => setDialog(null)} title={dialog ? t(`performance.actions.${dialog}`) : ''}>
        <div className="space-y-3">
          <Field label={dialog === 'approve' ? t('performance.hrNotes') : dialog === 'acknowledge' ? t('performance.employeeComment') : t('requests.reasonRequired')} required={dialog === 'return' || dialog === 'cancel'}>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant={dialog === 'cancel' ? 'danger' : 'primary'}
              loading={act.isPending}
              disabled={(dialog === 'return' || dialog === 'cancel') && reason.trim().length < 2}
              onClick={() => dialog && act.mutate(dialog === 'approve' ? { transition: 'approve', hrNotes: reason || undefined } : dialog === 'acknowledge' ? { transition: 'acknowledge', employeeComment: reason || undefined } : { transition: dialog, reason })}
            >
              {dialog ? t(`performance.actions.${dialog}`) : ''}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={dialog === 'plan'} onClose={() => setDialog(null)} title={t('performance.offerPlan')}>
        <div className="space-y-3">
          <Alert kind="warning">{t('performance.offerPlanHint')}</Alert>
          <Field label={t('attendance.to')}>
            <Input type="date" dir="ltr" value={plan.to} onChange={(e) => setPlan({ ...plan, to: e.target.value })} />
          </Field>
          {plan.objectives.map((o, i) => (
            <div key={i} className="grid grid-cols-2 gap-2">
              <Input placeholder={t('performance.objective')} value={o.text} onChange={(e) => setPlan({ ...plan, objectives: plan.objectives.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
              <Input placeholder={t('performance.measure')} value={o.measure} onChange={(e) => setPlan({ ...plan, objectives: plan.objectives.map((x, j) => (j === i ? { ...x, measure: e.target.value } : x)) })} />
            </div>
          ))}
          <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setPlan({ ...plan, objectives: [...plan.objectives, { text: '', measure: '' }] })}>
            {t('performance.addObjective')}
          </button>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('performance.noPlanNow')}
            </Button>
            <Button onClick={() => createPlan.mutate()} loading={createPlan.isPending} disabled={!plan.objectives.some((o) => o.text.trim().length >= 3)}>
              {t('performance.createPlan')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
