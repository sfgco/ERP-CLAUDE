import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { Badge, Button, Card, Dialog, EmptyState, Field, PageHeader, QueryError, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';

interface Row {
  _id: string;
  number: string;
  lastWorkingDay: string;
  state: string;
  employee?: { fullNameAr: string; employeeNumber: string; workEmail: string };
  steps?: { it_closure?: { done?: boolean } };
  it?: { confirmedAt?: string; note?: string };
  custodyChecklist: { itemName: string; returnedAt?: string; notReturned?: boolean }[];
}
/** The thin IT stage of end of service [HR §3.10.6, IT §7.3]: the queue of leavers and the confirmation of the account closure. */
export function ItOffboardingPage() {
  const { t } = useTranslation();
  const { formatDate, formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [target, setTarget] = useState<Row | null>(null);
  const [note, setNote] = useState('');
  const [assets, setAssets] = useState(true);
  const q = useQuery({ queryKey: ['it', 'offboarding', all], queryFn: () => get<{ items: Row[] }>(`/it/offboarding${all ? '?all=true' : ''}`) });
  const confirm = useMutation({
    mutationFn: () => post(`/it/offboarding/${target!._id}/confirm`, { note: note || undefined, assetsReturned: assets }),
    onSuccess: () => {
      toast(t('actions.save'));
      setTarget(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['it', 'offboarding'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <>
      <PageHeader title={t('nav.itOffboarding')} subtitle={t('offboarding.itQueueHint')} />
      <Card>
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('offboarding.showAll')}
        </label>
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <EmptyState title={t('offboarding.empty')} />
        ) : (
          <Table head={[t('offboarding.number'), t('offboarding.employee'), t('recruitment.workEmail'), t('offboarding.lastWorkingDay'), t('offboarding.custody'), t('common.status'), '']}>
            {q.data.items.map((o) => (
              <tr key={o._id}>
                <Td className="tabular text-xs">{o.number}</Td>
                <Td>
                  {o.employee?.fullNameAr} <span className="text-xs text-slate-500">{o.employee?.employeeNumber}</span>
                </Td>
                <Td dir="ltr" className="text-xs">
                  {o.employee?.workEmail}
                </Td>
                <Td className="tabular text-xs">{formatDate(o.lastWorkingDay)}</Td>
                <Td className="text-xs">{o.custodyChecklist.map((c) => `${c.itemName}${c.returnedAt ? ' ✓' : c.notReturned ? ' ✗' : ''}`).join(' · ') || '—'}</Td>
                <Td>{o.steps?.it_closure?.done ? <Badge tone="green">{o.it?.confirmedAt ? formatDateTime(o.it.confirmedAt) : t('offboarding.stepDone')}</Badge> : <Badge tone="amber">{t('offboarding.stepPending')}</Badge>}</Td>
                <Td>{!o.steps?.it_closure?.done && <Button onClick={() => setTarget(o)}>{t('offboarding.itConfirm')}</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={!!target} onClose={() => setTarget(null)} title={`${t('offboarding.itConfirm')} — ${target?.employee?.fullNameAr ?? ''}`}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
        >
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={assets} onChange={(e) => setAssets(e.target.checked)} /> {t('offboarding.assetsReturned')}
          </label>
          <Field label={t('offboarding.itNote')}>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={confirm.isPending}>
              {t('offboarding.itConfirm')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
