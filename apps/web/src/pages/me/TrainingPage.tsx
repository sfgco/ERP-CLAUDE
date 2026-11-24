import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, patch } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { Badge, Button, Card, EmptyState, PageHeader, QueryError, Spinner } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader, downloadAttachment } from '@/shared/files/FileUploader';
import { participantTone, type ParticipantRow } from '../hr/_h3a';

/** «تدريبي» [HR §3.8.6–3.8.7]: my courses with their state, and the certificate I upload. */
export function MyTrainingPage() {
  const { t } = useTranslation();
  const { formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['training', 'me'], queryFn: () => get<{ items: ParticipantRow[] }>('/hr/training/me') });
  const upload = useMutation({
    mutationFn: (v: { id: string; attachmentId: string }) => patch(`/hr/training/participants/${v.id}`, { certificateAttachmentId: v.attachmentId }),
    onSuccess: () => {
      toast(t('training.certificateUploaded'));
      qc.invalidateQueries({ queryKey: ['training'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  return (
    <>
      <PageHeader title={t('training.myTitle')} subtitle={t('training.myHint')} />
      {!q.data.items.length ? (
        <EmptyState title={t('training.noMyCourses')} />
      ) : (
        <div className="space-y-3">
          {q.data.items.map((p) => (
            <Card key={p._id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{p.training?.title}</div>
                  <div className="text-xs text-slate-500">
                    {p.training?.providerName} · {p.training ? `${formatDateTime(p.training.startAt)} → ${formatDateTime(p.training.endAt)}` : ''}
                    {p.training?.location ? ` · ${p.training.location}` : ''}
                  </div>
                  {p.result && <div className="mt-1 text-sm">{t('training.result')}: {p.result}</div>}
                </div>
                <Badge tone={participantTone[p.status]}>{t(`training.participantStatuses.${p.status}`)}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                {p.certificateAttachmentId ? (
                  <Button variant="secondary" onClick={() => downloadAttachment(p.certificateAttachmentId!)}>
                    {t('training.openCertificate')} — {p.certificateName}
                  </Button>
                ) : (
                  <>
                    <span className="text-xs text-slate-500">{t('training.uploadCertificateHint')}</span>
                    <FileUploader onUploaded={(a) => upload.mutate({ id: p._id, attachmentId: a.attachmentId })} />
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
