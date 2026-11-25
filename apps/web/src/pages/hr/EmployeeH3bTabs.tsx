import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, put } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, QueryError, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader } from '@/shared/files/FileUploader';
import { offboardingTone, settlementTone, type OffboardingRow } from './_h3b';

interface Pregnancy {
  declaredAt?: string;
  expectedDeliveryDate?: string;
  endedAt?: string | null;
  note?: string;
}
/** Employee file → tab «إنهاء الخدمة» [HR §3.10, §9.3]: the endings of this employee; for a female employee the art. 155 record (HR only). */
export function EmployeeOffboardingTab({ employeeId, gender, pregnancy }: { employeeId: string; gender: string; pregnancy?: Pregnancy | null }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { formatDate } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['offboarding', 'employee', employeeId], queryFn: () => get<{ items: OffboardingRow[] }>(`/hr/offboarding?employeeId=${employeeId}&limit=20`) });
  const [f, setF] = useState({ declaredAt: pregnancy?.declaredAt?.slice(0, 10) ?? '', expectedDeliveryDate: pregnancy?.expectedDeliveryDate?.slice(0, 10) ?? '', endedAt: pregnancy?.endedAt?.slice(0, 10) ?? '', note: pregnancy?.note ?? '', certificateAttachmentId: '' });
  const save = useMutation({
    mutationFn: () => put(`/hr/offboarding/pregnancy/${employeeId}`, { declaredAt: f.declaredAt, expectedDeliveryDate: f.expectedDeliveryDate, endedAt: f.endedAt || null, note: f.note || undefined, certificateAttachmentId: f.certificateAttachmentId || undefined }),
    onSuccess: () => {
      toast(t('actions.save'));
      qc.invalidateQueries({ queryKey: ['employee', employeeId] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const active = !!pregnancy?.declaredAt && !pregnancy.endedAt;
  return (
    <div className="space-y-3">
      <Card title={t('hr.tabs.offboarding')}>
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <Spinner />
        ) : !q.data.items.length ? (
          <EmptyState title={t('offboarding.empty')} />
        ) : (
          <Table head={[t('offboarding.number'), t('offboarding.reason'), t('offboarding.lastWorkingDay'), t('common.status'), t('offboarding.settlement')]}>
            {q.data.items.map((o) => (
              <tr key={o._id}>
                <Td className="tabular text-xs">
                  <Link to={`/hr/offboarding/${o._id}`} className="text-brand-800 hover:underline">
                    {o.number}
                  </Link>
                </Td>
                <Td className="text-xs">{o.reasonLabel}</Td>
                <Td className="tabular text-xs">{formatDate(o.lastWorkingDay)}</Td>
                <Td>
                  <Badge tone={offboardingTone[o.state]}>{t(`offboarding.states.${o.state}`)}</Badge>
                </Td>
                <Td>{o.settlement ? <Badge tone={settlementTone[o.settlement.state]}>{t(`offboarding.settlementStates.${o.settlement.state}`)}</Badge> : '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {gender === 'female' && can('hr.employees', 'edit') && pregnancy !== undefined && (
        <Card title={t('offboarding.pregnancy')}>
          <p className="mb-2 text-xs text-slate-500">{t('offboarding.pregnancyHint')}</p>
          {active && <Alert kind="info">{t('offboarding.pregnancyActive')}</Alert>}
          <form
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Field label={t('offboarding.declaredAt')} required>
              <Input dir="ltr" type="date" value={f.declaredAt} onChange={(e) => setF({ ...f, declaredAt: e.target.value })} required />
            </Field>
            <Field label={t('offboarding.expectedDeliveryDate')} required>
              <Input dir="ltr" type="date" value={f.expectedDeliveryDate} onChange={(e) => setF({ ...f, expectedDeliveryDate: e.target.value })} required />
            </Field>
            <Field label={t('offboarding.endedAt')}>
              <Input dir="ltr" type="date" value={f.endedAt} onChange={(e) => setF({ ...f, endedAt: e.target.value })} />
            </Field>
            <Field label={t('offboarding.pregnancyCertificate')}>
              <FileUploader onUploaded={(a) => setF({ ...f, certificateAttachmentId: a.attachmentId })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('hr.notes')}>
                <Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
              </Field>
            </div>
            <div className="sm:col-span-3 flex justify-end">
              <Button type="submit" loading={save.isPending}>
                {t('offboarding.savePregnancy')}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
