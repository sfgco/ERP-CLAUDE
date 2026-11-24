import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { get } from '@/lib/api';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { Badge, Card, EmptyState, Field, Input, PageHeader, QueryError, Spinner, Table, Td, cx } from '@/shared/ui';
import { clock, dayStatusTone, hm, type AttendanceDayRow, type DaysSummary } from '../hr/_attendance';
import { Kpi } from '../dashboards/_ui';

/**
 * «حضور فريقي» [HR §3.4 رابعاً, §6]: the direct manager's (or department manager's) view of the team's days — status,
 * lateness, hours — with no coordinates (HR_PLAN §10.10). Corrections to approve live in «طلبات فريقي».
 */
export function TeamAttendancePage() {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const [from, setFrom] = useState(riyadhToday());
  const [to, setTo] = useState(riyadhToday());
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const q = useQuery({
    queryKey: ['attendance', 'team', from, to, exceptionsOnly],
    queryFn: () =>
      get<{ items: AttendanceDayRow[]; summary: DaysSummary; total: number }>(
        `/hr/attendance/days?from=${from}&to=${to}&limit=500${exceptionsOnly ? '&exceptionsOnly=true' : ''}`,
      ),
  });
  const s = q.data?.summary;
  return (
    <>
      <PageHeader title={t('attendance.team.title')} subtitle={t('attendance.team.hint')} />
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <Field label={t('attendance.from')}>
          <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t('attendance.to')}>
          <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={exceptionsOnly} onChange={(e) => setExceptionsOnly(e.target.checked)} /> {t('attendance.exceptionsOnly')}
        </label>
        <Link to="/manager/requests" className="self-end pb-2 text-sm text-brand-700 hover:underline">
          {t('attendance.team.correctionsLink')}
        </Link>
      </div>
      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Kpi to="#" label={t('attendance.presentDays')} value={s.presentDays} tone="green" />
          <Kpi to="#" label={t('attendance.lateDays')} value={s.lateDays} tone={s.lateDays ? 'amber' : 'slate'} />
          <Kpi to="#" label={t('attendance.absentDays')} value={s.absentDays} tone={s.absentDays ? 'red' : 'slate'} />
          <Kpi to="#" label={t('attendance.missingDays')} value={s.missingPunchDays} tone={s.missingPunchDays ? 'amber' : 'slate'} />
          <Kpi to="#" label={t('attendance.worked')} value={hm(s.workedMinutes)} />
        </div>
      )}
      <Card>
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <EmptyState title={t('common.empty')} />
        ) : (
          <Table head={[t('attendance.employee'), t('attendance.day'), t('common.status'), t('attendance.firstIn'), t('attendance.lastOut'), t('attendance.worked'), t('attendance.late')]}>
            {q.data.items.map((r) => (
              <tr key={r._id}>
                <Td>
                  <Link to={`/hr/employees/${r.employeeId}`} className="font-medium text-brand-800 hover:underline">
                    {r.employee?.fullNameAr ?? '—'}
                  </Link>
                  <div className="text-xs text-slate-500">{r.employee?.employeeNumber}</div>
                </Td>
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
    </>
  );
}
