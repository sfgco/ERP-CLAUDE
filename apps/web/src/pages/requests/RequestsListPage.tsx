import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { HR_REQUEST_TYPES } from '@eayni/shared';
import { get, type Paged } from '@/lib/api';
import { usePrefs } from '@/lib/preferences';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  QueryError,
} from '@/shared/ui';
import { NewRequestDialog } from './NewRequestDialog';
import { stateTone, type HrRequestRow } from './_data';

type View = 'mine' | 'inbox' | 'queue' | 'all';

/** Requests list in three guises: my requests [HR §3.5], the direct manager's inbox, the HR/Finance queue. */
export function RequestsListPage({ view }: { view: View }) {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const { formatDate } = usePrefs();
  const [type, setType] = useState(search.get('type') ?? '');
  const [state, setState] = useState(search.get('state') ?? '');
  const [open, setOpen] = useState(false);
  // Dashboard drill-downs [HR §5 رابعاً] arrive as URL filters: a submission window, an outcome, or «pending».
  const from = search.get('from') ?? '';
  const to = search.get('to') ?? '';
  const outcome = search.get('outcome') ?? '';
  const pending = search.get('pending') ?? '';
  const params = new URLSearchParams({
    view,
    limit: '100',
    ...(type ? { type } : {}),
    ...(state ? { state } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(outcome ? { outcome } : {}),
    ...(pending ? { pending: 'true' } : {}),
  });
  const extraFilters = from || to || outcome || pending;
  const q = useQuery({
    queryKey: ['hr-requests', view, type, state, from, to, outcome, pending],
    queryFn: () => get<Paged<HrRequestRow>>(`/hr/requests?${params}`),
  });
  const titles: Record<View, string> = {
    mine: t('requests.mine'),
    inbox: t('requests.inbox'),
    queue: t('requests.queue'),
    all: t('requests.all'),
  };
  const states = [
    'awaiting_manager',
    'awaiting_hr',
    'awaiting_final',
    'needs_completion',
    'approved',
    'rejected',
  ];
  return (
    <>
      <PageHeader
        title={titles[view]}
        subtitle={
          view === 'inbox' ? t('requests.inboxHint') : view === 'queue' ? t('requests.queueHint') : undefined
        }
        actions={view === 'mine' && <Button onClick={() => setOpen(true)}>{t('requests.new')}</Button>}
      />
      <Card>
        {extraFilters && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            {(from || to) && <Badge tone="blue">{t('requests.filterPeriod', { from, to })}</Badge>}
            {outcome && <Badge tone="blue">{t('requests.filterOutcome', { outcome: t(`requests.states.${outcome}`) })}</Badge>}
            {pending && <Badge tone="blue">{t('requests.filterPending')}</Badge>}
            <Link to={view === 'queue' ? '/hr/requests' : view === 'inbox' ? '/manager/requests' : '/me/requests'} className="text-brand-700 hover:underline">
              {t('requests.clearFilters')}
            </Link>
          </div>
        )}
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">
              {t('requests.type')}: {t('common.all')}
            </option>
            {HR_REQUEST_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`requests.types.${x}`)}
              </option>
            ))}
          </Select>
          {view !== 'inbox' && (
            <Select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">
                {t('common.status')}: {t('common.all')}
              </option>
              {states.map((s) => (
                <option key={s} value={s}>
                  {t(`requests.states.${s}`)}
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
          <EmptyState title={t('requests.empty')} />
        ) : (
          <Table
            head={[
              '#',
              t('requests.type'),
              ...(view !== 'mine' ? [t('hr.directory')] : []),
              t('common.date'),
              t('requests.dueAt'),
              t('common.status'),
            ]}
          >
            {q.data.items.map((r) => (
              <tr key={r._id}>
                <Td className="tabular text-xs">
                  <Link to={`/me/requests/${r._id}`} className="text-brand-800 hover:underline">
                    {r.number}
                  </Link>
                </Td>
                <Td className="font-medium">
                  {t(`requests.types.${r.type}`)}
                  {r.flags?.length > 0 && <span className="ms-1 text-xs text-amber-700">⚑</span>}
                </Td>
                {view !== 'mine' && (
                  <Td>
                    {r.employee?.fullNameAr}
                    <div className="text-xs text-slate-500">{r.employee?.employeeNumber}</div>
                  </Td>
                )}
                <Td className="tabular text-xs">{formatDate(r.createdAt)}</Td>
                <Td className="tabular text-xs">
                  {r.dueAt && !r.closedAt ? (
                    <span className={new Date(r.dueAt) < new Date() ? 'font-semibold text-red-700' : ''}>
                      {formatDate(r.dueAt)}
                    </span>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>
                  <Badge tone={stateTone[r.state] ?? 'slate'}>{t(`requests.states.${r.state}`)}</Badge>
                  {r.handoff?.status === 'waiting' && <Badge tone="brand">{t('requests.withFinance')}</Badge>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <NewRequestDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
