import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Paperclip } from 'lucide-react';
import { Link } from 'react-router';
import { HR_REQUEST_TYPES, type HrRequestType } from '@eayni/shared';
import { del, get, post, put } from '@/lib/api';
import { errorMessage, fieldErrorsFrom } from '@/lib/errors';
import { Alert, Button, Dialog, Field, Select } from '@/shared/ui';
import { RequestFields, detailsFromForm, type RequestFormValues } from './_form';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader } from '@/shared/files/FileUploader';

interface TypeInfo {
  type: HrRequestType;
  labelAr: string;
  route: { viaManager: boolean; finalApprover: string };
}

const DRAFT_KEY = 'hr_request';

/** "رفع طلب" [EP §11]: one form, fields switch per type exactly as HR §3.5 lists them. */
export function NewRequestDialog({
  open,
  onClose,
  initialType,
}: {
  open: boolean;
  onClose: () => void;
  initialType?: HrRequestType;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const types = useQuery({
    queryKey: ['hr-request-types'],
    queryFn: () => get<{ items: TypeInfo[]; advanceLimitHalalas: number | null; advanceInstalmentCapHalalas: number; advanceInstalmentCapBp: number }>('/hr/requests/types'),
    enabled: open,
  });
  const [type, setType] = useState<HrRequestType>(initialType ?? 'leave');
  // The attendance screen opens the dialog with a chosen type (correction / exception / overtime).
  useEffect(() => {
    if (open && initialType) setType(initialType);
  }, [open, initialType]);
  const [attachments, setAttachments] = useState<{ attachmentId: string; fileName: string }[]>([]);
  const [error, setError] = useState<string>();
  const form = useForm<RequestFormValues>({
    defaultValues: { leaveType: 'annual', detailed: false, chamberAttestation: false },
  });
  const info = types.data?.items.find((i) => i.type === type);

  // Drafts [HR §7.5 «حفظ الطلبات والمعاملات كمسودات واستكمالها لاحقاً»]: one draft per user for the request form,
  // kept in the platform drafts store until the request is submitted or the draft is discarded.
  type Draft = { _id: string; data: { type: HrRequestType; values: RequestFormValues; attachments: typeof attachments } };
  const drafts = useQuery({
    queryKey: ['drafts', DRAFT_KEY],
    queryFn: () => get<{ items: Draft[] }>(`/drafts?formKey=${DRAFT_KEY}`),
    enabled: open,
  });
  const draft = drafts.data?.items[0];
  const [draftResumed, setDraftResumed] = useState(false);
  const resumeDraft = () => {
    if (!draft) return;
    setType(draft.data.type);
    form.reset(draft.data.values);
    setAttachments(draft.data.attachments ?? []);
    setDraftResumed(true);
  };
  const saveDraft = async () => {
    try {
      await put('/drafts', {
        formKey: DRAFT_KEY,
        data: { type, values: form.getValues(), attachments },
      });
      qc.invalidateQueries({ queryKey: ['drafts', DRAFT_KEY] });
      toast(t('requests.draftSaved'));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const discardDraft = async () => {
    if (!draft) return;
    try {
      await del(`/drafts/${draft._id}`);
      qc.invalidateQueries({ queryKey: ['drafts', DRAFT_KEY] });
      setDraftResumed(false);
      toast(t('requests.draftDiscarded'));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const submit = form.handleSubmit(async (v) => {
    setError(undefined);
    try {
      await post('/hr/requests', {
        type,
        details: detailsFromForm(type, v),
        attachmentIds: attachments.map((a) => a.attachmentId),
        notes: v.generalNotes || undefined,
      });
      toast(t('requests.submitted'));
      if (draft) {
        await del(`/drafts/${draft._id}`).catch(() => undefined);
        qc.invalidateQueries({ queryKey: ['drafts', DRAFT_KEY] });
      }
      qc.invalidateQueries({ queryKey: ['hr-requests'] });
      form.reset();
      setAttachments([]);
      onClose();
    } catch (e) {
      // Server validation lands on the field it names (review C19); anything else goes to the banner.
      const fields = fieldErrorsFrom(e);
      for (const [name, message] of Object.entries(fields)) form.setError(name, { type: 'server', message });
      setError(errorMessage(e));
    }
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('requests.new')}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {error && <Alert kind="error">{error}</Alert>}
        {draft && !draftResumed && (
          <Alert kind="info">
            <div className="flex flex-wrap items-center gap-2">
              <span>{t('requests.draftFound', { type: t(`requests.types.${draft.data.type}`) })}</span>
              <Button type="button" variant="secondary" onClick={resumeDraft}>
                {t('requests.resumeDraft')}
              </Button>
              <button type="button" className="text-xs underline" onClick={discardDraft}>
                {t('requests.discardDraft')}
              </button>
            </div>
          </Alert>
        )}
        <Field label={t('requests.type')}>
          <Select value={type} onChange={(e) => setType(e.target.value as HrRequestType)}>
            {HR_REQUEST_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`requests.types.${x}`)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-xs text-slate-500">
          <Link to="/me/offboarding" className="text-brand-700 underline" onClick={onClose}>
            {t('offboarding.me.resign')}
          </Link>{' '}
          — {t('offboarding.me.hint')}
        </p>
        {info && (
          <p className="text-xs text-slate-500">
            {info.route.finalApprover === 'manager'
              ? t('requests.routeManagerFinal')
              : info.route.viaManager
                ? t('requests.routeViaManager')
                : t('requests.routeDirectHr')}
            {info.route.finalApprover === 'hr_then_finance' && ` · ${t('requests.routeThenFinance')}`}
          </p>
        )}

        <RequestFields type={type} form={form} advanceLimitUnset={types.data?.advanceLimitHalalas === null} advanceInstalmentCapHalalas={types.data?.advanceInstalmentCapHalalas} advanceInstalmentCapBp={types.data?.advanceInstalmentCapBp} />

        <Field label={t('requests.attachments')} hint={t('requests.attachmentsHint')}>
          <div className="space-y-1">
            <FileUploader onUploaded={(a) => setAttachments((s) => [...s, a])} />
            {attachments.map((a) => (
              <div key={a.attachmentId} className="flex items-center gap-1 text-xs text-slate-600">
                <Paperclip className="size-3" aria-hidden /> {a.fileName}
              </div>
            ))}
          </div>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button type="button" variant="secondary" onClick={saveDraft}>
            {t('requests.saveDraft')}
          </Button>
          <Button type="submit" loading={form.formState.isSubmitting}>
            {t('requests.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
