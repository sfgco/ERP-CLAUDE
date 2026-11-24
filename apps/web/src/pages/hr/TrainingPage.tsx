import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TRAINING_KINDS, TRAINING_NEED_STATES } from '@eayni/shared';
import { get, patch, post, put } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { localInputToIso, riyadhToday } from '@/lib/dates';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea, cx } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { useHrLookups } from './_data';
import { riyals, trainingTone, type NeedRow, type TrainingPlanRow, type TrainingRow } from './_h3a';

type Tab = 'courses' | 'needs' | 'plan';

/** «التدريب والتطوير» [HR §3.8, §9.9]: courses with participation, departments' needs, the annual plan and its approval. */
export function TrainingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const lk = useHrLookups();
  const [tab, setTab] = useState<Tab>('courses');
  const year = Number(riyadhToday().slice(0, 4));
  const [planYear, setPlanYear] = useState(year);
  const courses = useQuery({ queryKey: ['training', 'courses'], queryFn: () => get<{ items: TrainingRow[] }>('/hr/training/trainings') });
  const needs = useQuery({ queryKey: ['training', 'needs', planYear], queryFn: () => get<{ items: NeedRow[] }>(`/hr/training/needs?year=${planYear}`) });
  const plans = useQuery({ queryKey: ['training', 'plans'], queryFn: () => get<{ items: TrainingPlanRow[] }>('/hr/training/plans') });
  const isHr = can('hr.training', 'edit');
  const canNeeds = can('hr.training', 'create');
  const [course, setCourse] = useState<{ title: string; providerName: string; kind: string; startAt: string; endAt: string; location: string; description: string; departmentIds: string[]; needIds: string[]; costRiyals: string } | null>(null);
  const [need, setNeed] = useState<{ departmentId: string; title: string; justification: string; priority: string; employeeIds: string[] } | null>(null);
  const [planEdit, setPlanEdit] = useState<TrainingPlanRow['items'] | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['training'] });
  const createCourse = useMutation({
    mutationFn: () => post<TrainingRow>('/hr/training/trainings', { title: course!.title, providerName: course!.providerName, kind: course!.kind, startAt: localInputToIso(course!.startAt), endAt: localInputToIso(course!.endAt), location: course!.location || undefined, description: course!.description || undefined, departmentIds: course!.departmentIds, needIds: course!.needIds, costHalalas: course!.costRiyals ? Math.round(Number(course!.costRiyals) * 100) : undefined }),
    onSuccess: (r) => {
      toast(t('training.courseCreated', { number: r.number }));
      setCourse(null);
      invalidate();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const createNeed = useMutation({
    mutationFn: () => post('/hr/training/needs', { ...need, year: planYear, source: 'department' }),
    onSuccess: () => {
      toast(t('training.needCreated'));
      setNeed(null);
      invalidate();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const setNeedState = useMutation({
    mutationFn: (v: { id: string; state: string }) => patch(`/hr/training/needs/${v.id}/state`, { state: v.state }),
    onSuccess: invalidate,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const savePlan = useMutation({
    mutationFn: () => put(`/hr/training/plans/${planYear}`, { items: planEdit!.map((i) => ({ ...i, estimatedCostHalalas: Number(i.estimatedCostHalalas) || 0 })) }),
    onSuccess: () => {
      toast(t('actions.save'));
      setPlanEdit(null);
      invalidate();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const planAct = useMutation({
    mutationFn: (v: { transition: string; reason?: string }) => post(`/hr/training/plans/${planYear}/transition`, v),
    onSuccess: invalidate,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const plan = plans.data?.items.find((p) => p.year === planYear);
  const tabs: { key: Tab; label: string }[] = [
    { key: 'courses', label: t('training.tabs.courses') },
    { key: 'needs', label: t('training.tabs.needs') },
    { key: 'plan', label: t('training.tabs.plan') },
  ];
  return (
    <>
      <PageHeader
        title={t('training.title')}
        subtitle={t('training.hint')}
        actions={
          <>
            {isHr && tab === 'courses' && <Button onClick={() => setCourse({ title: '', providerName: '', kind: 'internal', startAt: '', endAt: '', location: '', description: '', departmentIds: [], needIds: [], costRiyals: '' })}>{t('training.newCourse')}</Button>}
            {canNeeds && tab === 'needs' && <Button onClick={() => setNeed({ departmentId: lk.departments[0]?._id ?? '', title: '', justification: '', priority: 'medium', employeeIds: [] })}>{t('training.newNeed')}</Button>}
          </>
        }
      />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {tabs.map((x) => (
          <button key={x.key} role="tab" aria-selected={tab === x.key} onClick={() => setTab(x.key)} className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === x.key ? 'border-brand-700 text-brand-800' : 'border-transparent text-slate-600 hover:text-slate-900')}>
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'courses' && (
        <Card>
          {courses.isError ? (
            <QueryError error={courses.error} onRetry={() => courses.refetch()} />
          ) : courses.isLoading ? (
            <Spinner />
          ) : !courses.data?.items.length ? (
            <EmptyState title={t('training.noCourses')} />
          ) : (
            <Table head={[t('common.number'), t('training.course'), t('training.provider'), t('training.dates'), t('common.status'), t('training.participants'), t('training.cost')]}>
              {courses.data.items.map((c) => (
                <tr key={c._id}>
                  <Td className="tabular text-xs">
                    <Link to={`/hr/training/${c._id}`} className="text-brand-800 hover:underline">
                      {c.number}
                    </Link>
                  </Td>
                  <Td className="font-medium">
                    {c.title}
                    <div className="text-xs text-slate-500">{t(`training.kinds.${c.kind}`)}</div>
                  </Td>
                  <Td className="text-xs">{c.providerName}</Td>
                  <Td className="tabular text-xs">
                    {formatDate(c.startAt)} → {formatDate(c.endAt)}
                  </Td>
                  <Td>
                    <Badge tone={trainingTone[c.state]}>{t(`training.states.${c.state}`)}</Badge>
                  </Td>
                  <Td className="tabular text-xs">
                    {c.participants ?? 0} ({t('training.completedCount', { n: c.completed ?? 0 })})
                  </Td>
                  <Td className="tabular text-xs">{riyals(c.costHalalas)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'needs' && (
        <Card
          title={t('training.tabs.needs')}
          actions={
            <Field label={t('leave.year')}>
              <Input type="number" dir="ltr" className="w-24" value={planYear} onChange={(e) => setPlanYear(Number(e.target.value))} />
            </Field>
          }
        >
          {needs.isLoading ? (
            <Spinner />
          ) : !needs.data?.items.length ? (
            <EmptyState title={t('training.noNeeds')} hint={t('training.noNeedsHint')} />
          ) : (
            <Table head={[t('hr.department'), t('training.need'), t('training.source'), t('training.priority'), t('training.employeesCount'), t('common.status')]}>
              {needs.data.items.map((n) => (
                <tr key={n._id}>
                  <Td>{lk.deptName(n.departmentId)}</Td>
                  <Td className="font-medium">
                    {n.title}
                    {n.justification && <div className="text-xs text-slate-500">{n.justification}</div>}
                  </Td>
                  <Td className="text-xs">{t(`training.sources.${n.source}`)}</Td>
                  <Td className="text-xs">{t(`tasks.priorities.${n.priority}`, n.priority)}</Td>
                  <Td className="tabular text-xs">{n.employeeIds.length}</Td>
                  <Td>
                    {isHr ? (
                      <Select value={n.state} onChange={(e) => setNeedState.mutate({ id: n._id, state: e.target.value })} className="w-36">
                        {TRAINING_NEED_STATES.map((s) => (
                          <option key={s} value={s}>
                            {t(`training.needStates.${s}`)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge>{t(`training.needStates.${n.state}`)}</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'plan' && (
        <Card
          title={t('training.planTitle', { year: planYear })}
          actions={
            <>
              <Input type="number" dir="ltr" className="w-24" value={planYear} onChange={(e) => setPlanYear(Number(e.target.value))} />
              {plan && <Badge tone={plan.state === 'approved' ? 'green' : plan.state === 'submitted' ? 'brand' : 'slate'}>{t(`training.planStates.${plan.state}`)}</Badge>}
              {isHr && (!plan || plan.state === 'draft') && <Button variant="secondary" onClick={() => setPlanEdit(plan?.items ?? [{ title: '', departmentIds: [], quarter: 1, estimatedCostHalalas: 0, needIds: [] }])}>{plan ? t('actions.edit') : t('training.newPlan')}</Button>}
              {isHr && plan?.state === 'draft' && plan.items.length > 0 && <Button onClick={() => planAct.mutate({ transition: 'submit' })}>{t('training.planActions.submit')}</Button>}
              {can('hr.training', 'approve') && plan?.state === 'submitted' && (
                <>
                  <Button onClick={() => planAct.mutate({ transition: 'approve' })}>{t('training.planActions.approve')}</Button>
                  <Button variant="secondary" onClick={() => planAct.mutate({ transition: 'return', reason: t('training.planReturned') })}>
                    {t('training.planActions.return')}
                  </Button>
                </>
              )}
              {isHr && plan?.state === 'approved' && (
                <Button variant="secondary" onClick={() => planAct.mutate({ transition: 'close' })}>
                  {t('training.planActions.close')}
                </Button>
              )}
            </>
          }
        >
          {plans.isLoading ? (
            <Spinner />
          ) : !plan ? (
            <EmptyState title={t('training.noPlan')} />
          ) : (
            <>
              {plan.returnReason && plan.state === 'draft' && <Alert kind="warning">{t('training.planReturnedReason', { reason: plan.returnReason })}</Alert>}
              <Table head={[t('training.planItem'), t('training.departments'), t('training.quarter'), t('training.estimatedCost'), t('training.linkedNeeds')]}>
                {plan.items.map((i, idx) => (
                  <tr key={idx}>
                    <Td className="font-medium">{i.title}</Td>
                    <Td className="text-xs">{i.departmentIds.length ? i.departmentIds.map((d) => lk.deptName(d)).join(t('common.listSeparator')) : t('training.allDepartments')}</Td>
                    <Td className="tabular">Q{i.quarter}</Td>
                    <Td className="tabular text-xs">{riyals(i.estimatedCostHalalas)}</Td>
                    <Td className="tabular text-xs">{i.needIds.length}</Td>
                  </tr>
                ))}
              </Table>
              <p className="mt-2 text-xs text-slate-500">{t('training.planTotal', { total: riyals(plan.items.reduce((s, i) => s + (i.estimatedCostHalalas || 0), 0)) })}</p>
            </>
          )}
        </Card>
      )}

      <Dialog open={!!course} onClose={() => setCourse(null)} title={t('training.newCourse')}>
        {course && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              createCourse.mutate();
            }}
          >
            <Field label={t('training.course')} required>
              <Input value={course.title} onChange={(e) => setCourse({ ...course, title: e.target.value })} required />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('training.provider')} required>
                <Input value={course.providerName} onChange={(e) => setCourse({ ...course, providerName: e.target.value })} required />
              </Field>
              <Field label={t('shifts.kind')}>
                <Select value={course.kind} onChange={(e) => setCourse({ ...course, kind: e.target.value })}>
                  {TRAINING_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`training.kinds.${k}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('calendar.start')} required>
                <Input type="datetime-local" dir="ltr" value={course.startAt} onChange={(e) => setCourse({ ...course, startAt: e.target.value })} required />
              </Field>
              <Field label={t('calendar.end')} required>
                <Input type="datetime-local" dir="ltr" value={course.endAt} onChange={(e) => setCourse({ ...course, endAt: e.target.value })} required />
              </Field>
              <Field label={t('calendar.location')}>
                <Input value={course.location} onChange={(e) => setCourse({ ...course, location: e.target.value })} />
              </Field>
              <Field label={t('training.costRiyals')}>
                <Input type="number" dir="ltr" value={course.costRiyals} onChange={(e) => setCourse({ ...course, costRiyals: e.target.value })} />
              </Field>
            </div>
            <Field label={t('training.departments')}>
              <div className="flex flex-wrap gap-2 text-sm">
                {lk.departments.map((d) => (
                  <label key={d._id} className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1">
                    <input type="checkbox" checked={course.departmentIds.includes(d._id)} onChange={(e) => setCourse({ ...course, departmentIds: e.target.checked ? [...course.departmentIds, d._id] : course.departmentIds.filter((x) => x !== d._id) })} /> {d.nameAr}
                  </label>
                ))}
              </div>
            </Field>
            {needs.data?.items.length ? (
              <Field label={t('training.linkedNeeds')}>
                <div className="space-y-1 text-sm">
                  {needs.data.items.filter((n) => n.state !== 'done' && n.state !== 'rejected').map((n) => (
                    <label key={n._id} className="flex items-center gap-2">
                      <input type="checkbox" checked={course.needIds.includes(n._id)} onChange={(e) => setCourse({ ...course, needIds: e.target.checked ? [...course.needIds, n._id] : course.needIds.filter((x) => x !== n._id) })} /> {n.title} <span className="text-xs text-slate-500">({lk.deptName(n.departmentId)})</span>
                    </label>
                  ))}
                </div>
              </Field>
            ) : null}
            <Field label={t('hr.notes')}>
              <Textarea rows={2} value={course.description} onChange={(e) => setCourse({ ...course, description: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setCourse(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" loading={createCourse.isPending} disabled={!course.title || !course.providerName || !course.startAt || !course.endAt}>
                {t('actions.save')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog open={!!need} onClose={() => setNeed(null)} title={t('training.newNeed')}>
        {need && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              createNeed.mutate();
            }}
          >
            <Field label={t('hr.department')} required>
              <Select value={need.departmentId} onChange={(e) => setNeed({ ...need, departmentId: e.target.value })} required>
                {lk.departments.map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.nameAr}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('training.need')} required>
              <Input value={need.title} onChange={(e) => setNeed({ ...need, title: e.target.value })} required />
            </Field>
            <Field label={t('training.justification')}>
              <Textarea rows={2} value={need.justification} onChange={(e) => setNeed({ ...need, justification: e.target.value })} />
            </Field>
            <Field label={t('training.priority')}>
              <Select value={need.priority} onChange={(e) => setNeed({ ...need, priority: e.target.value })}>
                {['low', 'medium', 'high'].map((p) => (
                  <option key={p} value={p}>
                    {t(`tasks.priorities.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('training.employeesCount')}>
              <div className="max-h-40 space-y-1 overflow-y-auto text-sm">
                {lk.employees.filter((e) => e.departmentId === need.departmentId).map((e) => (
                  <label key={e._id} className="flex items-center gap-2">
                    <input type="checkbox" checked={need.employeeIds.includes(e._id)} onChange={(ev) => setNeed({ ...need, employeeIds: ev.target.checked ? [...need.employeeIds, e._id] : need.employeeIds.filter((x) => x !== e._id) })} /> {e.fullNameAr}
                  </label>
                ))}
              </div>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setNeed(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" loading={createNeed.isPending} disabled={!need.title || !need.departmentId}>
                {t('actions.save')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog open={!!planEdit} onClose={() => setPlanEdit(null)} title={t('training.planTitle', { year: planYear })}>
        {planEdit && (
          <div className="space-y-3">
            {planEdit.map((item, i) => (
              <div key={i} className="grid grid-cols-[1fr_80px_120px_auto] items-end gap-2 rounded-lg border border-slate-100 p-2">
                <Field label={t('training.planItem')}>
                  <Input value={item.title} onChange={(e) => setPlanEdit(planEdit.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                </Field>
                <Field label={t('training.quarter')}>
                  <Select value={item.quarter} onChange={(e) => setPlanEdit(planEdit.map((x, j) => (j === i ? { ...x, quarter: Number(e.target.value) } : x)))}>
                    {[1, 2, 3, 4].map((q) => (
                      <option key={q} value={q}>
                        Q{q}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('training.estimatedCost')}>
                  <Input type="number" dir="ltr" value={item.estimatedCostHalalas / 100} onChange={(e) => setPlanEdit(planEdit.map((x, j) => (j === i ? { ...x, estimatedCostHalalas: Math.round(Number(e.target.value) * 100) } : x)))} />
                </Field>
                <button type="button" className="pb-2 text-xs text-red-700 hover:underline" onClick={() => setPlanEdit(planEdit.filter((_, j) => j !== i))}>
                  {t('actions.delete')}
                </button>
              </div>
            ))}
            <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setPlanEdit([...planEdit, { title: '', departmentIds: [], quarter: 1, estimatedCostHalalas: 0, needIds: [] }])}>
              {t('training.addItem')}
            </button>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPlanEdit(null)}>
                {t('actions.cancel')}
              </Button>
              <Button onClick={() => savePlan.mutate()} loading={savePlan.isPending} disabled={planEdit.some((i) => i.title.trim().length < 2)}>
                {t('actions.save')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
