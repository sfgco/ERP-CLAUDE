import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get } from '@/lib/api';
import { usePrefs } from '@/lib/preferences';
import { Alert, Badge, Card, EmptyState, PageHeader, QueryError, Spinner, Table, Td, cx } from '@/shared/ui';
import { riyals, type PayslipRow } from '../hr/_h3a';

/** «قسيمة الراتب» for the employee [HR §3.6.9]: own payslips once paid, phone-first; the document prints as RTL HTML. */
export function PayslipsPage() {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const q = useQuery({ queryKey: ['payslips', 'me'], queryFn: () => get<{ items: PayslipRow[] }>('/hr/payslips/me') });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const items = q.data.items;
  return (
    <>
      <PageHeader title={t('payslips.title')} subtitle={t('payslips.hint')} />
      {!items.length ? (
        <EmptyState title={t('payslips.empty')} hint={t('payslips.emptyHint')} />
      ) : (
        <div className="space-y-3">
          {items.map((p) => {
            const expanded = open === p._id;
            return (
              <Card key={p._id}>
                <button type="button" className="flex w-full items-center justify-between gap-3 text-start" onClick={() => setOpen(expanded ? null : p._id)} aria-expanded={expanded}>
                  <div>
                    <div className="text-sm text-slate-500">{t('payslips.period')}</div>
                    <div className="text-lg font-semibold tabular">{p.period}</div>
                    {p.visibleToEmployeeAt && <div className="text-xs text-slate-400">{t('payslips.issuedAt', { date: formatDate(p.visibleToEmployeeAt) })}</div>}
                  </div>
                  <div className="text-end">
                    <div className="text-sm text-slate-500">{t('payroll.net')}</div>
                    <div className="text-xl font-bold tabular text-emerald-700">{riyals(p.netHalalas)}</div>
                    {p.flags.includes('provisional_policy') && <Badge tone="amber">{t('attendance.provisional')}</Badge>}
                  </div>
                </button>
                {expanded && (
                  <div className={cx('mt-3 space-y-3 border-t border-slate-100 pt-3 text-sm')}>
                    <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                      <div>{t('payroll.attLine', { present: p.attendance?.presentDays ?? 0, absent: p.attendance?.absentDays ?? 0, late: p.attendance?.lateMinutes ?? 0, ot: p.attendance?.overtimeApprovedMinutes ?? 0 })}</div>
                      <div>{t('hr.bank')}: {p.bankName ?? '—'} {p.bankLast4 ? `****${p.bankLast4}` : ''}</div>
                    </div>
                    <h3 className="font-semibold">{t('payroll.earnings')}</h3>
                    <Table head={[t('payroll.line'), t('payroll.amount')]}>
                      {(p.earnings ?? []).map((l, i) => (
                        <tr key={i}>
                          <Td>{l.labelAr}</Td>
                          <Td className="tabular text-end">{riyals(l.amountHalalas)}</Td>
                        </tr>
                      ))}
                    </Table>
                    <h3 className="font-semibold">{t('payroll.deductions')}</h3>
                    <Table head={[t('payroll.line'), t('payroll.amount')]}>
                      {(p.deductions ?? []).map((l, i) => (
                        <tr key={i}>
                          <Td>
                            {l.labelAr}
                            {l.days ? <span className="text-xs text-slate-500"> ({t('payroll.days', { n: l.days })})</span> : null}
                          </Td>
                          <Td className="tabular text-end">{riyals(l.amountHalalas)}</Td>
                        </tr>
                      ))}
                    </Table>
                    <div className="text-xs text-slate-500">{t('payroll.gosiEmployer')}: {riyals(p.gosiEmployerHalalas)}</div>
                    <a className="inline-block rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-slate-50" href={`/api/v1/hr/payslips/${p._id}/document`} target="_blank" rel="noreferrer">
                      {t('payroll.openDocument')}
                    </a>
                    {p.flags.includes('provisional_policy') && <Alert kind="warning">{t('payslips.provisionalNote')}</Alert>}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
