import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { ATTENDANCE_DAY_STATUSES } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea, cx } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { useHrLookups } from './_data';
import { clock, dayStatusTone, hm, useAttendancePolicy, type AttendanceDayRow, type DaysSummary, type PunchRow } from './_attendance';
import { Kpi } from '../dashboards/_ui';

/**
 * «سجل الحضور» for HR [HR §3.4 رابعاً، خامساً]: every employee's days with filters (period, status, department, branch,
 * employee), the punches behind a day (coordinates visible to HR, audited), the manual punch (Q17) and a recompute.
 */
export function HrAttendancePage() {
  const { t } = useTranslation();
  const { formatDate, formatDateTime } = usePrefs();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const lk = useHrLookups();
  const policy = useAttendancePolicy();
  const [search] = useSearchParams();
  const [from, setFrom] = useState(search.get('from') ?? riyadhToday());
  const [to, setTo] = useState(search.get('to') ?? riyadhToday());
  const [status, setStatus] = useState(search.get('status') ?? '');
  const [departmentId, setDepartmentId] = useState(search.get('departmentId') ?? '');
  const [branchId, setBranchId] = useState('');
  const [employeeId, setEmployeeId] = useState(search.get('employeeId') ?? '');
  const [exceptionsOnly, setExceptionsOnly] = useState(search.get('exceptionsOnly') === '1');
  const params = new URLSearchParams({ from, to, limit: '500' });
  if (status) params.set('status', status);
  if (departmentId) params.set('departmentId', departmentId);
  if (branchId) params.set('branchId', branchId);
  if (employeeId) params.set('employeeId', employeeId);
  if (exceptionsOnly) params.set('exceptionsOnly', 'true');
  const q = useQuery({
    queryKey: ['attendance', 'days', params.toString()],
    queryFn: () => get<{ items: AttendanceDayRow[]; summary: DaysSummary; total: number }>(`/hr/attendance/days?${params}`),
  });
  const [open, setOpen] = useState<AttendanceDayRow | null>(null);
  const punches = useQuery({
    queryKey: ['attendance', 'punches', open?.employeeId, open?.day],
    queryFn: () => get<{ items: PunchRow[] }>(`/hr/attendance/punches?employeeId=${open!.employeeId}&from=${open!.day}&to=${open!.day}`),
    enabled: !!open,
  });
  const [manual, setManual] = useState<{ employeeId: string; type: 'in' | 'out'; at: string; reason: string } | null>(null);
  const manualMut = useMutation({
    mutationFn: (body: NonNullable<typeof manual>) => post('/hr/attendance/punches/manual', { ...body, at: new Date(body.at).toISOString() }),
    onSuccess: () => {
      toast(t('attendance.hr.manualSaved'));
      setManual(null);
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const recompute = useMutation({
    mutationFn: () => post<{ days: number }>('/hr/attendance/recompute', { from, to, ...(employeeId ? { employeeId } : {}) }),
    onSuccess: (r) => {
      toast(t('attendance.hr.recomputed', { days: r.days }));
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const s = q.data?.summary;
  const employeesSorted = [...lk.employees].sort((a, b) => a.fullNameAr.localeCompare(b.fullNameAr, 'ar'));
  return (
    <>
      <PageHeader
        title={t('attendance.hr.title')}
        subtitle={t('attendance.hr.hint')}
        actions={
          <>
            <Link to="/hr/export" className="text-sm text-brand-700 hover:underline">
              {t('attendance.exportLink')}
            </Link>
            {can('hr.attendance', 'edit') && (
              <>
                <Button variant="secondary" onClick={() => recompute.mutate()} loading={recompute.isPending}>
                  {t('attendance.recompute')}
                </Button>
                <Button onClick={() => setManual({ employeeId: employeeId || '', type: 'in', at: `${riyadhToday()}T08:00`, reason: '' })}>
                  {t('attendance.manualPunch')}
                </Button>
              </>
            )}
          </>
        }
      />
      {policy.data?.provisional.shift && <Alert kind="warning">{t('attendance.provisional')} — {t('attendance.provisionalHint')}</Alert>}
      <Card className="mt-3">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Field label={t('attendance.from')}>
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('attendance.to')}>
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label={t('common.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {ATTENDANCE_DAY_STATUSES.map((x) => (
                <option key={x} value={x}>
                  {t(`attendance.statuses.${x}`)}
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
          <Field label={t('hr.branch')}>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {lk.branches.map((d) => (
                <option key={d._id} value={d._id}>
                  {d.nameAr}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('attendance.employee')}>
            <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {employeesSorted.map((e) => (
                <option key={e._id} value={e._id}>
                  {e.fullNameAr}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={exceptionsOnly} onChange={(e) => setExceptionsOnly(e.target.checked)} /> {t('attendance.exceptionsOnly')}
        </label>
      </Card>
      {s && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi to="#" label={t('attendance.scheduledDays')} value={s.scheduledDays} />
          <Kpi to="#" label={t('attendance.presentDays')} value={s.presentDays} tone="green" />
          <Kpi to="#" label={t('attendance.lateDays')} value={s.lateDays} tone={s.lateDays ? 'amber' : 'slate'} hint={t('attendance.minutes', { n: s.lateMinutes })} />
          <Kpi to="#" label={t('attendance.absentDays')} value={s.absentDays} tone={s.absentDays ? 'red' : 'slate'} />
          <Kpi to="#" label={t('attendance.missingDays')} value={s.missingPunchDays} tone={s.missingPunchDays ? 'amber' : 'slate'} />
          <Kpi to="#" label={t('attendance.worked')} value={hm(s.workedMinutes)} hint={`${t('attendance.overtimeApproved')}: ${hm(s.overtimeApprovedMinutes)}`} />
        </div>
      )}
      <Card className="mt-3">
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <EmptyState title={t('common.empty')} />
        ) : (
          <>
            <Table head={[t('attendance.employee'), t('attendance.day'), t('common.status'), t('attendance.firstIn'), t('attendance.lastOut'), t('attendance.worked'), t('attendance.late'), t('attendance.overtime'), '']}>
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
                    {r.flags.filter((f) => f !== 'corrected').length > 0 && (
                      <div className="mt-0.5 text-xs text-slate-500">{r.flags.map((f) => t(`attendance.flags.${f}`, f)).join(' · ')}</div>
                    )}
                  </Td>
                  <Td className="tabular text-xs">{clock(r.firstInAt)}</Td>
                  <Td className="tabular text-xs">{clock(r.lastOutAt)}</Td>
                  <Td className="tabular text-xs">{hm(r.workedMinutes)}</Td>
                  <Td className={cx('tabular text-xs', r.lateMinutes > 0 && 'text-amber-700')}>{r.lateMinutes ? t('attendance.minutes', { n: r.lateMinutes }) : '—'}</Td>
                  <Td className="tabular text-xs">{r.overtimeMinutes ? `${hm(r.overtimeMinutes)} / ${hm(r.overtimeApprovedMinutes)}` : '—'}</Td>
                  <Td>
                    <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setOpen(r)}>
                      {t('attendance.punches')} ({r.punchCount})
                    </button>
                  </Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 text-xs text-slate-500">{t('attendance.hr.total', { count: q.data.total })}</p>
          </>
        )}
      </Card>

      <Dialog open={!!open} onClose={() => setOpen(null)} title={`${t('attendance.punches')} — ${open?.employee?.fullNameAr ?? ''} · ${open ? formatDate(open.day) : ''}`}>
        {punches.isLoading ? (
          <Spinner />
        ) : !punches.data?.items.length ? (
          <p className="text-sm text-slate-500">{t('common.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {punches.data.items.map((p) => (
              <li key={p._id} className="py-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {t(`attendance.punchTypes.${p.type}`)} · <span className="tabular">{formatDateTime(p.at)}</span>
                  </span>
                  <Badge tone={p.withinGeofence === false ? (p.exceptionId ? 'blue' : 'red') : p.withinGeofence ? 'green' : 'slate'}>
                    {p.withinGeofence === null || p.withinGeofence === undefined ? t('attendance.noCheck') : p.withinGeofence ? t('attendance.inside') : p.exceptionId ? t('attendance.outsideWithException') : t('attendance.outside')}
                  </Badge>
                </div>
                <div className="text-xs text-slate-500" dir="ltr">
                  {t(`attendance.sources.${p.source}`, p.source)}
                  {p.siteId ? ` · ${lk.siteName(p.siteId)}` : ''}
                  {typeof p.distanceM === 'number' ? ` · ${p.distanceM} m` : ''}
                  {p.location ? ` · ${p.location.lat.toFixed(5)}, ${p.location.lng.toFixed(5)} (±${p.location.accuracyM ?? '?'} m)` : ''}
                </div>
                {p.reason && <div className="text-xs text-slate-600">{p.reason}</div>}
              </li>
            ))}
          </ul>
        )}
        {open && can('hr.attendance', 'edit') && (
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" onClick={() => setManual({ employeeId: open.employeeId, type: open.firstInAt ? 'out' : 'in', at: `${open.day}T${open.firstInAt ? '16:00' : '08:00'}`, reason: '' })}>
              {t('attendance.manualPunch')}
            </Button>
          </div>
        )}
      </Dialog>

      <Dialog open={!!manual} onClose={() => setManual(null)} title={t('attendance.manualPunch')}>
        {manual && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              manualMut.mutate(manual);
            }}
          >
            <Alert kind="info">{t('attendance.hr.manualHint')}</Alert>
            <Field label={t('attendance.employee')} required>
              <Select value={manual.employeeId} onChange={(e) => setManual({ ...manual, employeeId: e.target.value })} required>
                <option value="">—</option>
                {employeesSorted.map((e) => (
                  <option key={e._id} value={e._id}>
                    {e.fullNameAr} · {e.employeeNumber}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('attendance.punchType')}>
                <Select value={manual.type} onChange={(e) => setManual({ ...manual, type: e.target.value as 'in' | 'out' })}>
                  <option value="in">{t('attendance.punchTypes.in')}</option>
                  <option value="out">{t('attendance.punchTypes.out')}</option>
                </Select>
              </Field>
              <Field label={t('attendance.at')} required>
                <Input type="datetime-local" dir="ltr" value={manual.at} onChange={(e) => setManual({ ...manual, at: e.target.value })} required />
              </Field>
            </div>
            <Field label={t('attendance.manualReason')} required>
              <Textarea rows={2} value={manual.reason} onChange={(e) => setManual({ ...manual, reason: e.target.value })} required minLength={3} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setManual(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" loading={manualMut.isPending} disabled={!manual.employeeId || manual.reason.trim().length < 3}>
                {t('actions.save')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
