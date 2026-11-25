import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader } from '@/shared/files/FileUploader';
import { riyals, settlementTone, type OffboardingRow } from '../hr/_h3b';

/** The thin Finance stage of the final settlement (E15, art. 88; DECISIONS §22 Q2): HR-approved payslips to pay within the deadline. */
export function SettlementsPage() {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [target, setTarget] = useState<OffboardingRow | null>(null);
  const [paidAt, setPaidAt] = useState(riyadhToday());
  const [ref, setRef] = useState('');
  const [proof, setProof] = useState('');
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['finance', 'settlements', all], queryFn: () => get<{ items: (OffboardingRow & { employee?: { fullNameAr: string; employeeNumber: string; bank?: { bankName?: string; ibanLast4?: string } } })[] }>(`/finance/settlements${all ? '?all=true' : ''}`) });
  const pay = useMutation({
    mutationFn: () => post(`/finance/settlements/${target!._id}/pay`, { action: 'record_payment', paidAt, paymentRef: ref || undefined, proofAttachmentId: proof || undefined, note: note || undefined }),
    onSuccess: () => {
      toast(t('actions.save'));
      setTarget(null);
      qc.invalidateQueries({ queryKey: ['finance', 'settlements'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <>
      <PageHeader title={t('offboarding.finance.title')} subtitle={t('offboarding.finance.hint')} />
      <Card>
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('payroll.showAll')}
        </label>
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <EmptyState title={t('offboarding.finance.empty')} />
        ) : (
          <Table head={[t('offboarding.number'), t('offboarding.employee'), t('offboarding.reason'), t('offboarding.lastWorkingDay'), t('offboarding.finance.due'), t('offboarding.net'), t('recruitment.bank'), t('common.status'), '']}>
            {q.data.items.map((o) => (
              <tr key={o._id}>
                <Td className="tabular text-xs">{o.number}</Td>
                <Td>
                  {o.employee?.fullNameAr} <span className="text-xs text-slate-500">{o.employee?.employeeNumber}</span>
                </Td>
                <Td className="text-xs">{o.reasonLabel}</Td>
                <Td className="tabular text-xs">{formatDate(o.lastWorkingDay)}</Td>
                <Td className="tabular text-xs">{o.settlement?.dueAt ? formatDate(o.settlement.dueAt) : '—'}</Td>
                <Td className="tabular font-semibold">{riyals(o.settlement?.netHalalas)}</Td>
                <Td className="text-xs">{o.employee?.bank?.bankName ? `${o.employee.bank.bankName} ••••${o.employee.bank.ibanLast4 ?? ''}` : '—'}</Td>
                <Td>{o.settlement && <Badge tone={settlementTone[o.settlement.state]}>{t(`offboarding.settlementStates.${o.settlement.state}`)}</Badge>}</Td>
                <Td>{o.settlement?.state === 'at_finance' && <Button onClick={() => setTarget(o)}>{t('offboarding.finance.pay')}</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={!!target} onClose={() => setTarget(null)} title={`${t('offboarding.finance.pay')} — ${target?.number ?? ''}`}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            pay.mutate();
          }}
        >
          <Field label={t('offboarding.paidAt')} required>
            <Input dir="ltr" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} required />
          </Field>
          <Field label={t('offboarding.paymentRef')}>
            <Input dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} />
          </Field>
          <Field label={t('offboarding.proof')}>
            <FileUploader onUploaded={(a) => setProof(a.attachmentId)} />
          </Field>
          <Field label={t('hr.notes')}>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={pay.isPending}>
              {t('offboarding.recordPayment')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
