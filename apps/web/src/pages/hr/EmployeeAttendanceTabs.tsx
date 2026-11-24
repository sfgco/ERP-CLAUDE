import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { get } from '@/lib/api';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { Badge, Card, Field, Input, QueryError, Spinner, Table, Td, cx } from '@/shared/ui';
import { clock, dayStatusTone, hm, type AttendanceDayRow, type DaysSummary } from './_attendance';
import { LedgerList, type BalanceRow, type LedgerRow } from './LeaveBalancesPage';
import { Kpi } from '../dashboards/_ui';

/** Employee file → tab «الحضور» [HR §3.4, §9.3]: the last 30 days (or a chosen window) with the totals. */
export function EmployeeAttendanceTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const [from, setFrom] = useState(riyadhToday(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(riyadhToday());
  const q = useQuery({
    queryKey: ['attendance', 'days', 'employee', employeeId, from, to],
    queryFn: () => get<{ items: AttendanceDayRow[]; summary: DaysSummary }>(`/hr/attendance/days?employeeId=${employeeId}&from=${from}&to=${to}&limit=100`),
  });
  const s = q.data?.summary;
  return (
    <Card
      title={t('hr.tabs.attendance')}
      actions={
        <Link to={`/hr/attendance?employeeId=${employeeId}&from=${from}&to=${to}`} className="text-sm text-brand-700 hover:underline">
          {t('attendance.hr.title')}
        </Link>
      }
    >
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:max-w-md">
        <Field label={t('attendance.from')}>
          <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t('attendance.to')}>
          <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {s && (
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Kpi to="#" label={t('attendance.presentDays')} value={s.presentDays} tone="green" />
          <Kpi to="#" label={t('attendance.lateDays')} value={s.lateDays} tone={s.lateDays ? 'amber' : 'slate'} />
          <Kpi to="#" label={t('attendance.absentDays')} value={s.absentDays} tone={s.absentDays ? 'red' : 'slate'} />
          <Kpi to="#" label={t('attendance.leaveDays')} value={s.leaveDays} tone="blue" />
          <Kpi to="#" label={t('attendance.worked')} value={hm(s.workedMinutes)} />
        </div>
      )}
      {q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <Spinner />
      ) : !q.data?.items.length ? (
        <p className="text-sm text-slate-500">{t('common.empty')}</p>
      ) : (
        <Table head={[t('attendance.day'), t('common.status'), t('attendance.firstIn'), t('attendance.lastOut'), t('attendance.worked'), t('attendance.late')]}>
          {q.data.items.map((r) => (
            <tr key={r._id}>
              <Td className="tabular text-xs">{formatDate(r.day)}</Td>
              <Td>
                <Badge tone={dayStatusTone[r.status]}>{t(`attendance.statuses.${r.status}`)}</Badge>
              </Td>
              <Td className="tabular text-xs">{clock(r.firstInAt)}</Td>
              <Td className="tabular text-xs">{clock(r.lastOutAt)}</Td>
              <Td className="tabular text-xs">{hm(r.workedMinutes)}</Td>
              <Td className={cx('tabular text-xs', r.lateMinutes > 0 && 'text-amber-700')}>{r.lateMinutes ? t('attendance.minutes', { n: r.lateMinutes }) : '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/** Employee file → tab «الإجازات» [HR §3.5.1]: balances per type for a year and the ledger behind them. */
export function EmployeeLeaveTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const [year, setYear] = useState(Number(riyadhToday().slice(0, 4)));
  const balances = useQuery({
    queryKey: ['leave', 'balances', 'employee', employeeId, year],
    queryFn: () => get<{ items: { balances: BalanceRow[] }[] }>(`/hr/leave/balances?employeeId=${employeeId}&year=${year}`),
  });
  const ledger = useQuery({
    queryKey: ['leave', 'ledger', employeeId, year],
    queryFn: () => get<{ items: LedgerRow[] }>(`/hr/leave/ledger?employeeId=${employeeId}&year=${year}`),
  });
  const rows = balances.data?.items[0]?.balances ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Card
        title={t('hr.tabs.leave')}
        actions={
          <Field label={t('leave.year')}>
            <Input type="number" dir="ltr" className="w-24" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
        }
      >
        {balances.isLoading ? (
          <Spinner />
        ) : (
          <Table head={[t('leave.type'), t('leave.entitlement'), t('leave.accrued'), t('leave.taken'), t('leave.balance')]}>
            {rows
              .filter((b) => b.entitlementDays !== null || b.accrued || b.taken)
              .map((b) => (
                <tr key={b.leaveType}>
                  <Td>
                    {b.labelAr} {b.provisional && <Badge tone="amber">{t('leave.provisional')}</Badge>}
                  </Td>
                  <Td className="tabular">{b.entitlementDays === null ? t('leave.unset') : b.entitlementDays}</Td>
                  <Td className="tabular">{b.accrued}</Td>
                  <Td className="tabular">{b.taken}</Td>
                  <Td className="tabular font-semibold">{b.balance}</Td>
                </tr>
              ))}
          </Table>
        )}
      </Card>
      <Card title={t('leave.ledger')}>
        <LedgerList items={ledger.data?.items} loading={ledger.isLoading} />
      </Card>
    </div>
  );
}
