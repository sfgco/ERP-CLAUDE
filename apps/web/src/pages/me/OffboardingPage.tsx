import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, QueryError, Select, Spinner, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader } from '@/shared/files/FileUploader';
import { offboardingTone, riyals, settlementTone, type OffboardingRow } from '../hr/_h3b';

interface MyData {
  items: OffboardingRow[];
  canResign: boolean;
  policy: { resignationDeemedAcceptedDays: number; resignationMaxPostponeDays: number; resignationWithdrawDays: number };
  gender: string;
}
/** «رفع طلب» → استقالة (E25, art. 79 bis) and the employee's own end-of-service record with its legal dates. */
export function MyOffboardingPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const { formatDate } = usePrefs();
  const q = useQuery({ queryKey: ['me', 'offboarding'], queryFn: () => get<MyData>('/me/offboarding') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ reason: '', requestedLastWorkingDay: '', art87: false, art87Event: 'marriage', art87EventDate: '', art87AttachmentId: '', attachmentIds: [] as string[] });
  const resign = useMutation({
    mutationFn: () => post('/me/offboarding/resign', { reason: f.reason, requestedLastWorkingDay: f.requestedLastWorkingDay || undefined, art87Event: f.art87 ? f.art87Event : undefined, art87EventDate: f.art87 ? f.art87EventDate || undefined : undefined, art87AttachmentId: f.art87 ? f.art87AttachmentId || undefined : undefined, attachmentIds: f.attachmentIds }),
    onSuccess: () => {
      toast(t('requests.submitted'));
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['me', 'offboarding'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => post(`/me/offboarding/${id}/withdraw`, {}),
    onSuccess: () => {
      toast(t('actions.save'));
      qc.invalidateQueries({ queryKey: ['me', 'offboarding'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const d = q.data;
  return (
    <>
      <PageHeader title={t('offboarding.me.title')} subtitle={t('offboarding.me.hint')} actions={d.canResign ? <Button onClick={() => setOpen(true)}>{t('offboarding.me.resign')}</Button> : undefined} />
      {!d.items.length && <Alert kind="info">{t('offboarding.me.none')}</Alert>}
      {d.items.map((o) => (
        <Card key={o._id} className="mt-3" title={`${o.number} — ${o.reasonLabel}`} actions={<Badge tone={offboardingTone[o.state]}>{t(`offboarding.states.${o.state}`)}</Badge>}>
          <dl className="text-sm">
            <Row label={t('offboarding.lastWorkingDay')} value={formatDate(o.lastWorkingDay)} />
            {o.resignation?.withdrawDeadline && !o.resignation.acceptedAt && !o.resignation.withdrawnAt && <Row label={t('offboarding.me.withdraw')} value={t('offboarding.me.withdrawUntil', { date: formatDate(o.resignation.withdrawDeadline) })} />}
            {o.resignation?.deemedAcceptedAt && !o.resignation.acceptedAt && !o.resignation.postponedUntil && <Row label={t('offboarding.art79bis')} value={t('offboarding.me.deemedAt', { date: formatDate(o.resignation.deemedAcceptedAt) })} />}
            {o.resignation?.postponedUntil && !o.resignation.acceptedAt && <Row label={t('offboarding.art79bis')} value={t('offboarding.me.postponedUntil', { date: formatDate(o.resignation.postponedUntil), reason: o.resignation.postponeReason ?? '' })} />}
            {o.resignation?.acceptedAt && <Row label={t('offboarding.art79bis')} value={t('offboarding.me.acceptedAt', { date: formatDate(o.resignation.acceptedAt), kind: t(`offboarding.me.acceptanceKinds.${o.resignation.acceptanceKind ?? 'explicit'}`) })} />}
            {o.settlement && o.settlement.state !== 'pending' && (
              <Row label={t('offboarding.settlement')} value={<span className="flex items-center gap-2"><Badge tone={settlementTone[o.settlement.state]}>{t(`offboarding.settlementStates.${o.settlement.state}`)}</Badge> {o.settlement.netHalalas !== undefined && <span className="tabular">{riyals(o.settlement.netHalalas)} {t('common.currency')}</span>} {o.settlement.dueAt && `· ${t('offboarding.dueAt')} ${formatDate(o.settlement.dueAt)}`}</span>} />
            )}
            {o.experienceCertificate?.number && <Row label={t('offboarding.certificate')} value={<a className="text-brand-700 underline" href={`/api/v1/files/${o.experienceCertificate.attachmentId}/download`} target="_blank" rel="noreferrer">{o.experienceCertificate.number}</a>} />}
            {o.legalWarnings?.length > 0 && <Row label={t('offboarding.legalWarnings')} value={o.legalWarnings.join(' · ')} />}
          </dl>
          {['resignation_submitted', 'resignation_postponed'].includes(o.state) && o.resignation?.withdrawDeadline && new Date(o.resignation.withdrawDeadline) > new Date() && (
            <Button variant="secondary" className="mt-2" onClick={() => withdraw.mutate(o._id)} loading={withdraw.isPending}>
              {t('offboarding.me.withdraw')}
            </Button>
          )}
        </Card>
      ))}
      <Dialog open={open} onClose={() => setOpen(false)} title={t('offboarding.me.resign')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            resign.mutate();
          }}
        >
          <Alert kind="info">{t('offboarding.me.hint')}</Alert>
          <Field label={t('offboarding.me.reason')} required>
            <Textarea rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required />
          </Field>
          <Field label={t('offboarding.me.requestedLastWorkingDay')}>
            <Input dir="ltr" type="date" value={f.requestedLastWorkingDay} onChange={(e) => setF({ ...f, requestedLastWorkingDay: e.target.value })} />
          </Field>
          {d.gender === 'female' && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.art87} onChange={(e) => setF({ ...f, art87: e.target.checked })} /> {t('offboarding.me.art87')}
              </label>
              {f.art87 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('offboarding.me.art87Event')}>
                    <Select value={f.art87Event} onChange={(e) => setF({ ...f, art87Event: e.target.value })}>
                      <option value="marriage">{t('offboarding.me.marriage')}</option>
                      <option value="birth">{t('offboarding.me.birth')}</option>
                    </Select>
                  </Field>
                  <Field label={t('offboarding.me.art87Date')}>
                    <Input dir="ltr" type="date" value={f.art87EventDate} onChange={(e) => setF({ ...f, art87EventDate: e.target.value })} />
                  </Field>
                  <Field label={t('offboarding.eventFile')}>
                    <FileUploader onUploaded={(a) => setF({ ...f, art87AttachmentId: a.attachmentId })} />
                  </Field>
                </div>
              )}
            </>
          )}
          <Field label={t('offboarding.attachments')}>
            <FileUploader onUploaded={(a) => setF({ ...f, attachmentIds: [...f.attachmentIds, a.attachmentId] })} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={resign.isPending}>
              {t('offboarding.me.submit')}
            </Button>
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
