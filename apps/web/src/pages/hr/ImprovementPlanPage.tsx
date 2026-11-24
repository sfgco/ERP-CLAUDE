import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Dialog, Field, PageHeader, QueryError, Select, Spinner, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import type { PlanRow } from './_h3a';

interface Detail extends PlanRow {
  events: { _id: string; type: string; note?: string; actorEmail?: string; at: string }[];
}

/** «متابعة خطط تحسين الأداء» [HR §3.7]: the objectives, the append-only reviews, and the closing decision. */
export function ImprovementPlanPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate, formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['perf', 'plan', id], queryFn: () => get<Detail>(`/hr/performance/plans/${id}`) });
  const [review, setReview] = useState<{ note: string; rating: string; done: number[] } | null>(null);
  const [close, setClose] = useState<{ state: 'completed' | 'not_completed' | 'cancelled'; note: string } | null>(null);
  const done = () => {
    toast(t('actions.save'));
    setReview(null);
    setClose(null);
    qc.invalidateQueries({ queryKey: ['perf'] });
  };
  const fail = (e: unknown) => toast(errorMessage(e), 'error');
  const addReview = useMutation({ mutationFn: () => post(`/hr/performance/plans/${id}/reviews`, { note: review!.note, rating: review!.rating ? Number(review!.rating) : undefined, objectivesDone: review!.done }), onSuccess: done, onError: fail });
  const closePlan = useMutation({ mutationFn: () => post(`/hr/performance/plans/${id}/close`, close), onSuccess: done, onError: fail });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const p = q.data;
  const canEdit = can('hr.improvement_plans', 'edit') && p.state === 'active';
  return (
    <>
      <PageHeader
        title={`${t('performance.plan')} — ${p.employee?.fullNameAr ?? ''}`}
        subtitle={`${formatDate(p.from)} → ${formatDate(p.to)}`}
        actions={
          <>
            <Badge tone={p.state === 'active' ? 'blue' : p.state === 'completed' ? 'green' : 'red'}>{t(`performance.planStates.${p.state}`)}</Badge>
            <Link to="/hr/performance" className="text-sm text-brand-700 hover:underline">
              {t('actions.back')}
            </Link>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={t('performance.objectives')}
          actions={
            canEdit && (
              <>
                <Button variant="secondary" onClick={() => setReview({ note: '', rating: '', done: [] })}>
                  {t('performance.addReview')}
                </Button>
                <Button onClick={() => setClose({ state: 'completed', note: '' })}>{t('performance.closePlan')}</Button>
              </>
            )
          }
        >
          <ul className="space-y-2 text-sm">
            {p.objectives.map((o, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={o.done ? 'text-emerald-700' : 'text-slate-400'}>{o.done ? '✓' : '○'}</span>
                <div>
                  <div className={o.done ? 'line-through text-slate-500' : ''}>{o.text}</div>
                  {o.measure && <div className="text-xs text-slate-500">{o.measure}</div>}
                </div>
              </li>
            ))}
          </ul>
          {p.closingNote && (
            <p className="mt-3 text-sm">
              <strong>{t('performance.closingNote')}:</strong> {p.closingNote}
            </p>
          )}
        </Card>
        <Card title={t('performance.reviews')}>
          {p.reviews.length ? (
            <ul className="divide-y divide-slate-100 text-sm">
              {p.reviews.map((r, i) => (
                <li key={i} className="py-2">
                  <div>{r.note}</div>
                  <div className="text-xs text-slate-500 tabular">
                    {formatDateTime(r.at)} · {r.byEmail} {r.rating ? `· ${t('performance.rating')} ${r.rating}/5` : ''}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">{t('common.empty')}</p>
          )}
        </Card>
      </div>
      <Dialog open={!!review} onClose={() => setReview(null)} title={t('performance.addReview')}>
        {review && (
          <div className="space-y-3">
            <Field label={t('performance.reviewNote')} required>
              <Textarea rows={3} value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} />
            </Field>
            <Field label={t('performance.rating')}>
              <Select value={review.rating} onChange={(e) => setReview({ ...review, rating: e.target.value })}>
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('performance.objectivesDone')}>
              <div className="space-y-1 text-sm">
                {p.objectives.map((o, i) => (
                  <label key={i} className="flex items-center gap-2">
                    <input type="checkbox" disabled={o.done} checked={o.done || review.done.includes(i)} onChange={(e) => setReview({ ...review, done: e.target.checked ? [...review.done, i] : review.done.filter((x) => x !== i) })} /> {o.text}
                  </label>
                ))}
              </div>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setReview(null)}>
                {t('actions.cancel')}
              </Button>
              <Button onClick={() => addReview.mutate()} loading={addReview.isPending} disabled={review.note.trim().length < 2}>
                {t('actions.save')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog open={!!close} onClose={() => setClose(null)} title={t('performance.closePlan')}>
        {close && (
          <div className="space-y-3">
            <Field label={t('common.status')}>
              <Select value={close.state} onChange={(e) => setClose({ ...close, state: e.target.value as typeof close.state })}>
                {(['completed', 'not_completed', 'cancelled'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`performance.planStates.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('performance.closingNote')} required>
              <Textarea rows={3} value={close.note} onChange={(e) => setClose({ ...close, note: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setClose(null)}>
                {t('actions.cancel')}
              </Button>
              <Button onClick={() => closePlan.mutate()} loading={closePlan.isPending} disabled={close.note.trim().length < 2}>
                {t('actions.save')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
