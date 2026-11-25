import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { APPLICANT_STAGES, APPLICANT_STAGE_NEXT, INTERVIEW_MODES, INTERVIEW_RECOMMENDATIONS, type ApplicantStage } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { localInputToIso } from '@/lib/dates';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea, cx } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader } from '@/shared/files/FileUploader';
import { PeoplePicker } from '@/shared/ui/PeoplePicker';
import { useHrLookups } from './_data';
import { applicantTone, interviewTone, offerTone, requisitionTone, riyals, type ApplicantRow, type InterviewRow, type RecruitmentPolicy, type RequisitionDetail } from './_h3b';

/** One requisition [HR §3.2]: approvals and posting, the applicants (Kanban or table), interviews on the calendar, offers. */
export function RequisitionPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate, formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const lk = useHrLookups();
  const q = useQuery({ queryKey: ['recruitment', 'requisition', id], queryFn: () => get<RequisitionDetail>(`/hr/recruitment/requisitions/${id}`) });
  const policy = useQuery({ queryKey: ['recruitment', 'policy'], queryFn: () => get<RecruitmentPolicy>('/hr/recruitment/policy') });
  const [dialog, setDialog] = useState<'return' | 'reject' | 'cancel' | 'post' | 'applicant' | 'import' | 'interview' | 'result' | 'offer' | 'stage' | null>(null);
  const [reason, setReason] = useState('');
  const [channels, setChannels] = useState<string[]>([]);
  const [closesAt, setClosesAt] = useState('');
  const [view, setView] = useState<'kanban' | 'table'>('kanban');
  const [applicant, setApplicant] = useState({ fullNameAr: '', phone: '', email: '', nationality: '', birthDate: '', identityNumber: '', source: '', qualificationAr: '', experienceYears: '', expectedSalary: '', cvAttachmentId: '' });
  const [csv, setCsv] = useState('');
  const [target, setTarget] = useState<ApplicantRow | null>(null);
  const [stage, setStage] = useState<ApplicantStage>('screened');
  const [rejection, setRejection] = useState('');
  const [note, setNote] = useState('');
  const [iv, setIv] = useState({ round: 1, scheduledAt: '', durationMinutes: 60, mode: 'in_person', location: '', panelUserIds: [] as string[] });
  const [resultOf, setResultOf] = useState<InterviewRow | null>(null);
  const [result, setResult] = useState<{ state: 'done' | 'no_show' | 'cancelled'; scores: Record<string, number>; recommendation: string; notes: string }>({ state: 'done', scores: {}, recommendation: 'proceed', notes: '' });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['recruitment'] });
  const fail = (e: unknown) => toast(errorMessage(e), 'error');
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => post(`/hr/recruitment/requisitions/${id}/transition`, body),
    onSuccess: () => {
      toast(t('actions.save'));
      setDialog(null);
      setReason('');
      invalidate();
    },
    onError: fail,
  });
  const addApplicant = useMutation({
    mutationFn: () =>
      post(`/hr/recruitment/requisitions/${id}/applicants`, {
        fullNameAr: applicant.fullNameAr,
        phone: applicant.phone,
        email: applicant.email || undefined,
        nationality: applicant.nationality,
        birthDate: applicant.birthDate || undefined,
        identityNumber: applicant.identityNumber || undefined,
        source: applicant.source || undefined,
        qualificationAr: applicant.qualificationAr || undefined,
        experienceYears: applicant.experienceYears ? Number(applicant.experienceYears) : undefined,
        expectedSalaryHalalas: applicant.expectedSalary ? Math.round(Number(applicant.expectedSalary) * 100) : undefined,
        cvAttachmentId: applicant.cvAttachmentId || undefined,
      }),
    onSuccess: () => {
      toast(t('actions.save'));
      setDialog(null);
      invalidate();
    },
    onError: fail,
  });
  const importCsv = useMutation({
    mutationFn: () => {
      const [head, ...lines] = csv.trim().split(/\r?\n/);
      const cols = head.split(',').map((c) => c.trim());
      const rows = lines.filter(Boolean).map((l) => {
        const vals = l.split(',').map((v) => v.trim());
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => {
          if (!vals[i]) return;
          row[c] = c === 'experienceYears' || c === 'expectedSalaryHalalas' ? Number(vals[i]) : vals[i];
        });
        return row;
      });
      return post<{ created: number; rejected: { row: number; error: string }[] }>(`/hr/recruitment/requisitions/${id}/applicants/import`, { rows });
    },
    onSuccess: (r) => {
      toast(t('recruitment.importResult', { created: r.created, rejected: r.rejected.length }), r.rejected.length ? 'error' : undefined);
      setDialog(null);
      setCsv('');
      invalidate();
    },
    onError: fail,
  });
  const move = useMutation({
    mutationFn: () => post(`/hr/recruitment/applicants/${target!._id}/stage`, { stage, rejectionReason: stage === 'rejected' ? rejection : undefined, note: note || undefined }),
    onSuccess: () => {
      setDialog(null);
      setNote('');
      invalidate();
    },
    onError: fail,
  });
  const schedule = useMutation({
    mutationFn: () => post(`/hr/recruitment/applicants/${target!._id}/interviews`, { ...iv, scheduledAt: localInputToIso(iv.scheduledAt), location: iv.location || undefined }),
    onSuccess: () => {
      toast(t('actions.save'));
      setDialog(null);
      invalidate();
    },
    onError: fail,
  });
  const record = useMutation({
    mutationFn: () => post(`/hr/recruitment/interviews/${resultOf!._id}/result`, { state: result.state, scores: Object.entries(result.scores).map(([criterion, value]) => ({ criterion, value })), recommendation: result.state === 'done' ? result.recommendation : undefined, notes: result.notes || undefined }),
    onSuccess: () => {
      toast(t('actions.save'));
      setDialog(null);
      invalidate();
    },
    onError: fail,
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const r = q.data;
  const has = (a: string) => r.actions.includes(a);
  const canEdit = can('hr.recruitment', 'edit');
  const byStage = new Map<ApplicantStage, ApplicantRow[]>(APPLICANT_STAGES.map((s) => [s, []]));
  for (const a of r.applicants) byStage.get(a.stage)?.push(a);
  const interviewsOf = (aid: string) => r.interviews.filter((x) => x.applicantId === aid);
  const card = (a: ApplicantRow) => (
    <div key={a._id} className="rounded-lg border border-slate-200 bg-white p-2 text-sm shadow-sm">
      <div className="font-medium">{a.fullNameAr}</div>
      <div className="text-xs text-slate-500">
        {a.nationality} · {a.qualificationAr ?? '—'} · {a.experienceYears ?? 0} {t('recruitment.experienceYears')}
      </div>
      {a.previousEmployeeId && <div className="mt-1 text-xs text-amber-700">{t('recruitment.previousEmployee')}</div>}
      {a.rejectionReason && <div className="mt-1 text-xs text-red-700">{policy.data?.rejectionReasons.find((x) => x.code === a.rejectionReason)?.labelAr ?? a.rejectionReason}</div>}
      {canEdit && APPLICANT_STAGE_NEXT[a.stage].length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            type="button"
            className="text-xs text-brand-700 underline"
            onClick={() => {
              setTarget(a);
              setStage(APPLICANT_STAGE_NEXT[a.stage][0]);
              setDialog('stage');
            }}
          >
            {t('recruitment.moveTo')}
          </button>
          {['shortlisted', 'interviewing', 'screened'].includes(a.stage) && (
            <button
              type="button"
              className="text-xs text-brand-700 underline"
              onClick={() => {
                setTarget(a);
                setIv({ ...iv, round: interviewsOf(a._id).length + 1 });
                setDialog('interview');
              }}
            >
              {t('recruitment.schedule')}
            </button>
          )}
          {['shortlisted', 'interviewing'].includes(a.stage) && can('hr.offers', 'create') && ['approved', 'posted'].includes(r.state) && (
            <Link to={`/hr/recruitment/offers/new?applicantId=${a._id}&requisitionId=${r._id}`} className="text-xs text-brand-700 underline">
              {t('recruitment.newOffer')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
  return (
    <>
      <PageHeader
        title={`${r.number} — ${r.titleAr}`}
        subtitle={`${r.departmentName ?? lk.deptName(r.departmentId)} · ${r.positionTitle ?? ''} · ${t('recruitment.headcount')} ${r.headcount} · ${t('recruitment.hired')} ${r.hiredCount}`}
        actions={
          <>
            <Badge tone={requisitionTone[r.state]}>{t(`recruitment.states.${r.state}`)}</Badge>
            <Link to="/hr/recruitment" className="text-sm text-brand-700 hover:underline">
              {t('actions.back')}
            </Link>
          </>
        }
      />
      {r.saudizationWarning && <Alert kind="warning">{r.saudizationWarning}</Alert>}
      {r.needsExecutive && <Alert kind="info">{t('recruitment.needsExecutive')}</Alert>}
      <div className="mt-2 flex flex-wrap gap-2">
        {has('submit') && <Button onClick={() => act.mutate({ transition: 'submit' })}>{t('recruitment.submit')}</Button>}
        {has('approve') && <Button onClick={() => act.mutate({ transition: 'approve' })}>{t('recruitment.approve')}</Button>}
        {has('return') && (
          <Button variant="secondary" onClick={() => setDialog('return')}>
            {t('recruitment.return')}
          </Button>
        )}
        {has('reject') && (
          <Button variant="danger" onClick={() => setDialog('reject')}>
            {t('recruitment.reject')}
          </Button>
        )}
        {has('post') && <Button onClick={() => setDialog('post')}>{t('recruitment.post')}</Button>}
        {has('close') && (
          <Button variant="secondary" onClick={() => act.mutate({ transition: 'close' })}>
            {t('recruitment.close')}
          </Button>
        )}
        {has('cancel') && (
          <Button variant="danger" onClick={() => setDialog('cancel')}>
            {t('recruitment.cancel')}
          </Button>
        )}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card title={t('requests.details')}>
          <dl className="text-sm">
            <Row label={t('recruitment.justification')} value={r.justification} />
            <Row label={t('recruitment.requirements')} value={r.requirements} />
            <Row label={t('recruitment.employmentType')} value={t(`hr.employmentTypes.${r.employmentType}`)} />
            <Row label={t('recruitment.contractType')} value={`${t(`hr.contractTypes.${r.contractType}`)}${r.durationMonths ? ` · ${r.durationMonths} ${t('hr.durationMonths')}` : ''}`} />
            {r.salaryRange && <Row label={t('recruitment.salaryRange')} value={`${riyals(r.salaryRange.minHalalas)} – ${riyals(r.salaryRange.maxHalalas)}`} />}
            <Row label={t('recruitment.neededBy')} value={r.neededBy ? formatDate(r.neededBy) : undefined} />
            {r.recruitmentCosts?.length > 0 && <Row label={t('recruitment.recruitmentCosts')} value={r.recruitmentCosts.map((c) => `${c.labelAr}: ${riyals(c.amountHalalas)}`).join(' · ')} />}
            {r.posting?.postedAt && <Row label={t('recruitment.postedAt')} value={`${formatDate(r.posting.postedAt)} — ${r.posting.channels.map((c) => policy.data?.postingChannels.find((x) => x.code === c)?.labelAr ?? c).join(' · ')}`} />}
          </dl>
        </Card>
        <Card title={t('recruitment.offers')} className="lg:col-span-2">
          {!r.offers.length ? (
            <EmptyState title={t('recruitment.noOffers')} />
          ) : (
            <Table head={[t('recruitment.offerNumber'), t('recruitment.applicant'), t('recruitment.startDate'), t('common.status')]}>
              {r.offers.map((o) => (
                <tr key={o._id}>
                  <Td className="tabular text-xs">
                    <Link to={`/hr/recruitment/offers/${o._id}`} className="text-brand-800 hover:underline">
                      {o.number}
                    </Link>
                  </Td>
                  <Td>{r.applicants.find((a) => a._id === o.applicantId)?.fullNameAr ?? '—'}</Td>
                  <Td className="tabular text-xs">{formatDate(o.startDate)}</Td>
                  <Td>
                    <Badge tone={offerTone[o.state]}>{t(`recruitment.offerStates.${o.state}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      <Card
        className="mt-3"
        title={t('recruitment.applicants')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setView(view === 'kanban' ? 'table' : 'kanban')}>
              {view === 'kanban' ? t('recruitment.table') : t('recruitment.kanban')}
            </Button>
            {canEdit && ['approved', 'posted'].includes(r.state) && (
              <>
                <Button variant="secondary" onClick={() => setDialog('import')}>
                  {t('recruitment.importCsv')}
                </Button>
                <Button onClick={() => setDialog('applicant')}>{t('recruitment.newApplicant')}</Button>
              </>
            )}
          </div>
        }
      >
        {!r.applicants.length ? (
          <EmptyState title={t('recruitment.noApplicants')} />
        ) : view === 'kanban' ? (
          <div className="grid gap-2 md:grid-cols-4 xl:grid-cols-8">
            {APPLICANT_STAGES.map((s) => (
              <div key={s} className="rounded-xl bg-slate-100 p-2">
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>{t(`recruitment.stages.${s}`)}</span>
                  <span className="tabular">{byStage.get(s)!.length}</span>
                </div>
                <div className="space-y-2">{byStage.get(s)!.map(card)}</div>
              </div>
            ))}
          </div>
        ) : (
          <Table head={[t('recruitment.applicantName'), t('recruitment.phone'), t('recruitment.nationality'), t('recruitment.qualification'), t('recruitment.experienceYears'), t('recruitment.stage'), t('recruitment.interviews')]}>
            {r.applicants.map((a) => (
              <tr key={a._id}>
                <Td>{a.fullNameAr}</Td>
                <Td dir="ltr" className="text-xs">
                  {a.phone}
                </Td>
                <Td>{a.nationality}</Td>
                <Td>{a.qualificationAr ?? '—'}</Td>
                <Td className="tabular">{a.experienceYears ?? '—'}</Td>
                <Td>
                  <Badge tone={applicantTone[a.stage]}>{t(`recruitment.stages.${a.stage}`)}</Badge>
                </Td>
                <Td className="text-xs">{interviewsOf(a._id).map((x) => `${x.round}: ${t(`recruitment.interviewStates.${x.state}`)}${x.totalScore ? ` (${x.totalScore})` : ''}`).join(' · ') || '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card className="mt-3" title={t('recruitment.interviews')}>
        {!r.interviews.length ? (
          <EmptyState title={t('recruitment.noInterviews')} />
        ) : (
          <Table head={[t('recruitment.applicant'), t('recruitment.round'), t('recruitment.scheduledAt'), t('recruitment.mode'), t('common.status'), t('recruitment.total'), t('recruitment.recommendation'), '']}>
            {r.interviews.map((x) => (
              <tr key={x._id}>
                <Td>{r.applicants.find((a) => a._id === x.applicantId)?.fullNameAr}</Td>
                <Td className="tabular">{x.round}</Td>
                <Td className="tabular text-xs">{formatDateTime(x.scheduledAt)}</Td>
                <Td>{t(`recruitment.modes.${x.mode}`)}</Td>
                <Td>
                  <Badge tone={interviewTone[x.state]}>{t(`recruitment.interviewStates.${x.state}`)}</Badge>
                </Td>
                <Td className="tabular">{x.totalScore ?? '—'}</Td>
                <Td>{x.recommendation ? t(`recruitment.recommendations.${x.recommendation}`) : '—'}</Td>
                <Td>
                  {x.state === 'scheduled' && (
                    <button
                      type="button"
                      className="text-xs text-brand-700 underline"
                      onClick={() => {
                        setResultOf(x);
                        setResult({ state: 'done', scores: {}, recommendation: 'proceed', notes: '' });
                        setDialog('result');
                      }}
                    >
                      {t('recruitment.recordResult')}
                    </button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card className="mt-3" title={t('requests.log')}>
        <ul className="space-y-1 text-xs text-slate-600">
          {r.stages.map((s) => (
            <li key={s._id}>
              {formatDateTime(s.at)} — {s.transition}: {s.fromState ?? '—'} → {s.toState} {s.actorEmail ? `(${s.actorEmail})` : ''} {s.reason ? `— ${s.reason}` : ''}
            </li>
          ))}
        </ul>
      </Card>

      <Dialog open={dialog === 'return' || dialog === 'reject' || dialog === 'cancel'} onClose={() => setDialog(null)} title={dialog ? t(`recruitment.${dialog}`) : ''}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ transition: dialog, reason });
          }}
        >
          <Field label={t('recruitment.reasonRequired')} required>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending}>
              {t('actions.save')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'post'} onClose={() => setDialog(null)} title={t('recruitment.post')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ transition: 'post', posting: { channels, closesAt: closesAt || undefined, externalRefs: [] } });
          }}
        >
          <Field label={t('recruitment.postingChannels')} required>
            <div className="flex flex-wrap gap-3">
              {(policy.data?.postingChannels ?? []).map((c) => (
                <label key={c.code} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={channels.includes(c.code)} onChange={(e) => setChannels(e.target.checked ? [...channels, c.code] : channels.filter((x) => x !== c.code))} /> {c.labelAr}
                </label>
              ))}
            </div>
          </Field>
          <Field label={t('recruitment.closesAt')}>
            <Input dir="ltr" type="date" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending} disabled={!channels.length}>
              {t('recruitment.post')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'applicant'} onClose={() => setDialog(null)} title={t('recruitment.newApplicant')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            addApplicant.mutate();
          }}
        >
          <Field label={t('recruitment.applicantName')} required>
            <Input value={applicant.fullNameAr} onChange={(e) => setApplicant({ ...applicant, fullNameAr: e.target.value })} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('recruitment.phone')} required>
              <Input dir="ltr" value={applicant.phone} onChange={(e) => setApplicant({ ...applicant, phone: e.target.value })} required />
            </Field>
            <Field label={t('recruitment.email')}>
              <Input dir="ltr" type="email" value={applicant.email} onChange={(e) => setApplicant({ ...applicant, email: e.target.value })} />
            </Field>
            <Field label={t('recruitment.nationality')} required>
              <Input value={applicant.nationality} onChange={(e) => setApplicant({ ...applicant, nationality: e.target.value })} required />
            </Field>
            <Field label={t('recruitment.birthDate')}>
              <Input dir="ltr" type="date" value={applicant.birthDate} onChange={(e) => setApplicant({ ...applicant, birthDate: e.target.value })} />
            </Field>
            <Field label={t('recruitment.identityNumber')}>
              <Input dir="ltr" value={applicant.identityNumber} onChange={(e) => setApplicant({ ...applicant, identityNumber: e.target.value })} />
            </Field>
            <Field label={t('recruitment.source')}>
              <Input value={applicant.source} onChange={(e) => setApplicant({ ...applicant, source: e.target.value })} />
            </Field>
            <Field label={t('recruitment.qualification')}>
              <Input value={applicant.qualificationAr} onChange={(e) => setApplicant({ ...applicant, qualificationAr: e.target.value })} />
            </Field>
            <Field label={t('recruitment.experienceYears')}>
              <Input dir="ltr" type="number" min={0} value={applicant.experienceYears} onChange={(e) => setApplicant({ ...applicant, experienceYears: e.target.value })} />
            </Field>
            <Field label={t('recruitment.expectedSalary')}>
              <Input dir="ltr" type="number" min={0} value={applicant.expectedSalary} onChange={(e) => setApplicant({ ...applicant, expectedSalary: e.target.value })} />
            </Field>
          </div>
          <Field label={t('recruitment.cv')}>
            <FileUploader onUploaded={(a) => setApplicant({ ...applicant, cvAttachmentId: a.attachmentId })} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={addApplicant.isPending}>
              {t('actions.save')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'import'} onClose={() => setDialog(null)} title={t('recruitment.importCsv')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            importCsv.mutate();
          }}
        >
          <Field label={t('recruitment.importCsv')} hint={t('recruitment.importHint')}>
            <Textarea dir="ltr" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={t('recruitment.importPlaceholder')} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={importCsv.isPending} disabled={!csv.trim()}>
              {t('recruitment.importCsv')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'stage'} onClose={() => setDialog(null)} title={`${t('recruitment.moveTo')} — ${target?.fullNameAr ?? ''}`}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            move.mutate();
          }}
        >
          <Field label={t('recruitment.stage')}>
            <Select value={stage} onChange={(e) => setStage(e.target.value as ApplicantStage)}>
              {(target ? APPLICANT_STAGE_NEXT[target.stage] : []).map((s) => (
                <option key={s} value={s}>
                  {t(`recruitment.stages.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
          {stage === 'rejected' && (
            <Field label={t('recruitment.rejectionReason')} required>
              <Select value={rejection} onChange={(e) => setRejection(e.target.value)} required>
                <option value="">—</option>
                {(policy.data?.rejectionReasons ?? []).map((x) => (
                  <option key={x.code} value={x.code}>
                    {x.labelAr}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('recruitment.note')}>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={move.isPending}>
              {t('actions.save')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'interview'} onClose={() => setDialog(null)} title={`${t('recruitment.schedule')} — ${target?.fullNameAr ?? ''}`}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            schedule.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('recruitment.round')}>
              <Input type="number" min={1} max={5} value={iv.round} onChange={(e) => setIv({ ...iv, round: Number(e.target.value) })} />
            </Field>
            <Field label={t('recruitment.scheduledAt')} required>
              <Input dir="ltr" type="datetime-local" value={iv.scheduledAt} onChange={(e) => setIv({ ...iv, scheduledAt: e.target.value })} required />
            </Field>
            <Field label={t('recruitment.duration')}>
              <Input type="number" min={15} step={15} value={iv.durationMinutes} onChange={(e) => setIv({ ...iv, durationMinutes: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label={t('recruitment.mode')}>
            <Select value={iv.mode} onChange={(e) => setIv({ ...iv, mode: e.target.value })}>
              {INTERVIEW_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`recruitment.modes.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('recruitment.location')}>
            <Input value={iv.location} onChange={(e) => setIv({ ...iv, location: e.target.value })} />
          </Field>
          <Field label={t('recruitment.panel')} required>
            <PeoplePicker value={iv.panelUserIds} onChange={(ids) => setIv({ ...iv, panelUserIds: ids })} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={schedule.isPending} disabled={!iv.panelUserIds.length}>
              {t('actions.save')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'result'} onClose={() => setDialog(null)} title={t('recruitment.recordResult')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            record.mutate();
          }}
        >
          <Field label={t('recruitment.result')}>
            <Select value={result.state} onChange={(e) => setResult({ ...result, state: e.target.value as 'done' | 'no_show' | 'cancelled' })}>
              {(['done', 'no_show', 'cancelled'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`recruitment.interviewStates.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
          {result.state === 'done' && policy.data && (
            <>
              <Field label={t('recruitment.scores', { min: policy.data.scoreMin, max: policy.data.scoreMax })}>
                <div className="grid gap-2 sm:grid-cols-2">
                  {policy.data.interviewCriteria.map((c) => (
                    <label key={c.code} className={cx('flex items-center justify-between gap-2 rounded border border-slate-200 p-2 text-sm')}>
                      <span>{c.labelAr}</span>
                      <Input dir="ltr" type="number" min={policy.data!.scoreMin} max={policy.data!.scoreMax} className="w-20" value={result.scores[c.code] ?? ''} onChange={(e) => setResult({ ...result, scores: { ...result.scores, [c.code]: Number(e.target.value) } })} />
                    </label>
                  ))}
                </div>
              </Field>
              <Field label={t('recruitment.recommendation')}>
                <Select value={result.recommendation} onChange={(e) => setResult({ ...result, recommendation: e.target.value })}>
                  {INTERVIEW_RECOMMENDATIONS.map((x) => (
                    <option key={x} value={x}>
                      {t(`recruitment.recommendations.${x}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <Field label={t('hr.notes')}>
            <Textarea rows={2} value={result.notes} onChange={(e) => setResult({ ...result, notes: e.target.value })} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={record.isPending}>
              {t('actions.save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 py-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-900">{value || '—'}</dd>
    </div>
  );
}
