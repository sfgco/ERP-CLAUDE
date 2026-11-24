import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { APPRAISAL_CYCLE_KINDS, DEFAULT_APPRAISAL_TEMPLATE, GOAL_STATES } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, cx } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { useHrLookups } from './_data';
import { appraisalTone, goalTone, pct, type AppraisalRow, type CycleRow, type GoalRow, type PlanRow, type TemplateShape } from './_h3a';
import { GoalDialog } from './GoalDialog';

type Tab = 'cycles' | 'appraisals' | 'goals' | 'plans' | 'templates';

/** «تقييم الأداء» for HR [HR §3.7, §9.9]: cycles and their completion, every appraisal, goals, improvement plans, the form template. */
export function PerformancePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { formatDate } = usePrefs();
  const lk = useHrLookups();
  const [tab, setTab] = useState<Tab>('cycles');
  const cycles = useQuery({ queryKey: ['perf', 'cycles'], queryFn: () => get<{ items: CycleRow[]; provisional: boolean }>('/hr/performance/cycles') });
  const templates = useQuery({ queryKey: ['perf', 'templates'], queryFn: () => get<{ items: TemplateShape[] }>('/hr/performance/templates') });
  const [cycleFilter, setCycleFilter] = useState('');
  const appraisals = useQuery({
    queryKey: ['perf', 'appraisals', cycleFilter],
    queryFn: () => get<{ items: AppraisalRow[] }>(`/hr/performance/appraisals?view=all&limit=500${cycleFilter ? `&cycleId=${cycleFilter}` : ''}`),
    enabled: tab === 'appraisals',
  });
  const goals = useQuery({ queryKey: ['perf', 'goals', 'all'], queryFn: () => get<{ items: GoalRow[] }>('/hr/performance/goals'), enabled: tab === 'goals' });
  const plans = useQuery({ queryKey: ['perf', 'plans'], queryFn: () => get<{ items: PlanRow[] }>('/hr/performance/plans'), enabled: tab === 'plans' });
  const [newCycle, setNewCycle] = useState<{ year: number; kind: string; from: string; to: string; opensAt: string; dueAt: string; templateId: string } | null>(null);
  const [goalDialog, setGoalDialog] = useState(false);
  const isHr = can('hr.appraisals', 'approve');
  const done = (ok: string) => () => {
    toast(ok);
    setNewCycle(null);
    qc.invalidateQueries({ queryKey: ['perf'] });
  };
  const fail = (e: unknown) => toast(errorMessage(e), 'error');
  const createCycle = useMutation({ mutationFn: (v: unknown) => post('/hr/performance/cycles', v), onSuccess: done(t('performance.cycleCreated')), onError: fail });
  const openCycle = useMutation({ mutationFn: (id: string) => post(`/hr/performance/cycles/${id}/open`), onSuccess: done(t('performance.cycleOpened')), onError: fail });
  const closeCycle = useMutation({ mutationFn: (id: string) => post(`/hr/performance/cycles/${id}/close`), onSuccess: done(t('actions.save')), onError: fail });
  const createTemplate = useMutation({ mutationFn: () => post('/hr/performance/templates', DEFAULT_APPRAISAL_TEMPLATE), onSuccess: done(t('performance.templateCreated')), onError: fail });
  const tabs: { key: Tab; label: string }[] = [
    { key: 'cycles', label: t('performance.tabs.cycles') },
    { key: 'appraisals', label: t('performance.tabs.appraisals') },
    { key: 'goals', label: t('performance.tabs.goals') },
    { key: 'plans', label: t('performance.tabs.plans') },
    { key: 'templates', label: t('performance.tabs.templates') },
  ];
  const activeTemplate = templates.data?.items.find((x) => x.active);
  return (
    <>
      <PageHeader
        title={t('performance.title')}
        subtitle={t('performance.hint')}
        actions={
          <>
            <Link to="/hr/discipline" className="text-sm text-brand-700 hover:underline">
              {t('nav.discipline')}
            </Link>
            {isHr && tab === 'cycles' && (
              <Button onClick={() => setNewCycle({ year: Number(riyadhToday().slice(0, 4)), kind: 'semi_annual_1', from: `${riyadhToday().slice(0, 4)}-01-01`, to: `${riyadhToday().slice(0, 4)}-06-30`, opensAt: riyadhToday(), dueAt: riyadhToday(), templateId: activeTemplate?._id ?? '' })} disabled={!activeTemplate}>
                {t('performance.newCycle')}
              </Button>
            )}
            {can('hr.goals', 'create') && tab === 'goals' && <Button onClick={() => setGoalDialog(true)}>{t('performance.newGoal')}</Button>}
          </>
        }
      />
      {cycles.data?.provisional && <Alert kind="warning">{t('performance.provisional')}</Alert>}
      <div className="mb-4 mt-3 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {tabs.map((x) => (
          <button key={x.key} role="tab" aria-selected={tab === x.key} onClick={() => setTab(x.key)} className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === x.key ? 'border-brand-700 text-brand-800' : 'border-transparent text-slate-600 hover:text-slate-900')}>
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'cycles' && (
        <Card>
          {cycles.isLoading ? (
            <Spinner />
          ) : !cycles.data?.items.length ? (
            <EmptyState title={t('performance.noCycles')} hint={activeTemplate ? undefined : t('performance.needTemplate')} />
          ) : (
            <Table head={[t('performance.cycle'), t('performance.window'), t('performance.opensAt'), t('performance.dueAt'), t('common.status'), t('performance.completion'), '']}>
              {cycles.data.items.map((c) => {
                const total = Object.entries(c.counts ?? {}).filter(([k]) => k !== 'cancelled').reduce((s, [, n]) => s + n, 0);
                const done = (c.counts?.approved ?? 0) + (c.counts?.acknowledged ?? 0);
                return (
                  <tr key={c._id}>
                    <Td className="font-medium">{c.nameAr}</Td>
                    <Td className="tabular text-xs">
                      {formatDate(c.from)} → {formatDate(c.to)}
                    </Td>
                    <Td className="tabular text-xs">{formatDate(c.opensAt)}</Td>
                    <Td className="tabular text-xs">{formatDate(c.dueAt)}</Td>
                    <Td>
                      <Badge tone={c.state === 'open' ? 'blue' : c.state === 'closed' ? 'slate' : 'amber'}>{t(`performance.cycleStates.${c.state}`)}</Badge>
                    </Td>
                    <Td className="tabular text-xs">
                      {total ? `${done} / ${total} (${Math.round((done / total) * 100)}%)` : '—'}
                      {c.counts?.manager_submitted ? <div className="text-brand-700">{t('performance.awaitingHr', { n: c.counts.manager_submitted })}</div> : null}
                    </Td>
                    <Td>
                      <div className="flex gap-2 text-xs">
                        <button type="button" className="text-brand-700 hover:underline" onClick={() => { setCycleFilter(c._id); setTab('appraisals'); }}>
                          {t('performance.tabs.appraisals')}
                        </button>
                        {isHr && c.state === 'planned' && (
                          <button type="button" className="text-brand-700 hover:underline" onClick={() => openCycle.mutate(c._id)}>
                            {t('performance.open')}
                          </button>
                        )}
                        {isHr && c.state === 'open' && (
                          <button type="button" className="text-slate-600 hover:underline" onClick={() => closeCycle.mutate(c._id)}>
                            {t('performance.close')}
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      )}

      {tab === 'appraisals' && (
        <Card
          actions={
            <Select value={cycleFilter} onChange={(e) => setCycleFilter(e.target.value)} className="w-56">
              <option value="">{t('common.all')}</option>
              {cycles.data?.items.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.nameAr}
                </option>
              ))}
            </Select>
          }
          title={t('performance.tabs.appraisals')}
        >
          {appraisals.isLoading ? (
            <Spinner />
          ) : !appraisals.data?.items.length ? (
            <EmptyState title={t('common.empty')} />
          ) : (
            <Table head={[t('hr.employee'), t('performance.cycle'), t('common.status'), t('performance.score'), t('performance.rating'), t('performance.dueAt')]}>
              {appraisals.data.items.map((a) => (
                <tr key={a._id}>
                  <Td>
                    <Link to={`/hr/performance/appraisals/${a._id}`} className="font-medium text-brand-800 hover:underline">
                      {a.employee?.fullNameAr ?? '—'}
                    </Link>
                    <div className="text-xs text-slate-500">{a.employee?.employeeNumber}</div>
                  </Td>
                  <Td className="text-xs">{a.cycleName}</Td>
                  <Td>
                    <Badge tone={appraisalTone[a.state]}>{t(`performance.states.${a.state}`)}</Badge>
                  </Td>
                  <Td className="tabular">{pct(a.overallScoreBp)}</Td>
                  <Td>{a.overallRatingLabel ?? '—'}</Td>
                  <Td className="tabular text-xs">{a.dueAt ? formatDate(a.dueAt) : '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'goals' && (
        <Card title={t('performance.tabs.goals')}>
          {goals.isLoading ? (
            <Spinner />
          ) : !goals.data?.items.length ? (
            <EmptyState title={t('performance.noGoals')} />
          ) : (
            <Table head={[t('hr.employee'), t('performance.goal'), t('performance.kpi'), t('performance.weight'), t('performance.progress'), t('common.status')]}>
              {goals.data.items.map((g) => (
                <tr key={g._id}>
                  <Td>
                    <Link to={`/hr/employees/${g.employeeId}`} className="text-brand-800 hover:underline">
                      {g.employee?.fullNameAr ?? '—'}
                    </Link>
                  </Td>
                  <Td className="font-medium">{g.title}</Td>
                  <Td className="text-xs">{g.kpiNameAr ?? '—'}</Td>
                  <Td className="tabular">{pct(g.weightBp)}</Td>
                  <Td className="tabular">{g.percent}%</Td>
                  <Td>
                    <Badge tone={goalTone[g.state]}>{t(`performance.goalStates.${g.state}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'plans' && (
        <Card title={t('performance.tabs.plans')}>
          {plans.isLoading ? (
            <Spinner />
          ) : !plans.data?.items.length ? (
            <EmptyState title={t('common.empty')} />
          ) : (
            <Table head={[t('hr.employee'), t('performance.window'), t('performance.objectives'), t('performance.reviews'), t('common.status')]}>
              {plans.data.items.map((p) => (
                <tr key={p._id}>
                  <Td>
                    <Link to={`/hr/performance/plans/${p._id}`} className="font-medium text-brand-800 hover:underline">
                      {p.employee?.fullNameAr ?? '—'}
                    </Link>
                  </Td>
                  <Td className="tabular text-xs">
                    {formatDate(p.from)} → {formatDate(p.to)}
                  </Td>
                  <Td className="tabular text-xs">
                    {p.objectives.filter((o) => o.done).length} / {p.objectives.length}
                  </Td>
                  <Td className="tabular text-xs">{p.reviews.length}</Td>
                  <Td>
                    <Badge tone={p.state === 'active' ? 'blue' : p.state === 'completed' ? 'green' : 'red'}>{t(`performance.planStates.${p.state}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'templates' && (
        <Card title={t('performance.tabs.templates')} actions={isHr && !templates.data?.items.length ? <Button onClick={() => createTemplate.mutate()}>{t('performance.createDefaultTemplate')}</Button> : undefined}>
          {templates.isLoading ? (
            <Spinner />
          ) : !templates.data?.items.length ? (
            <EmptyState title={t('performance.noTemplates')} hint={t('performance.defaultTemplateHint')} />
          ) : (
            <div className="space-y-4">
              {templates.data.items.map((tpl) => (
                <div key={tpl._id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">
                      {tpl.nameAr} <span className="text-xs text-slate-500" dir="ltr">v{tpl.version}</span>
                    </div>
                    {tpl.active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {tpl.sections.map((s, i) => (
                      <li key={i}>
                        <span className="font-medium">{s.titleAr}</span> <span className="text-xs text-slate-500">({pct(s.weightBp)})</span>
                        <span className="text-slate-600"> — {s.criteria.map((c) => `${c.labelAr} ${pct(c.weightBp)}${c.source !== 'manual' ? ` (${t(`performance.sources.${c.source}`)})` : ''}`).join(t('common.listSeparator'))}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 text-xs text-slate-500">
                    {t('performance.scale')}: {tpl.scale.map((s) => `${s.value} = ${s.labelAr}`).join(t('common.listSeparator'))} · {t('performance.threshold', { n: pct(tpl.improvementThresholdBp) })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Dialog open={!!newCycle} onClose={() => setNewCycle(null)} title={t('performance.newCycle')}>
        {newCycle && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              createCycle.mutate(newCycle);
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('leave.year')}>
                <Input type="number" dir="ltr" value={newCycle.year} onChange={(e) => setNewCycle({ ...newCycle, year: Number(e.target.value) })} />
              </Field>
              <Field label={t('performance.kind')}>
                <Select value={newCycle.kind} onChange={(e) => setNewCycle({ ...newCycle, kind: e.target.value })}>
                  {APPRAISAL_CYCLE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`performance.kinds.${k}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('attendance.from')}>
                <Input type="date" dir="ltr" value={newCycle.from} onChange={(e) => setNewCycle({ ...newCycle, from: e.target.value })} />
              </Field>
              <Field label={t('attendance.to')}>
                <Input type="date" dir="ltr" value={newCycle.to} onChange={(e) => setNewCycle({ ...newCycle, to: e.target.value })} />
              </Field>
              <Field label={t('performance.opensAt')}>
                <Input type="date" dir="ltr" value={newCycle.opensAt} onChange={(e) => setNewCycle({ ...newCycle, opensAt: e.target.value })} />
              </Field>
              <Field label={t('performance.dueAt')}>
                <Input type="date" dir="ltr" value={newCycle.dueAt} onChange={(e) => setNewCycle({ ...newCycle, dueAt: e.target.value })} />
              </Field>
            </div>
            <Field label={t('performance.template')}>
              <Select value={newCycle.templateId} onChange={(e) => setNewCycle({ ...newCycle, templateId: e.target.value })}>
                {templates.data?.items.map((x) => (
                  <option key={x._id} value={x._id}>
                    {x.nameAr} v{x.version}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setNewCycle(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" loading={createCycle.isPending}>
                {t('actions.save')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <GoalDialog open={goalDialog} onClose={() => setGoalDialog(false)} employees={lk.employees} />
    </>
  );
}

export { GOAL_STATES };
