import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DISCIPLINARY_STATES } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader } from '@/shared/files/FileUploader';
import { useHrLookups } from './_data';
import { disciplineTone, riyals, type DisciplinaryRow } from './_h3a';
import { useTeam } from '../tasks/_data';

interface Policy {
  ladder: { code: string; labelAr: string; order: number; payrollEffect: string; maxFineDaysPerMonth: number | null; maxSuspensionDays: number | null; articleAr?: string }[];
  appealDays: number;
  violationDiscoveryDays: number;
  provisional: boolean;
}

/** «الإنذارات والإجراءات الإدارية» [HR §3.7]: the ladder (provisional), the list by state, a new action by the direct manager or HR. */
export function DisciplinePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const lk = useHrLookups();
  const team = useTeam();
  const policy = useQuery({ queryKey: ['discipline', 'policy'], queryFn: () => get<Policy>('/hr/discipline/policy') });
  const [state, setState] = useState('');
  const q = useQuery({ queryKey: ['discipline', 'list', state], queryFn: () => get<{ items: DisciplinaryRow[] }>(`/hr/discipline${state ? `?state=${state}` : ''}`) });
  const [form, setForm] = useState<{ employeeId: string; kind: string; violationDate: string; description: string; fineDays: string; suspensionDays: string; evidence: { attachmentId: string; fileName: string }[] } | null>(null);
  const create = useMutation({
    mutationFn: () => post<DisciplinaryRow>('/hr/discipline', { employeeId: form!.employeeId, kind: form!.kind, violationDate: form!.violationDate, description: form!.description, fineDays: form!.fineDays ? Number(form!.fineDays) : undefined, suspensionDays: form!.suspensionDays ? Number(form!.suspensionDays) : undefined, evidenceAttachmentIds: form!.evidence.map((a) => a.attachmentId) }),
    onSuccess: (d) => {
      toast(t('discipline.created', { number: d.number }));
      setForm(null);
      qc.invalidateQueries({ queryKey: ['discipline'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const step = policy.data?.ladder.find((s) => s.code === form?.kind);
  const candidates = can('hr.discipline', 'edit') ? lk.employees : (team.data?.items ?? []).map((m) => ({ _id: m._id, fullNameAr: m.fullNameAr, employeeNumber: m.employeeNumber }));
  return (
    <>
      <PageHeader
        title={t('discipline.title')}
        subtitle={t('discipline.hint', { days: policy.data?.appealDays ?? 15, discovery: policy.data?.violationDiscoveryDays ?? 30 })}
        actions={can('hr.discipline', 'create') && <Button onClick={() => setForm({ employeeId: '', kind: policy.data?.ladder[0]?.code ?? '', violationDate: riyadhToday(), description: '', fineDays: '', suspensionDays: '', evidence: [] })}>{t('discipline.new')}</Button>}
      />
      {policy.data?.provisional && <Alert kind="warning">{t('discipline.provisional')}</Alert>}
      <Card className="mt-3" title={t('discipline.ladder')}>
        <ol className="flex flex-wrap gap-2 text-xs">
          {policy.data?.ladder.map((s) => (
            <li key={s.code} className="rounded-full border border-slate-200 px-2.5 py-1">
              {s.order}. {s.labelAr} {s.articleAr ? <span className="text-slate-400">({s.articleAr})</span> : null}
            </li>
          ))}
        </ol>
      </Card>
      <Card
        className="mt-3"
        actions={
          <Select value={state} onChange={(e) => setState(e.target.value)} className="w-56">
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            {DISCIPLINARY_STATES.map((s) => (
              <option key={s} value={s}>
                {t(`discipline.states.${s}`)}
              </option>
            ))}
          </Select>
        }
        title={t('discipline.list')}
      >
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <EmptyState title={t('discipline.none')} />
        ) : (
          <Table head={[t('common.number'), t('hr.employee'), t('discipline.kind'), t('discipline.violationDate'), t('common.status'), t('discipline.fine')]}>
            {q.data.items.map((d) => (
              <tr key={d._id}>
                <Td className="tabular text-xs">
                  <Link to={`/hr/discipline/${d._id}`} className="text-brand-800 hover:underline">
                    {d.number}
                  </Link>
                </Td>
                <Td className="font-medium">{d.employee?.fullNameAr ?? '—'}</Td>
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
      <Dialog open={!!form} onClose={() => setForm(null)} title={t('discipline.new')}>
        {form && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label={t('hr.employee')} required>
              <Select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required>
                <option value="">—</option>
                {[...candidates].sort((a, b) => a.fullNameAr.localeCompare(b.fullNameAr, 'ar')).map((e) => (
                  <option key={e._id} value={e._id}>
                    {e.fullNameAr} · {e.employeeNumber}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('discipline.kind')} required hint={step?.articleAr}>
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {policy.data?.ladder.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.order}. {s.labelAr}
                  </option>
                ))}
              </Select>
            </Field>
            {step?.payrollEffect === 'fine' && (
              <Field label={t('discipline.fineDays')} required hint={t('discipline.fineMax', { n: step.maxFineDaysPerMonth ?? 5 })}>
                <Input type="number" dir="ltr" min={0.5} step={0.5} max={step.maxFineDaysPerMonth ?? 31} value={form.fineDays} onChange={(e) => setForm({ ...form, fineDays: e.target.value })} required />
              </Field>
            )}
            {step?.payrollEffect === 'suspension' && (
              <Field label={t('discipline.suspensionDays')} required hint={t('discipline.suspensionMax', { n: step.maxSuspensionDays ?? 5 })}>
                <Input type="number" dir="ltr" min={1} max={step.maxSuspensionDays ?? 31} value={form.suspensionDays} onChange={(e) => setForm({ ...form, suspensionDays: e.target.value })} required />
              </Field>
            )}
            <Field label={t('discipline.violationDate')} required>
              <Input type="date" dir="ltr" value={form.violationDate} onChange={(e) => setForm({ ...form, violationDate: e.target.value })} required />
            </Field>
            <Field label={t('discipline.description')} required>
              <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required minLength={5} />
            </Field>
            <Field label={t('discipline.evidence')}>
              <FileUploader onUploaded={(a) => setForm({ ...form, evidence: [...form.evidence, a] })} />
              {form.evidence.map((a) => (
                <div key={a.attachmentId} className="text-xs text-slate-600">
                  {a.fileName}
                </div>
              ))}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending} disabled={!form.employeeId || !form.kind || form.description.trim().length < 5}>
                {t('discipline.saveDraft')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

interface Detail extends DisciplinaryRow {
  events: { _id: string; type: string; toState?: string; note?: string; actorEmail?: string; at: string }[];
  actions: string[];
}

/** One action [HR §3.7]: the description and evidence, the stage, the actions of the viewer (issuer, approver, HR, the employee). */
export function DisciplinaryActionPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { formatDate, formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['discipline', id], queryFn: () => get<Detail>(`/hr/discipline/${id}`) });
  const [dialog, setDialog] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const act = useMutation({
    mutationFn: (body: { transition: string; note?: string }) => post(`/hr/discipline/${id}/transition`, body),
    onSuccess: () => {
      toast(t('actions.save'));
      setDialog(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['discipline'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const d = q.data;
  const needsNote = (c: string) => ['reject', 'withdraw', 'appeal'].includes(c);
  return (
    <>
      <PageHeader
        title={`${d.kindLabelAr} — ${d.number}`}
        subtitle={`${d.employee?.fullNameAr ?? ''} · ${t('discipline.violationDate')} ${formatDate(d.violationDate)}`}
        actions={
          <>
            <Badge tone={disciplineTone[d.state]}>{t(`discipline.states.${d.state}`)}</Badge>
            <Link to="/hr/discipline" className="text-sm text-brand-700 hover:underline">
              {t('actions.back')}
            </Link>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <Card title={t('discipline.description')}>
            <p className="text-sm">{d.description}</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              {d.fineHalalas ? (
                <>
                  <dt className="text-slate-500">{t('discipline.fine')}</dt>
                  <dd className="tabular">
                    {riyals(d.fineHalalas)} ({t('payroll.days', { n: d.fineDays ?? 0 })})
                  </dd>
                </>
              ) : null}
              {d.suspensionDays ? (
                <>
                  <dt className="text-slate-500">{t('discipline.suspensionDays')}</dt>
                  <dd className="tabular">{d.suspensionDays}</dd>
                </>
              ) : null}
              {d.deliveredAt && (
                <>
                  <dt className="text-slate-500">{t('discipline.deliveredAt')}</dt>
                  <dd className="tabular">{formatDateTime(d.deliveredAt)}</dd>
                </>
              )}
              {d.appealDeadline && (
                <>
                  <dt className="text-slate-500">{t('discipline.appealDeadline')}</dt>
                  <dd className="tabular">{formatDate(d.appealDeadline)}</dd>
                </>
              )}
            </dl>
            {d.appeal?.note && (
              <Alert kind="info">
                <strong>{t('discipline.appealNote')}:</strong> {d.appeal.note}
                {d.appeal.outcome ? ` — ${t(`discipline.appealOutcome.${d.appeal.outcome}`, d.appeal.outcome)}${d.appeal.decisionNote ? `: ${d.appeal.decisionNote}` : ''}` : ''}
              </Alert>
            )}
            {d.employeeAck?.at && <p className="mt-2 text-xs text-emerald-700">{t('discipline.acknowledgedAt', { date: formatDateTime(d.employeeAck.at) })}</p>}
          </Card>
          {d.actions.length > 0 && (
            <Card title={t('requests.actions')}>
              <div className="flex flex-wrap gap-2">
                {d.actions.map((c) => (
                  <Button key={c} variant={c === 'reject' || c === 'withdraw' ? 'danger' : c === 'approve' || c === 'submit' || c === 'deliver' || c === 'uphold' ? 'primary' : 'secondary'} onClick={() => (needsNote(c) || c === 'uphold' ? setDialog(c) : act.mutate({ transition: c }))} loading={act.isPending}>
                    {t(`discipline.actions.${c}`)}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">{t('discipline.sodHint')}</p>
            </Card>
          )}
        </div>
        <Card title={t('requests.log')}>
          <ol className="relative space-y-3 border-s border-slate-200 ps-4 text-sm">
            {d.events.map((e) => (
              <li key={e._id} className="relative">
                <span className="absolute -start-[21px] top-1.5 size-2.5 rounded-full bg-brand-600" aria-hidden />
                <div className="font-medium">
                  {t(`discipline.events.${e.type}`, e.type)}
                  {e.toState && <span className="ms-2 text-xs text-slate-500">← {t(`discipline.states.${e.toState}`, e.toState)}</span>}
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
      <Dialog open={!!dialog} onClose={() => setDialog(null)} title={dialog ? t(`discipline.actions.${dialog}`) : ''}>
        <div className="space-y-3">
          <Field label={dialog && needsNote(dialog) ? t('requests.reasonRequired') : t('hr.notes')} required={!!dialog && needsNote(dialog)}>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('actions.cancel')}
            </Button>
            <Button onClick={() => dialog && act.mutate({ transition: dialog, note: note || undefined })} loading={act.isPending} disabled={!!dialog && needsNote(dialog) && note.trim().length < 3}>
              {dialog ? t(`discipline.actions.${dialog}`) : ''}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
