import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PARTICIPANT_STATUSES, TRAINING_STATES } from '@eayni/shared';
import { get, patch, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { downloadAttachment } from '@/shared/files/FileUploader';
import { useHrLookups } from './_data';
import { participantTone, riyals, trainingTone, type ParticipantRow, type TrainingRow } from './_h3a';
import { useTeam } from '../tasks/_data';

type Detail = Omit<TrainingRow, 'participants'> & { participants: ParticipantRow[] };

/** One course [HR §3.8.4–3.8.7]: dates, provider, state; nominated participants with their status, result and certificate. */
export function TrainingCoursePage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const lk = useHrLookups();
  const team = useTeam();
  const q = useQuery({ queryKey: ['training', 'course', id], queryFn: () => get<Detail>(`/hr/training/trainings/${id}`) });
  const [nominate, setNominate] = useState<string[] | null>(null);
  const [search, setSearch] = useState('');
  const isHr = can('hr.training', 'edit');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['training'] });
  const nominateMut = useMutation({
    mutationFn: () => post(`/hr/training/trainings/${id}/participants`, { employeeIds: nominate }),
    onSuccess: () => {
      toast(t('training.nominated'));
      setNominate(null);
      invalidate();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const updatePart = useMutation({
    mutationFn: (v: { id: string; status?: string; result?: string }) => patch(`/hr/training/participants/${v.id}`, { status: v.status, result: v.result }),
    onSuccess: invalidate,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const setState = useMutation({
    mutationFn: (state: string) => patch(`/hr/training/trainings/${id}`, { state }),
    onSuccess: invalidate,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const c = q.data;
  const candidates = (isHr ? lk.employees : (team.data?.items ?? []).map((m) => ({ _id: m._id, fullNameAr: m.fullNameAr, employeeNumber: m.employeeNumber, departmentId: m.departmentId })))
    .filter((e) => !c.participants.some((p) => p.employeeId === e._id))
    .filter((e) => !search || e.fullNameAr.includes(search) || e.employeeNumber.includes(search));
  return (
    <>
      <PageHeader
        title={`${c.title} — ${c.number}`}
        subtitle={`${c.providerName ?? ''} · ${t(`training.kinds.${c.kind}`)} · ${formatDateTime(c.startAt)} → ${formatDateTime(c.endAt)}${c.location ? ` · ${c.location}` : ''}`}
        actions={
          <>
            <Badge tone={trainingTone[c.state]}>{t(`training.states.${c.state}`)}</Badge>
            {isHr && (
              <Select value={c.state} onChange={(e) => setState.mutate(e.target.value)} className="w-40">
                {TRAINING_STATES.map((s) => (
                  <option key={s} value={s}>
                    {t(`training.states.${s}`)}
                  </option>
                ))}
              </Select>
            )}
            <Link to="/hr/training" className="text-sm text-brand-700 hover:underline">
              {t('actions.back')}
            </Link>
          </>
        }
      />
      {c.description && <p className="mb-3 text-sm text-slate-700">{c.description}</p>}
      <p className="mb-3 text-xs text-slate-500">
        {t('training.cost')}: {riyals(c.costHalalas)} · {t('training.departments')}: {c.departmentIds.length ? c.departmentIds.map((d) => lk.deptName(d)).join(t('common.listSeparator')) : t('training.allDepartments')}
      </p>
      <Card title={t('training.participants')} actions={can('hr.training', 'view') && !['completed', 'cancelled'].includes(c.state) && (isHr || (team.data?.items.length ?? 0) > 0) && <Button onClick={() => setNominate([])}>{t('training.nominate')}</Button>}>
        {!c.participants.length ? (
          <EmptyState title={t('training.noParticipants')} />
        ) : (
          <Table head={[t('hr.employee'), t('hr.department'), t('common.status'), t('training.result'), t('training.certificate')]}>
            {c.participants.map((p) => (
              <tr key={p._id}>
                <Td>
                  <Link to={`/hr/employees/${p.employeeId}`} className="font-medium text-brand-800 hover:underline">
                    {p.employee?.fullNameAr ?? '—'}
                  </Link>
                  <div className="text-xs text-slate-500">{p.employee?.employeeNumber}</div>
                </Td>
                <Td className="text-xs">{lk.deptName(p.employee?.departmentId)}</Td>
                <Td>
                  {isHr ? (
                    <Select value={p.status} onChange={(e) => updatePart.mutate({ id: p._id, status: e.target.value })} className="w-36">
                      {PARTICIPANT_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`training.participantStatuses.${s}`)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge tone={participantTone[p.status]}>{t(`training.participantStatuses.${p.status}`)}</Badge>
                  )}
                </Td>
                <Td className="text-xs">
                  {isHr ? <Input defaultValue={p.result ?? ''} onBlur={(e) => e.target.value !== (p.result ?? '') && updatePart.mutate({ id: p._id, result: e.target.value })} /> : p.result ?? '—'}
                </Td>
                <Td>
                  {p.certificateAttachmentId ? (
                    <Button variant="secondary" onClick={() => downloadAttachment(p.certificateAttachmentId!)}>
                      {t('training.openCertificate')}
                    </Button>
                  ) : (
                    <span className="text-xs text-slate-400">{t('training.noCertificate')}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={!!nominate} onClose={() => setNominate(null)} title={t('training.nominate')}>
        {nominate && (
          <div className="space-y-3">
            <Field label={t('actions.search')}>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} />
            </Field>
            <div className="max-h-72 space-y-1 overflow-y-auto text-sm">
              {candidates.map((e) => (
                <label key={e._id} className="flex items-center gap-2">
                  <input type="checkbox" checked={nominate.includes(e._id)} onChange={(ev) => setNominate(ev.target.checked ? [...nominate, e._id] : nominate.filter((x) => x !== e._id))} /> {e.fullNameAr} <span className="text-xs text-slate-500">{e.employeeNumber}</span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setNominate(null)}>
                {t('actions.cancel')}
              </Button>
              <Button onClick={() => nominateMut.mutate()} loading={nominateMut.isPending} disabled={!nominate.length}>
                {t('training.nominateCount', { n: nominate.length })}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
