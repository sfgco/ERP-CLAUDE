import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { get, post, put } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { Badge, Button, Card, Input, PageHeader, Spinner, QueryError } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';

interface Row {
  key: string;
  labelAr: string;
  group: string;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  descriptionAr?: string;
  provisional: boolean;
  confirmedAt?: string | null;
}

/** Settings registry editor (golden rule 10). Values are typed JSON; the server validates each against its schema. */
export function SettingsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get<{ items: Row[] }>('/settings') });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const groups = [...new Set(q.data?.items.map((r) => r.group) ?? [])];
  // DECISIONS §21: a provisional default stays «مؤقت حتى اعتماد الموارد البشرية» until the admin confirms it here.
  const confirm = async (row: Row) => {
    try {
      await post(`/settings/${row.key}/confirm`);
      toast(t('admin.settings.confirmed'));
      qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const save = async (row: Row) => {
    const raw = drafts[row.key];
    let value: unknown;
    try {
      value = raw === undefined ? row.value : JSON.parse(raw);
    } catch {
      value = raw;
    }
    try {
      await put(`/settings/${row.key}`, { value });
      toast(t('actions.save'));
      setDrafts((d) => ({ ...d, [row.key]: undefined as unknown as string }));
      qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <PageHeader title={t('admin.settings.title')} subtitle={t('admin.settings.hint')} />
      {q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <Card key={g} title={t(`admin.settings.groups.${g}`)}>
              <ul className="divide-y divide-slate-100">
                {q
                  .data!.items.filter((r) => r.group === g)
                  .map((row) => (
                    <li
                      key={row.key}
                      className="grid gap-2 py-3 sm:grid-cols-[1fr_280px_auto] sm:items-center"
                    >
                      <div>
                        <div className="text-sm font-medium text-slate-800">
                          {row.labelAr} {row.provisional && <Badge tone="amber">{t('admin.settings.provisional')}</Badge>}
                        </div>
                        {row.descriptionAr && <div className="text-xs text-slate-500">{row.descriptionAr}</div>}
                        <div className="text-xs text-slate-400" dir="ltr">
                          {row.key}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                          {t('admin.settings.default')}: <code dir="ltr">{JSON.stringify(row.default)}</code>
                          {row.isDefault && <Badge>{t('admin.settings.isDefault')}</Badge>}
                        </div>
                      </div>
                      <Input
                        dir="ltr"
                        className="font-mono text-xs"
                        value={drafts[row.key] ?? JSON.stringify(row.value)}
                        onChange={(e) => setDrafts((d) => ({ ...d, [row.key]: e.target.value }))}
                        disabled={!can('settings', 'edit')}
                      />
                      <div className="flex flex-col gap-1">
                        <Button
                          variant="secondary"
                          onClick={() => save(row)}
                          disabled={!can('settings', 'edit') || drafts[row.key] === undefined}
                        >
                          {t('actions.save')}
                        </Button>
                        {row.provisional && can('settings', 'edit') && (
                          <Button variant="secondary" onClick={() => confirm(row)}>
                            {t('admin.settings.confirm')}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
