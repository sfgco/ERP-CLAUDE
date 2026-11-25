import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SETTLEMENT_LINE_CODES } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { riyadhToday } from '@/lib/dates';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea, cx } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { offboardingTone, riyals, settlementTone, type EosPolicyView, type OffboardingDetail } from './_h3b';

/**
 * One end-of-service record [HR §3.10]: the legal facts (reason, notice, warnings), the decision, then the four parallel
 * steps (settlement with the art. 84 breakdown, custody, IT, exit interview), the service certificate, the government
 * references and the retention line. Amounts are visible to HR, Finance and the employee only.
 */
export function OffboardingDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate, formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['offboarding', 'detail', id], queryFn: () => get<OffboardingDetail>(`/hr/offboarding/${id}`) });
  const policy = useQuery({ queryKey: ['offboarding', 'policy'], queryFn: () => get<EosPolicyView>('/hr/offboarding/policy') });
  const [dialog, setDialog] = useState<'reject' | 'cancel' | 'postpone' | 'approve' | 'line' | 'custody' | 'interview' | 'gov' | null>(null);
  const [reason, setReason] = useState('');
  const [postponedUntil, setPostponedUntil] = useState('');
  const [lastDay, setLastDay] = useState('');
  const [line, setLine] = useState({ code: 'other_earning', kind: 'earning', amount: '', reason: '' });
  const [custody, setCustody] = useState({ custodyId: '', returnedAt: riyadhToday(), condition: '', notReturned: false, charge: '' });
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const [interviewedAt, setInterviewedAt] = useState(riyadhToday());
  const [declined, setDeclined] = useState(false);
  const [gov, setGov] = useState({ gosiExitRef: '', gosiExitAt: '', qiwaExitRef: '', qiwaExitAt: '', finalExitRef: '' });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['offboarding'] });
  const onErr = (e: unknown) => toast(errorMessage(e), 'error');
  const done = () => {
    toast(t('actions.save'));
    setDialog(null);
    setReason('');
    invalidate();
  };
  const act = useMutation({ mutationFn: (body: Record<string, unknown>) => post(`/hr/offboarding/${id}/transition`, body), onSuccess: done, onError: onErr });
  const settle = useMutation({ mutationFn: (body: Record<string, unknown>) => post(`/hr/offboarding/${id}/settlement`, body), onSuccess: done, onError: onErr });
  const returnCustody = useMutation({ mutationFn: () => post(`/hr/offboarding/${id}/custody`, { custodyId: custody.custodyId, returnedAt: custody.returnedAt, condition: custody.condition || undefined, notReturned: custody.notReturned, chargeHalalas: custody.notReturned ? Math.round(Number(custody.charge || 0) * 100) : undefined }), onSuccess: done, onError: onErr });
  const interview = useMutation({ mutationFn: () => post(`/hr/offboarding/${id}/exit-interview`, { answers: Object.entries(answers).map(([key, value]) => ({ key, value })), interviewedAt, declined }), onSuccess: done, onError: onErr });
  const certificate = useMutation({ mutationFn: () => post(`/hr/offboarding/${id}/certificate`), onSuccess: done, onError: onErr });
  const govExit = useMutation({ mutationFn: () => post(`/hr/offboarding/${id}/gov-exit`, Object.fromEntries(Object.entries(gov).filter(([, v]) => v))), onSuccess: done, onError: onErr });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const o = q.data;
  const has = (a: string) => o.actions.includes(a);
  const canEdit = can('hr.offboarding', 'edit');
  const s = o.settlement;
  const stepBadge = (k: string) => <Badge tone={o.steps?.[k]?.done ? 'green' : 'slate'}>{o.steps?.[k]?.done ? t('offboarding.stepDone') : t('offboarding.stepPending')}</Badge>;
  const openCustody = o.custody.filter((c) => !c.returnedAt && !o.custodyChecklist.find((x) => String(x.custodyId) === String(c._id) && x.notReturned));
  return (
    <>
      <PageHeader
        title={`${o.number} — ${o.employee?.fullNameAr ?? ''}`}
        subtitle={`${o.reasonLabel} · ${t(`offboarding.initiatedBy.${o.initiatedBy}`)} · ${t('offboarding.lastWorkingDay')} ${formatDate(o.lastWorkingDay)}`}
        actions={
          <>
            <Badge tone={offboardingTone[o.state]}>{t(`offboarding.states.${o.state}`)}</Badge>
            <Link to="/hr/offboarding" className="text-sm text-brand-700 hover:underline">
              {t('actions.back')}
            </Link>
          </>
        }
      />
      {o.legalWarnings.map((w) => (
        <Alert key={w} kind="warning">
          {w}
        </Alert>
      ))}
      {o.notice && <p className="mt-1 text-xs text-slate-600">{t('offboarding.noticeLine', { required: o.notice.requiredDays, given: o.notice.givenDays, shortfall: o.notice.shortfallDays })} — {o.notice.basisAr}</p>}
      {o.resignation?.submittedAt && (
        <Alert kind="info">
          {o.resignation.withdrawDeadline && !o.resignation.acceptedAt && `${t('offboarding.me.withdrawUntil', { date: formatDate(o.resignation.withdrawDeadline) })} · `}
          {o.resignation.deemedAcceptedAt && !o.resignation.acceptedAt && !o.resignation.postponedUntil && t('offboarding.me.deemedAt', { date: formatDate(o.resignation.deemedAcceptedAt) })}
          {o.resignation.postponedUntil && !o.resignation.acceptedAt && t('offboarding.me.postponedUntil', { date: formatDate(o.resignation.postponedUntil), reason: o.resignation.postponeReason ?? '' })}
          {o.resignation.acceptedAt && t('offboarding.me.acceptedAt', { date: formatDate(o.resignation.acceptedAt), kind: t(`offboarding.me.acceptanceKinds.${o.resignation.acceptanceKind ?? 'explicit'}`) })}
        </Alert>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {has('submit') && <Button onClick={() => act.mutate({ transition: 'submit' })}>{t('requests.submit')}</Button>}
        {has('approve') && <Button onClick={() => setDialog('approve')}>{t('offboarding.approve')}</Button>}
        {has('accept_resignation') && <Button onClick={() => act.mutate({ transition: 'accept_resignation' })}>{t('offboarding.acceptResignation')}</Button>}
        {has('postpone_resignation') && (
          <Button variant="secondary" onClick={() => setDialog('postpone')}>
            {t('offboarding.postponeResignation')}
          </Button>
        )}
        {has('reject') && (
          <Button variant="danger" onClick={() => setDialog('reject')}>
            {t('offboarding.reject')}
          </Button>
        )}
        {has('cancel') && (
          <Button variant="danger" onClick={() => setDialog('cancel')}>
            {t('offboarding.cancel')}
          </Button>
        )}
        {has('complete') && <Button onClick={() => act.mutate({ transition: 'complete' })}>{t('offboarding.complete')}</Button>}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card title={t('requests.details')}>
          <dl className="text-sm">
            <Row label={t('offboarding.employee')} value={o.employee ? <Link to={`/hr/employees/${o.employeeId}`} className="text-brand-700 underline">{o.employee.fullNameAr} — {o.employee.employeeNumber}</Link> : undefined} />
            <Row label={t('offboarding.reason')} value={o.reasonLabel} />
            {o.art80Case && <Row label={t('offboarding.art80Case')} value={policy.data?.art80Cases.find((c) => c.code === o.art80Case)?.labelAr ?? o.art80Case} />}
            {o.hearing && <Row label={t('offboarding.hearing')} value={`${o.hearing.heldAt} — ${o.hearing.summary}${o.hearing.employeeDeclined ? ` (${t('offboarding.hearingDeclined')})` : ''}`} />}
            {o.art81Case && <Row label={t('offboarding.art81Case')} value={policy.data?.art81Cases.find((c) => c.code === o.art81Case)?.labelAr ?? o.art81Case} />}
            {o.art87 && <Row label={t('offboarding.art87Label')} value={`${o.art87.event === 'marriage' ? t('offboarding.me.marriage') : t('offboarding.me.birth')} ${o.art87.eventDate} — ${o.art87.source}`} />}
            <Row label={t('offboarding.noticeDate')} value={o.noticeDate ? formatDate(o.noticeDate) : undefined} />
            <Row label={t('offboarding.lastWorkingDay')} value={formatDate(o.lastWorkingDay)} />
            <Row label={t('offboarding.details')} value={o.details} />
            {o.contract && <Row label={t('hr.tabs.contracts')} value={`${o.contract.number} · ${t(`hr.contractTypes.${o.contract.type}`)} · ${formatDate(o.contract.originalStartDate ?? o.contract.startDate)}${o.contract.endDate ? ` → ${formatDate(o.contract.endDate)}` : ''}`} />}
            {o.contract?.nonCompete && <Row label={t('recruitment.nonCompete')} value={`${o.contract.nonCompete.months} ${t('hr.durationMonths')} — ${o.contract.nonCompete.scopeAr}`} />}
            {o.retention?.keepUntil && <Row label={t('hr.tabs.documents')} value={t('offboarding.retention', { date: formatDate(o.retention.keepUntil) })} />}
          </dl>
        </Card>
        <Card title={t('offboarding.steps')}>
          <ul className="space-y-2 text-sm">
            {(['settlement', 'custody_return', 'it_closure', 'exit_interview'] as const).map((k) => (
              <li key={k} className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2">
                <span>{t(`offboarding.step.${k}`)}</span>
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  {o.steps?.[k]?.at && formatDateTime(o.steps[k].at!)}
                  {stepBadge(k)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {canEdit && ['approved', 'completed'].includes(o.state) && !o.experienceCertificate?.number && (
              <Button variant="secondary" onClick={() => certificate.mutate()} loading={certificate.isPending}>
                {t('offboarding.issueCertificate')}
              </Button>
            )}
            {o.experienceCertificate?.number && (
              <a className="text-sm text-brand-700 underline" href={`/api/v1/files/${o.experienceCertificate.attachmentId}/download`} target="_blank" rel="noreferrer">
                {t('offboarding.certificateIssued', { number: o.experienceCertificate.number })}
              </a>
            )}
            {canEdit && ['approved', 'completed'].includes(o.state) && (
              <Button variant="secondary" onClick={() => setDialog('gov')}>
                {t('offboarding.gov')}
              </Button>
            )}
          </div>
          {o.gov?.gosiExitRef || o.gov?.qiwaExitRef ? <p className="mt-2 text-xs text-slate-600">{t('offboarding.gosiExitRef')}: {o.gov.gosiExitRef ?? '—'} ({o.gov.gosiExitAt ?? '—'}) · {t('offboarding.qiwaExitRef')}: {o.gov.qiwaExitRef ?? '—'} ({o.gov.qiwaExitAt ?? '—'})</p> : null}
        </Card>
      </div>

      {s && (
        <Card
          className="mt-3"
          title={
            <span className="flex items-center gap-2">
              {t('offboarding.settlement')} <Badge tone={settlementTone[s.state]}>{t(`offboarding.settlementStates.${s.state}`)}</Badge>
            </span>
          }
          actions={
            canEdit && o.state === 'approved' ? (
              <div className="flex flex-wrap gap-2">
                {['pending', 'computed'].includes(s.state) && (
                  <Button variant="secondary" onClick={() => settle.mutate({ action: 'compute' })} loading={settle.isPending}>
                    {s.state === 'pending' ? t('offboarding.compute') : t('offboarding.recompute')}
                  </Button>
                )}
                {s.state === 'computed' && (
                  <Button variant="secondary" onClick={() => setDialog('line')}>
                    {t('offboarding.editLine')}
                  </Button>
                )}
                {s.state === 'computed' && <Button onClick={() => settle.mutate({ action: 'approve' })}>{t('offboarding.approveSettlement')}</Button>}
              </div>
            ) : undefined
          }
        >
          {s.flags?.map((f) => (
            <Alert key={f} kind="warning">
              {t(`offboarding.flags.${f}`, f)}
            </Alert>
          ))}
          {s.dueAt && (
            <p className="text-xs text-slate-600">
              {t('offboarding.dueAt')}: {formatDate(s.dueAt)}
              {s.finance?.paidAt && ` · ${t('offboarding.paidAt')}: ${formatDate(s.finance.paidAt)} ${s.finance.paymentRef ? `(${s.finance.paymentRef})` : ''}`}
            </p>
          )}
          {s.awardWage && (
            <p className="mt-1 text-xs text-slate-600">
              {t('offboarding.awardWage')}: {t('offboarding.awardWageLine', { basic: riyals(s.awardWage.basicHalalas), allowances: riyals(s.awardWage.allowancesHalalas), commissions: riyals(s.awardWage.commissionsHalalas), total: riyals(s.awardWage.totalHalalas) })}
              {s.awardWage.commissionsExcluded && ` — ${t('offboarding.commissionsExcluded', { ref: s.awardWage.clauseRef ?? '' })}`}
              {' · '}
              {t('offboarding.service')}: {t('offboarding.serviceLine', { days: s.serviceDays ?? 0, years: s.serviceYears ?? 0 })} · {t('offboarding.awardFraction')}: {((s.awardFraction ?? 0) / 100).toFixed(2)}%
            </p>
          )}
          {s.lines?.length > 0 && (
            <Table head={[t('offboarding.lineCode'), t('offboarding.lineKind'), t('offboarding.lineAmount'), t('offboarding.basis'), t('offboarding.article')]}>
              {s.lines.map((l, i) => (
                <tr key={i} className={cx(!l.computed && 'bg-amber-50')}>
                  <Td>
                    {l.labelAr}
                    {!l.computed && <span className="ms-1 text-xs text-amber-700">({t('offboarding.edited')}: {l.editReason})</span>}
                  </Td>
                  <Td>{t(`offboarding.${l.kind}`)}</Td>
                  <Td className={cx('tabular', l.kind === 'deduction' && 'text-red-700')}>{riyals(l.amountHalalas)}</Td>
                  <Td className="text-xs text-slate-500">{l.basisAr ?? '—'}</Td>
                  <Td className="text-xs text-slate-500">{l.articleAr ?? '—'}</Td>
                </tr>
              ))}
              <tr className="font-semibold">
                <Td>{t('offboarding.net')}</Td>
                <Td />
                <Td className="tabular">{riyals(s.netHalalas)}</Td>
                <Td className="text-xs text-slate-500">
                  {t('offboarding.earnings')} {riyals(s.earningsHalalas)} − {t('offboarding.deductions')} {riyals(s.deductionsHalalas)}
                </Td>
                <Td />
              </tr>
            </Table>
          )}
        </Card>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card title={t('offboarding.custody')} actions={canEdit && o.state === 'approved' && openCustody.length > 0 ? <Button variant="secondary" onClick={() => { setCustody({ ...custody, custodyId: openCustody[0]._id }); setDialog('custody'); }}>{t('offboarding.returnItem')}</Button> : undefined}>
          {!o.custody.length ? (
            <p className="text-sm text-slate-500">{t('offboarding.noCustody')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {o.custody.map((c) => {
                const row = o.custodyChecklist.find((x) => String(x.custodyId) === String(c._id));
                return (
                  <li key={c._id} className="flex items-center justify-between gap-2">
                    <span>
                      {c.itemName} {c.assetTag ? `(${c.assetTag})` : ''}
                    </span>
                    <span className="text-xs text-slate-500">{row?.notReturned ? `${t('offboarding.notReturned')} — ${riyals(row.chargeHalalas)}` : c.returnedAt ? `${t('offboarding.returned')} ${formatDate(c.returnedAt)} ${c.condition ?? ''}` : t('offboarding.stepPending')}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title={t('offboarding.it')}>
          <dl className="text-sm">
            <Row label={t('offboarding.itTask')} value={o.it?.taskId ? <Link to={`/tasks/${o.it.taskId}`} className="text-brand-700 underline">{t('offboarding.itTask')}</Link> : undefined} />
            <Row label={t('offboarding.itRequestedAt')} value={o.it?.requestedAt ? formatDateTime(o.it.requestedAt) : undefined} />
            <Row label={t('offboarding.itConfirmedAt')} value={o.it?.confirmedAt ? formatDateTime(o.it.confirmedAt) : undefined} />
            <Row label={t('offboarding.itNote')} value={o.it?.note} />
          </dl>
        </Card>
        <Card title={t('offboarding.exitInterview')} actions={canEdit && o.state === 'approved' && !o.steps?.exit_interview?.done ? <Button variant="secondary" onClick={() => setDialog('interview')}>{t('offboarding.exitInterview')}</Button> : undefined}>
          {o.exitInterview?.at ? (
            <dl className="text-sm">
              <Row label={t('offboarding.interviewedAt')} value={`${o.exitInterview.at}${o.exitInterview.declined ? ` — ${t('offboarding.declined')}` : ''}`} />
              {o.exitInterview.answers.map((a) => (
                <Row key={a.key} label={policy.data?.exitInterviewTemplate.questions.find((qq) => qq.key === a.key)?.labelAr ?? a.key} value={typeof a.value === 'boolean' ? (a.value ? t('offboarding.yes') : t('offboarding.no')) : String(a.value)} />
              ))}
            </dl>
          ) : (
            <p className="text-sm text-slate-500">{t('offboarding.stepPending')}</p>
          )}
        </Card>
        <Card title={t('offboarding.events')}>
          <ul className="space-y-1 text-xs text-slate-600">
            {o.events.map((e) => (
              <li key={e._id}>
                {formatDateTime(e.at)} — {e.type} {e.step ? `(${t(`offboarding.step.${e.step}`)})` : ''} {e.actorEmail ? `· ${e.actorEmail}` : ''} {e.note ? `— ${e.note}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Dialog open={dialog === 'reject' || dialog === 'cancel'} onClose={() => setDialog(null)} title={dialog ? t(`offboarding.${dialog}`) : ''}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act.mutate({ transition: dialog, reason }); }}>
          <Field label={t('offboarding.reasonRequired')} required>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending}>{t('actions.save')}</Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'approve'} onClose={() => setDialog(null)} title={t('offboarding.approve')}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act.mutate({ transition: 'approve', lastWorkingDay: lastDay || undefined, reason: reason || undefined }); }}>
          <Field label={t('offboarding.lastWorkingDay')}>
            <Input dir="ltr" type="date" value={lastDay || o.lastWorkingDay} onChange={(e) => setLastDay(e.target.value)} />
          </Field>
          <Field label={t('hr.notes')}>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending}>{t('offboarding.approve')}</Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'postpone'} onClose={() => setDialog(null)} title={t('offboarding.postponeResignation')}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act.mutate({ transition: 'postpone_resignation', reason, postponedUntil }); }}>
          <Field label={t('offboarding.postponedUntil')} required>
            <Input dir="ltr" type="date" value={postponedUntil} onChange={(e) => setPostponedUntil(e.target.value)} required />
          </Field>
          <Field label={t('offboarding.reasonRequired')} required>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending}>{t('actions.save')}</Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'line'} onClose={() => setDialog(null)} title={t('offboarding.editLine')}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); settle.mutate({ action: 'edit_line', line: { code: line.code, kind: line.kind, amountHalalas: Math.round(Number(line.amount) * 100), reason: line.reason } }); }}>
          <Field label={t('offboarding.lineCode')}>
            <Select value={line.code} onChange={(e) => setLine({ ...line, code: e.target.value })}>
              {SETTLEMENT_LINE_CODES.map((c) => (
                <option key={c} value={c}>{t(`offboarding.lines.${c}`)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('offboarding.lineKind')}>
            <Select value={line.kind} onChange={(e) => setLine({ ...line, kind: e.target.value })}>
              <option value="earning">{t('offboarding.earning')}</option>
              <option value="deduction">{t('offboarding.deduction')}</option>
            </Select>
          </Field>
          <Field label={t('offboarding.lineAmount')} required>
            <Input dir="ltr" type="number" min={0} step="0.01" value={line.amount} onChange={(e) => setLine({ ...line, amount: e.target.value })} required />
          </Field>
          <Field label={t('offboarding.lineReason')} required>
            <Textarea rows={2} value={line.reason} onChange={(e) => setLine({ ...line, reason: e.target.value })} required />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={settle.isPending}>{t('actions.save')}</Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'custody'} onClose={() => setDialog(null)} title={t('offboarding.returnItem')}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); returnCustody.mutate(); }}>
          <Field label={t('offboarding.custodyItem')}>
            <Select value={custody.custodyId} onChange={(e) => setCustody({ ...custody, custodyId: e.target.value })}>
              {openCustody.map((c) => (
                <option key={c._id} value={c._id}>{c.itemName}</option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={custody.notReturned} onChange={(e) => setCustody({ ...custody, notReturned: e.target.checked })} /> {t('offboarding.notReturned')}
          </label>
          {custody.notReturned ? (
            <Field label={t('offboarding.charge')} required>
              <Input dir="ltr" type="number" min={0} step="0.01" value={custody.charge} onChange={(e) => setCustody({ ...custody, charge: e.target.value })} required />
            </Field>
          ) : (
            <>
              <Field label={t('offboarding.returnedAt')} required>
                <Input dir="ltr" type="date" value={custody.returnedAt} onChange={(e) => setCustody({ ...custody, returnedAt: e.target.value })} required />
              </Field>
              <Field label={t('offboarding.condition')}>
                <Input value={custody.condition} onChange={(e) => setCustody({ ...custody, condition: e.target.value })} />
              </Field>
            </>
          )}
          <div className="flex justify-end">
            <Button type="submit" loading={returnCustody.isPending}>{t('actions.save')}</Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'interview'} onClose={() => setDialog(null)} title={t('offboarding.exitInterview')}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); interview.mutate(); }}>
          <Field label={t('offboarding.interviewedAt')} required>
            <Input dir="ltr" type="date" value={interviewedAt} onChange={(e) => setInterviewedAt(e.target.value)} required />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={declined} onChange={(e) => setDeclined(e.target.checked)} /> {t('offboarding.declined')}
          </label>
          {!declined &&
            (policy.data?.exitInterviewTemplate.questions ?? []).map((qq) => (
              <Field key={qq.key} label={qq.labelAr}>
                {qq.kind === 'text' && <Textarea rows={2} value={String(answers[qq.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [qq.key]: e.target.value })} />}
                {qq.kind === 'rating' && <Input dir="ltr" type="number" min={1} max={5} value={String(answers[qq.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [qq.key]: Number(e.target.value) })} />}
                {qq.kind === 'yes_no' && (
                  <Select value={answers[qq.key] === undefined ? '' : answers[qq.key] ? 'yes' : 'no'} onChange={(e) => setAnswers({ ...answers, [qq.key]: e.target.value === 'yes' })}>
                    <option value="">—</option>
                    <option value="yes">{t('offboarding.yes')}</option>
                    <option value="no">{t('offboarding.no')}</option>
                  </Select>
                )}
              </Field>
            ))}
          <div className="flex justify-end">
            <Button type="submit" loading={interview.isPending} disabled={!declined && !Object.keys(answers).length}>{t('offboarding.saveInterview')}</Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'gov'} onClose={() => setDialog(null)} title={t('offboarding.gov')}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); govExit.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('offboarding.gosiExitRef')}><Input dir="ltr" value={gov.gosiExitRef} onChange={(e) => setGov({ ...gov, gosiExitRef: e.target.value })} /></Field>
            <Field label={t('offboarding.gosiExitAt')}><Input dir="ltr" type="date" value={gov.gosiExitAt} onChange={(e) => setGov({ ...gov, gosiExitAt: e.target.value })} /></Field>
            <Field label={t('offboarding.qiwaExitRef')}><Input dir="ltr" value={gov.qiwaExitRef} onChange={(e) => setGov({ ...gov, qiwaExitRef: e.target.value })} /></Field>
            <Field label={t('offboarding.qiwaExitAt')}><Input dir="ltr" type="date" value={gov.qiwaExitAt} onChange={(e) => setGov({ ...gov, qiwaExitAt: e.target.value })} /></Field>
            <Field label={t('offboarding.finalExitRef')}><Input dir="ltr" value={gov.finalExitRef} onChange={(e) => setGov({ ...gov, finalExitRef: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={govExit.isPending}>{t('offboarding.saveGov')}</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
function Row({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 py-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-900">{value || '—'}</dd>
    </div>
  );
}
