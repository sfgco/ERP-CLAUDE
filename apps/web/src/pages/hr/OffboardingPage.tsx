import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { OFFBOARDING_STATES } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader } from '@/shared/files/FileUploader';
import { useHrLookups } from './_data';
import { offboardingTone, settlementTone, type EosPolicyView, type OffboardingRow } from './_h3b';

/** «إنهاء الخدمة» [HR §3.10, §9.10]: the register and the HR request with the reason-specific legal fields (docs/HR_H3B_LEGAL.md). */
export function OffboardingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { formatDate } = usePrefs();
  const lk = useHrLookups();
  const [state, setState] = useState('');
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['offboarding', 'list', state], queryFn: () => get<{ items: OffboardingRow[]; total: number }>(`/hr/offboarding?limit=100${state ? `&state=${state}` : ''}`) });
  const policy = useQuery({ queryKey: ['offboarding', 'policy'], queryFn: () => get<EosPolicyView>('/hr/offboarding/policy'), enabled: can('hr.offboarding', 'create') });
  const [f, setF] = useState({ employeeId: '', reason: 'employer_notice', art80Case: '', hearingAt: '', hearingSummary: '', hearingDeclined: false, hearingFiles: [] as string[], art81Case: '', eventDate: '', eventAttachmentId: '', medicalCertificateAttachmentId: '', writtenAgreementAttachmentId: '', noticeDate: '', lastWorkingDay: '', details: '', attachmentIds: [] as string[] });
  const absence = useQuery({ queryKey: ['offboarding', 'art80', f.employeeId, f.lastWorkingDay], queryFn: () => get<{ messageAr: string; ok: boolean }>(`/hr/offboarding/art80-absence/${f.employeeId}?day=${f.lastWorkingDay}`), enabled: open && f.reason === 'dismissal_art80' && f.art80Case === 'absence' && !!f.employeeId && !!f.lastWorkingDay });
  const create = useMutation({
    mutationFn: () =>
      post<OffboardingRow>('/hr/offboarding', {
        employeeId: f.employeeId,
        reason: f.reason,
        art80Case: f.reason === 'dismissal_art80' ? f.art80Case : undefined,
        hearing: f.reason === 'dismissal_art80' ? { heldAt: f.hearingAt, summary: f.hearingSummary, attachmentIds: f.hearingFiles, employeeDeclined: f.hearingDeclined } : undefined,
        art81Case: f.reason === 'leaving_art81' ? f.art81Case : undefined,
        eventDate: f.eventDate || undefined,
        eventAttachmentId: f.eventAttachmentId || undefined,
        medicalCertificateAttachmentId: f.medicalCertificateAttachmentId || undefined,
        writtenAgreementAttachmentId: f.writtenAgreementAttachmentId || undefined,
        noticeDate: f.noticeDate || undefined,
        lastWorkingDay: f.lastWorkingDay,
        details: f.details || undefined,
        attachmentIds: f.attachmentIds,
      }),
    onSuccess: (r) => {
      toast(r.number);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['offboarding'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const legal = policy.data?.legalSettings;
  return (
    <>
      <PageHeader title={t('offboarding.title')} subtitle={t('offboarding.hint')} actions={can('hr.offboarding', 'create') ? <Button onClick={() => setOpen(true)}>{t('offboarding.new')}</Button> : undefined} />
      {legal && !legal.complete && (
        <Alert kind="warning">
          {t('hr.home.legalSettings')}: {legal.missing.map((m) => m.labelAr).join(' · ')} — {t('hr.home.legalSettingsHint')}
        </Alert>
      )}
      <Card className="mt-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={state} onChange={(e) => setState(e.target.value)} className="sm:w-72">
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            {OFFBOARDING_STATES.map((s) => (
              <option key={s} value={s}>
                {t(`offboarding.states.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <EmptyState title={t('offboarding.empty')} />
        ) : (
          <Table head={[t('offboarding.number'), t('offboarding.employee'), t('offboarding.reason'), t('offboarding.lastWorkingDay'), t('common.status'), t('offboarding.settlement')]}>
            {q.data.items.map((o) => (
              <tr key={o._id}>
                <Td className="tabular text-xs">
                  <Link to={`/hr/offboarding/${o._id}`} className="text-brand-800 hover:underline">
                    {o.number}
                  </Link>
                </Td>
                <Td>{o.employee?.fullNameAr ?? '—'}</Td>
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
      <Dialog open={open} onClose={() => setOpen(false)} title={t('offboarding.new')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('offboarding.employee')} required>
            <Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} required>
              <option value="">—</option>
              {lk.employees.map((e) => (
                <option key={e._id} value={e._id}>
                  {e.fullNameAr} — {e.employeeNumber}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('offboarding.reason')} hint={t('offboarding.reasonHint')} required>
            <Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
              {(policy.data?.reasons ?? []).filter((r) => r.code !== 'resignation').map((r) => (
                <option key={r.code} value={r.code}>
                  {r.labelAr}
                </option>
              ))}
            </Select>
          </Field>
          {f.reason === 'dismissal_art80' && (
            <>
              <Field label={t('offboarding.art80Case')} required>
                <Select value={f.art80Case} onChange={(e) => setF({ ...f, art80Case: e.target.value })} required>
                  <option value="">—</option>
                  {(policy.data?.art80Cases ?? []).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.n}. {c.labelAr}
                    </option>
                  ))}
                </Select>
              </Field>
              {f.art80Case === 'absence' && absence.data && <Alert kind={absence.data.ok ? 'info' : 'warning'}>{absence.data.messageAr}</Alert>}
              <Field label={t('offboarding.hearing')} required>
                <div className="space-y-2">
                  <Input dir="ltr" type="date" value={f.hearingAt} onChange={(e) => setF({ ...f, hearingAt: e.target.value })} required aria-label={t('offboarding.hearingAt')} />
                  <Textarea rows={3} placeholder={t('offboarding.hearingSummary')} value={f.hearingSummary} onChange={(e) => setF({ ...f, hearingSummary: e.target.value })} required />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={f.hearingDeclined} onChange={(e) => setF({ ...f, hearingDeclined: e.target.checked })} /> {t('offboarding.hearingDeclined')}
                  </label>
                  <FileUploader onUploaded={(a) => setF({ ...f, hearingFiles: [...f.hearingFiles, a.attachmentId] })} label={t('offboarding.hearingFiles')} />
                </div>
              </Field>
            </>
          )}
          {f.reason === 'leaving_art81' && (
            <Field label={t('offboarding.art81Case')} required>
              <Select value={f.art81Case} onChange={(e) => setF({ ...f, art81Case: e.target.value })} required>
                <option value="">—</option>
                {(policy.data?.art81Cases ?? []).map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.n}. {c.labelAr}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {f.reason === 'marriage_or_birth_art87' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('offboarding.eventDate')}>
                <Input dir="ltr" type="date" value={f.eventDate} onChange={(e) => setF({ ...f, eventDate: e.target.value })} />
              </Field>
              <Field label={t('offboarding.eventFile')}>
                <FileUploader onUploaded={(a) => setF({ ...f, eventAttachmentId: a.attachmentId })} />
              </Field>
            </div>
          )}
          {f.reason === 'incapacity' && (
            <Field label={t('offboarding.medicalCertificate')} required>
              <FileUploader onUploaded={(a) => setF({ ...f, medicalCertificateAttachmentId: a.attachmentId })} />
            </Field>
          )}
          {f.reason === 'mutual_agreement' && (
            <Field label={t('offboarding.writtenAgreement')} required>
              <FileUploader onUploaded={(a) => setF({ ...f, writtenAgreementAttachmentId: a.attachmentId })} />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('offboarding.noticeDate')}>
              <Input dir="ltr" type="date" value={f.noticeDate} onChange={(e) => setF({ ...f, noticeDate: e.target.value })} />
            </Field>
            <Field label={t('offboarding.lastWorkingDay')} required>
              <Input dir="ltr" type="date" value={f.lastWorkingDay} onChange={(e) => setF({ ...f, lastWorkingDay: e.target.value })} required />
            </Field>
          </div>
          <Field label={t('offboarding.details')}>
            <Textarea rows={2} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} />
          </Field>
          <Field label={t('offboarding.attachments')}>
            <FileUploader onUploaded={(a) => setF({ ...f, attachmentIds: [...f.attachmentIds, a.attachmentId] })} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={create.isPending}>
              {t('requests.submit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
