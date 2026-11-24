import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PAYROLL_RUN_STATES } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { riyals, runTone, type PayrollRunRow } from './_h3a';

interface ListData {
  items: PayrollRunRow[];
  total: number;
  currentPeriod: string;
  policy: { cutoffDay: number; payDay: number; payslipVisibleAt: string };
  provisional: boolean;
}

/** «مسيرات الرواتب» for HR [HR §3.6.2, §3.6.8]: the register of runs by period and state; a new run is prepared from the salary master. */
export function PayrollPage({ finance = false }: { finance?: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { formatDate } = usePrefs();
  const [state, setState] = useState('');
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState('');
  const [notes, setNotes] = useState('');
  const [all, setAll] = useState(false);
  const q = useQuery({
    queryKey: ['payroll', finance ? 'finance' : 'hr', state, all],
    queryFn: () => (finance ? get<{ items: PayrollRunRow[] }>(`/finance/payroll${all ? '?all=true' : ''}`) : get<ListData>(`/hr/payroll?limit=48${state ? `&state=${state}` : ''}`)),
  });
  const create = useMutation({
    mutationFn: () => post<PayrollRunRow>('/hr/payroll', { period, notes: notes || undefined }),
    onSuccess: (r) => {
      toast(t('payroll.created', { number: r.number }));
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['payroll'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const data = q.data as Partial<ListData> | undefined;
  return (
    <>
      <PageHeader
        title={finance ? t('payroll.financeTitle') : t('payroll.title')}
        subtitle={finance ? t('payroll.financeHint') : t('payroll.hint')}
        actions={
          !finance && can('hr.payroll', 'create') ? (
            <Button
              onClick={() => {
                setPeriod(data?.currentPeriod ?? '');
                setOpen(true);
              }}
            >
              {t('payroll.newRun')}
            </Button>
          ) : undefined
        }
      />
      {!finance && data?.provisional && <Alert kind="warning">{t('payroll.provisional')}</Alert>}
      {!finance && data?.policy && (
        <p className="mt-2 text-xs text-slate-500">{t('payroll.policyLine', { cutoff: data.policy.cutoffDay, pay: data.policy.payDay, visible: t(`payroll.visibleAt.${data.policy.payslipVisibleAt}`) })}</p>
      )}
      <Card className="mt-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {finance ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('payroll.showAll')}
            </label>
          ) : (
            <Select value={state} onChange={(e) => setState(e.target.value)} className="sm:w-64">
              <option value="">
                {t('common.status')}: {t('common.all')}
              </option>
              {PAYROLL_RUN_STATES.map((s) => (
                <option key={s} value={s}>
                  {t(`payroll.states.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </div>
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <EmptyState title={t('payroll.empty')} hint={finance ? t('payroll.financeEmptyHint') : undefined} />
        ) : (
          <Table head={[t('payroll.number'), t('payroll.period'), t('common.status'), t('payroll.employees'), t('payroll.gross'), t('payroll.deductions'), t('payroll.net'), t('payroll.paidAt')]}>
            {q.data.items.map((r) => (
              <tr key={r._id}>
                <Td className="tabular text-xs">
                  <Link to={finance ? `/finance/payroll/${r._id}` : `/hr/payroll/${r._id}`} className="text-brand-800 hover:underline">
                    {r.number}
                  </Link>
                  {r.flags?.includes('provisional_policy') && <span className="ms-1 text-xs text-amber-700">⚑</span>}
                </Td>
                <Td className="tabular">{r.period}</Td>
                <Td>
                  <Badge tone={runTone[r.state]}>{t(`payroll.states.${r.state}`)}</Badge>
                </Td>
                <Td className="tabular">{r.totals?.employeeCount ?? 0}</Td>
                <Td className="tabular text-xs">{riyals(r.totals?.grossHalalas)}</Td>
                <Td className="tabular text-xs">{riyals(r.totals?.deductionsHalalas)}</Td>
                <Td className="tabular font-semibold">{riyals(r.totals?.netHalalas)}</Td>
                <Td className="tabular text-xs">{r.finance?.paidAt ? formatDate(r.finance.paidAt) : '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('payroll.newRun')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Alert kind="info">{t('payroll.newRunHint')}</Alert>
          <Field label={t('payroll.period')} required hint={t('payroll.periodHint')}>
            <Input dir="ltr" value={period} onChange={(e) => setPeriod(e.target.value)} pattern="\d{4}-(0[1-9]|1[0-2])" placeholder="2026-11" required />
          </Field>
          <Field label={t('hr.notes')}>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('payroll.prepare')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
