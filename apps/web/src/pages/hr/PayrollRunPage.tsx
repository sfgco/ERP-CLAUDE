import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { localInputToIso } from '@/lib/dates';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, QueryError, Spinner, Table, Td, Textarea, cx } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { useHrLookups } from './_data';
import { riyals, runTone, type PayrollRunDetail, type PayslipRow } from './_h3a';
import { Kpi } from '../dashboards/_ui';

/**
 * One payroll run [HR §3.6.2–3.6.8]: totals, the reviewer's flags, every payslip with its lines, the actions of the
 * current stage (HR side or the thin Finance side), and the stage log. The same page serves `/hr/payroll/:id` and
 * `/finance/payroll/:id`; the API decides what each side may do (FIN §12).
 */
export function PayrollRunPage({ finance = false }: { finance?: boolean }) {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate, formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const lk = useHrLookups();
  const base = finance ? `/finance/payroll/${id}` : `/hr/payroll/${id}`;
  const q = useQuery({ queryKey: ['payroll', 'run', id, finance], queryFn: () => get<PayrollRunDetail>(base) });
  const [dialog, setDialog] = useState<'return' | 'cancel' | 'finance_return' | 'record_payment' | null>(null);
  const [reason, setReason] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [openSlip, setOpenSlip] = useState<PayslipRow | null>(null);
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => post(`${base}/transition`, body),
    onSuccess: () => {
      toast(t('actions.save'));
      setDialog(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['payroll'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const recompute = useMutation({
    mutationFn: () => post(`/hr/payroll/${id}/recompute`),
    onSuccess: () => {
      toast(t('payroll.recomputed'));
      qc.invalidateQueries({ queryKey: ['payroll'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const r = q.data;
  const has = (a: string) => r.actions.includes(a);
  const lineRows = (lines?: PayslipRow['earnings']) =>
    (lines ?? []).map((l, i) => (
      <tr key={i}>
        <Td>
          {l.labelAr}
          {l.days ? <span className="text-xs text-slate-500"> ({t('payroll.days', { n: l.days })})</span> : null}
          {l.minutes ? <span className="text-xs text-slate-500"> ({t('attendance.minutes', { n: l.minutes })})</span> : null}
          {l.note && <div className="text-xs text-amber-700">{l.note}</div>}
        </Td>
        <Td className="tabular text-end">{riyals(l.amountHalalas)}</Td>
      </tr>
    ));
  return (
    <>
      <PageHeader
        title={`${t('payroll.run')} ${r.number} — ${r.period}`}
        subtitle={r.cutoff?.attendanceFrom ? t('payroll.windowLine', { from: formatDate(r.cutoff.attendanceFrom), to: formatDate(r.cutoff.attendanceTo) }) : undefined}
        actions={
          <>
            <Badge tone={runTone[r.state]}>{t(`payroll.states.${r.state}`)}</Badge>
            <Link to={finance ? '/finance/payroll' : '/hr/payroll'} className="text-sm text-brand-700 hover:underline">
              {t('actions.back')}
            </Link>
          </>
        }
      />
      {r.provisional && <Alert kind="warning">{t('payroll.provisional')}</Alert>}
      {r.flags.length > 0 && (
        <Alert kind="info">
          {t('payroll.flagsTitle')}: {r.flags.filter((f) => !f.includes('deferred:')).map((f) => t(`payroll.flags.${f}`, f)).join(' · ')}
        </Alert>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi to="#" label={t('payroll.employees')} value={r.totals.employeeCount} />
        <Kpi to="#" label={t('payroll.gross')} value={riyals(r.totals.grossHalalas)} />
        <Kpi to="#" label={t('payroll.deductions')} value={riyals(r.totals.deductionsHalalas)} tone="amber" />
        <Kpi to="#" label={t('payroll.net')} value={riyals(r.totals.netHalalas)} tone="green" />
        <Kpi to="#" label={t('payroll.gosiEmployee')} value={riyals(r.totals.gosiEmployeeHalalas)} />
        <Kpi to="#" label={t('payroll.gosiEmployer')} value={riyals(r.totals.gosiEmployerHalalas)} hint={t('payroll.gosiEmployerHint')} />
      </div>

      {(r.actions.length > 0 || (!finance && ['draft', 'returned'].includes(r.state) && can('hr.payroll', 'edit'))) && (
        <Card title={t('requests.actions')} className="mt-4">
          <div className="flex flex-wrap gap-2">
            {!finance && ['draft', 'returned'].includes(r.state) && can('hr.payroll', 'edit') && (
              <Button variant="secondary" onClick={() => recompute.mutate()} loading={recompute.isPending}>
                {t('payroll.recompute')}
              </Button>
            )}
            {has('submit_for_review') && <Button onClick={() => act.mutate({ transition: 'submit_for_review' })}>{t('payroll.actions.submit_for_review')}</Button>}
            {has('hr_approve') && <Button onClick={() => act.mutate({ transition: 'hr_approve' })}>{t('payroll.actions.hr_approve')}</Button>}
            {has('return') && (
              <Button variant="secondary" onClick={() => setDialog('return')}>
                {t('payroll.actions.return')}
              </Button>
            )}
            {has('send_to_finance') && <Button onClick={() => act.mutate({ transition: 'send_to_finance' })}>{t('payroll.actions.send_to_finance')}</Button>}
            {has('finance_approve') && <Button onClick={() => act.mutate({ transition: 'finance_approve' })}>{t('payroll.actions.finance_approve')}</Button>}
            {has('finance_return') && (
              <Button variant="secondary" onClick={() => setDialog('finance_return')}>
                {t('payroll.actions.finance_return')}
              </Button>
            )}
            {has('record_payment') && <Button onClick={() => setDialog('record_payment')}>{t('payroll.actions.record_payment')}</Button>}
            {has('close') && (
              <Button variant="secondary" onClick={() => act.mutate({ transition: 'close' })}>
                {t('payroll.actions.close')}
              </Button>
            )}
            {has('cancel') && (
              <Button variant="danger" onClick={() => setDialog('cancel')}>
                {t('payroll.actions.cancel')}
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">{t('payroll.sodHint')}</p>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title={t('payroll.payslips')}>
          <Table head={[t('hr.employee'), t('hr.department'), t('payroll.gross'), t('payroll.deductions'), t('payroll.net'), t('payroll.attendanceShort'), '']}>
            {r.payslips.map((p) => (
              <tr key={p._id} className={cx(p.flags.includes('no_salary') && 'bg-amber-50')}>
                <Td>
                  <div className="font-medium">{p.fullNameAr}</div>
                  <div className="text-xs text-slate-500">{p.employeeNumber}</div>
                </Td>
                <Td className="text-xs">{lk.deptName(p.departmentId)}</Td>
                <Td className="tabular text-xs">{riyals(p.grossHalalas)}</Td>
                <Td className="tabular text-xs">{riyals(p.deductionsHalalas)}</Td>
                <Td className="tabular font-semibold">{riyals(p.netHalalas)}</Td>
                <Td className="text-xs text-slate-600">
                  {t('payroll.attLine', { present: p.attendance?.presentDays ?? 0, absent: p.attendance?.absentDays ?? 0, late: p.attendance?.lateMinutes ?? 0, ot: p.attendance?.overtimeApprovedMinutes ?? 0 })}
                  {p.flags.filter((f) => f !== 'provisional_policy' && !f.includes('deferred:')).length > 0 && (
                    <div className="text-amber-700">{p.flags.filter((f) => f !== 'provisional_policy' && !f.includes('deferred:')).map((f) => t(`payroll.flags.${f}`, f)).join(' · ')}</div>
                  )}
                </Td>
                <Td>
                  <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setOpenSlip(p)}>
                    {t('payroll.lines')}
                  </button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title={t('requests.log')}>
          <ol className="relative space-y-3 border-s border-slate-200 ps-4 text-sm">
            {r.stages.map((s) => (
              <li key={s._id} className="relative">
                <span className="absolute -start-[21px] top-1.5 size-2.5 rounded-full bg-brand-600" aria-hidden />
                <div className="font-medium">
                  {t(`payroll.actions.${s.transition}`, s.transition)} <span className="text-xs text-slate-500">← {t(`payroll.states.${s.toState}`, s.toState)}</span>
                </div>
                {s.reason && <div className="text-xs text-slate-600">{s.reason}</div>}
                <div className="text-xs text-slate-400 tabular">
                  {formatDateTime(s.at)} · {s.actorEmail}
                </div>
              </li>
            ))}
          </ol>
          {r.finance?.paidAt && (
            <p className="mt-3 text-sm text-emerald-800">
              {t('payroll.paidLine', { at: formatDate(r.finance.paidAt), ref: r.finance.paymentRef ?? '—' })}
            </p>
          )}
          {r.notes && <p className="mt-2 text-xs text-slate-500">{r.notes}</p>}
        </Card>
      </div>

      <Dialog open={!!openSlip} onClose={() => setOpenSlip(null)} title={openSlip ? `${t('payroll.payslip')} — ${openSlip.fullNameAr}` : ''}>
        {openSlip && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
              <div>{t('payroll.gosiGroup')}: {t(`payroll.gosiGroups.${openSlip.gosiGroup}`, openSlip.gosiGroup ?? '—')}</div>
              <div>{t('hr.bank')}: {openSlip.bankName ?? '—'} {openSlip.bankLast4 ? `****${openSlip.bankLast4}` : ''}</div>
            </div>
            <h3 className="font-semibold">{t('payroll.earnings')}</h3>
            <Table head={[t('payroll.line'), t('payroll.amount')]}>{lineRows(openSlip.earnings)}</Table>
            <h3 className="font-semibold">{t('payroll.deductions')}</h3>
            <Table head={[t('payroll.line'), t('payroll.amount')]}>{lineRows(openSlip.deductions)}</Table>
            <div className="flex justify-between font-semibold">
              <span>{t('payroll.net')}</span>
              <span className="tabular">{riyals(openSlip.netHalalas)}</span>
            </div>
            <div className="text-xs text-slate-500">{t('payroll.gosiEmployer')}: {riyals(openSlip.gosiEmployerHalalas)}</div>
            <a className="text-sm text-brand-700 hover:underline" href={`/api/v1/hr/payslips/${openSlip._id}/document`} target="_blank" rel="noreferrer">
              {t('payroll.openDocument')}
            </a>
          </div>
        )}
      </Dialog>

      <Dialog open={!!dialog} onClose={() => setDialog(null)} title={dialog ? t(`payroll.actions.${dialog}`) : ''}>
        <div className="space-y-3">
          {dialog === 'record_payment' ? (
            <>
              <Alert kind="info">{t('payroll.paymentHint')}</Alert>
              <Field label={t('payroll.paidAt')} required>
                <Input type="datetime-local" dir="ltr" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} required />
              </Field>
              <Field label={t('payroll.paymentRef')}>
                <Input dir="ltr" value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} />
              </Field>
            </>
          ) : (
            <Field label={t('requests.reasonRequired')} required>
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant={dialog === 'cancel' ? 'danger' : 'primary'}
              loading={act.isPending}
              disabled={dialog === 'record_payment' ? !paidAt : reason.trim().length < 2}
              onClick={() => dialog && act.mutate(dialog === 'record_payment' ? { transition: dialog, paidAt: localInputToIso(paidAt), paymentRef: paymentRef || undefined } : { transition: dialog, reason })}
            >
              {dialog ? t(`payroll.actions.${dialog}`) : ''}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
