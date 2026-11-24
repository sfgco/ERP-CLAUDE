import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { LEAVE_TYPES, type LeaveType } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { useHrLookups } from './_data';

export interface BalanceRow {
  leaveType: LeaveType;
  labelAr: string;
  entitlementDays: number | null;
  accrued: number;
  taken: number;
  balance: number;
  provisional: boolean;
  articleAr?: string;
}
interface Row {
  employee: { _id: string; fullNameAr: string; employeeNumber: string; departmentId: string };
  balances: BalanceRow[];
}
export interface LedgerRow {
  _id: string;
  leaveType: LeaveType;
  entryType: string;
  days: number;
  year: number;
  effectiveAt: string;
  note?: string;
  actorEmail?: string;
}

/** «أرصدة الإجازات» for HR [HR §3.5.1, Q7]: balances per employee and type, opening / adjustment entries, CSV import, the ledger. */
export function LeaveBalancesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const lk = useHrLookups();
  const [search] = useSearchParams();
  const [year, setYear] = useState(Number(riyadhToday().slice(0, 4)));
  const [q, setQ] = useState('');
  const [departmentId, setDepartmentId] = useState(search.get('departmentId') ?? '');
  const [leaveType, setLeaveType] = useState<LeaveType | ''>('annual');
  const params = new URLSearchParams({ year: String(year), limit: '200' });
  if (q.trim()) params.set('q', q.trim());
  if (departmentId) params.set('departmentId', departmentId);
  if (leaveType) params.set('leaveType', leaveType);
  const rows = useQuery({ queryKey: ['leave', 'balances', params.toString()], queryFn: () => get<{ items: Row[]; total: number }>(`/hr/leave/balances?${params}`) });
  const policies = useQuery({ queryKey: ['leave', 'policies'], queryFn: () => get<{ provisional: boolean }>('/hr/leave/policies') });
  const [entry, setEntry] = useState<{ employeeId: string; leaveType: LeaveType; entryType: 'opening' | 'adjustment' | 'carryover' | 'expiry' | 'encashment'; days: string; note: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
  const ledger = useQuery({
    queryKey: ['leave', 'ledger', ledgerFor, year],
    queryFn: () => get<{ items: LedgerRow[] }>(`/hr/leave/ledger?employeeId=${ledgerFor}&year=${year}`),
    enabled: !!ledgerFor,
  });
  const addEntry = useMutation({
    mutationFn: (e: NonNullable<typeof entry>) => post('/hr/leave/balances', { ...e, days: Number(e.days), year }),
    onSuccess: () => {
      toast(t('leave.saved'));
      setEntry(null);
      qc.invalidateQueries({ queryKey: ['leave'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const importMut = useMutation({
    mutationFn: () => {
      const rowsCsv = csv
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split(/[,\t;]/).map((x) => x.trim()))
        .map(([employeeNumber, lt, days, note]) => ({ employeeNumber, leaveType: lt as LeaveType, days: Number(days), note: note || undefined }));
      return post<{ inserted: number; skipped: { employeeNumber: string; reason: string }[] }>('/hr/leave/balances/import', { year, rows: rowsCsv });
    },
    onSuccess: (r) => {
      toast(t('leave.importResult', { inserted: r.inserted, skipped: r.skipped.length }));
      setImportOpen(false);
      setCsv('');
      qc.invalidateQueries({ queryKey: ['leave'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const canEdit = can('hr.leave', 'create');
  const fmt = (n: number | null) => (n === null ? t('leave.unset') : String(n));
  return (
    <>
      <PageHeader
        title={t('leave.title')}
        subtitle={t('leave.hint')}
        actions={
          canEdit && (
            <>
              <Button variant="secondary" onClick={() => setImportOpen(true)}>
                {t('leave.import')}
              </Button>
              <Button onClick={() => setEntry({ employeeId: '', leaveType: 'annual', entryType: 'opening', days: '', note: '' })}>{t('leave.addEntry')}</Button>
            </>
          )
        }
      />
      {policies.data?.provisional && <Alert kind="warning">{t('leave.provisionalPolicies')}</Alert>}
      <Card className="mt-3">
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label={t('leave.year')}>
            <Input type="number" dir="ltr" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <Field label={t('leave.type')}>
            <Select value={leaveType} onChange={(e) => setLeaveType(e.target.value as LeaveType | '')}>
              <option value="">{t('common.all')}</option>
              {LEAVE_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`requests.leaveTypes.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('hr.department')}>
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {lk.departments.map((d) => (
                <option key={d._id} value={d._id}>
                  {d.nameAr}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('actions.search')}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('leave.searchEmployee')} />
          </Field>
        </div>
      </Card>
      <Card className="mt-3">
        {rows.isError ? (
          <QueryError error={rows.error} onRetry={() => rows.refetch()} />
        ) : rows.isLoading ? (
          <Spinner />
        ) : !rows.data?.items.length ? (
          <EmptyState title={t('common.empty')} />
        ) : (
          <Table head={[t('shifts.employee'), t('leave.type'), t('leave.entitlement'), t('leave.accrued'), t('leave.taken'), t('leave.balance'), '']}>
            {rows.data.items.flatMap((r) =>
              r.balances.map((b, i) => (
                <tr key={`${r.employee._id}-${b.leaveType}`}>
                  <Td>
                    {i === 0 && (
                      <>
                        <Link to={`/hr/employees/${r.employee._id}`} className="font-medium text-brand-800 hover:underline">
                          {r.employee.fullNameAr}
                        </Link>
                        <div className="text-xs text-slate-500">
                          {r.employee.employeeNumber} · {lk.deptName(r.employee.departmentId)}
                        </div>
                      </>
                    )}
                  </Td>
                  <Td>
                    {b.labelAr} {b.provisional && <Badge tone="amber">{t('leave.provisional')}</Badge>}
                    {b.articleAr && <div className="text-xs text-slate-400">{b.articleAr}</div>}
                  </Td>
                  <Td className="tabular">{fmt(b.entitlementDays)}</Td>
                  <Td className="tabular">{b.accrued}</Td>
                  <Td className="tabular">{b.taken}</Td>
                  <Td className="tabular font-semibold">{b.entitlementDays === null && b.balance === 0 ? t('leave.unset') : b.balance}</Td>
                  <Td>
                    {i === 0 && (
                      <div className="flex gap-2 text-xs">
                        <button type="button" className="text-brand-700 hover:underline" onClick={() => setLedgerFor(r.employee._id)}>
                          {t('leave.ledger')}
                        </button>
                        {canEdit && (
                          <button type="button" className="text-brand-700 hover:underline" onClick={() => setEntry({ employeeId: r.employee._id, leaveType: (leaveType || 'annual') as LeaveType, entryType: 'adjustment', days: '', note: '' })}>
                            {t('leave.adjust')}
                          </button>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              )),
            )}
          </Table>
        )}
      </Card>

      <Dialog open={!!entry} onClose={() => setEntry(null)} title={t('leave.addEntry')}>
        {entry && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              addEntry.mutate(entry);
            }}
          >
            <Field label={t('shifts.employee')} required>
              <Select value={entry.employeeId} onChange={(e) => setEntry({ ...entry, employeeId: e.target.value })} required>
                <option value="">—</option>
                {[...lk.employees].sort((a, b) => a.fullNameAr.localeCompare(b.fullNameAr, 'ar')).map((e) => (
                  <option key={e._id} value={e._id}>
                    {e.fullNameAr} · {e.employeeNumber}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('leave.type')}>
                <Select value={entry.leaveType} onChange={(e) => setEntry({ ...entry, leaveType: e.target.value as LeaveType })}>
                  {LEAVE_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t(`requests.leaveTypes.${x}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('leave.entryType')}>
                <Select value={entry.entryType} onChange={(e) => setEntry({ ...entry, entryType: e.target.value as typeof entry.entryType })}>
                  {(['opening', 'adjustment', 'carryover', 'expiry', 'encashment'] as const).map((x) => (
                    <option key={x} value={x}>
                      {t(`leave.entryTypes.${x}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t('leave.days')} required hint={t('leave.daysHint')}>
              <Input type="number" dir="ltr" step="0.5" value={entry.days} onChange={(e) => setEntry({ ...entry, days: e.target.value })} required />
            </Field>
            <Field label={t('leave.note')} required>
              <Textarea rows={2} value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} required minLength={2} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setEntry(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" loading={addEntry.isPending} disabled={!entry.employeeId || !entry.days || entry.note.trim().length < 2}>
                {t('actions.save')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog open={importOpen} onClose={() => setImportOpen(false)} title={t('leave.import')}>
        <div className="space-y-3">
          <Alert kind="info">{t('leave.importHint')}</Alert>
          <Field label={t('leave.year')}>
            <Input type="number" dir="ltr" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <Textarea dir="ltr" rows={8} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={t('leave.importPlaceholder')} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setImportOpen(false)}>
              {t('actions.cancel')}
            </Button>
            <Button onClick={() => importMut.mutate()} loading={importMut.isPending} disabled={!csv.trim()}>
              {t('leave.import')}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!ledgerFor} onClose={() => setLedgerFor(null)} title={`${t('leave.ledger')} — ${lk.employeeName(ledgerFor)} · ${year}`}>
        <LedgerList items={ledger.data?.items} loading={ledger.isLoading} />
      </Dialog>
    </>
  );
}

export function LedgerList({ items, loading }: { items?: LedgerRow[]; loading: boolean }) {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  if (loading) return <Spinner />;
  if (!items?.length) return <p className="text-sm text-slate-500">{t('common.empty')}</p>;
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {items.map((l) => (
        <li key={l._id} className="flex items-center justify-between gap-2 py-2">
          <div>
            <div className="font-medium">
              {t(`requests.leaveTypes.${l.leaveType}`)} · {t(`leave.entryTypes.${l.entryType}`)}
            </div>
            <div className="text-xs text-slate-500">
              {formatDate(l.effectiveAt)}
              {l.note ? ` · ${l.note}` : ''}
            </div>
          </div>
          <span className={`tabular font-semibold ${l.days < 0 ? 'text-red-700' : 'text-emerald-700'}`} dir="ltr">
            {l.days > 0 ? `+${l.days}` : l.days}
          </span>
        </li>
      ))}
    </ul>
  );
}
