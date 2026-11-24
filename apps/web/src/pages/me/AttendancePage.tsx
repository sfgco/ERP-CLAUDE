import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Clock, LogIn, LogOut, MapPin } from 'lucide-react';
import type { HrRequestType } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { Alert, Badge, Button, Card, PageHeader, QueryError, Spinner, Table, Td, cx } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { NewRequestDialog } from '../requests/NewRequestDialog';
import { clock, dayStatusTone, hm, hours, useAttendancePolicy, type AttendanceDayRow, type DaysSummary, type PunchRow } from '../hr/_attendance';

interface Me {
  today: string;
  now: string;
  day: AttendanceDayRow;
  schedule: null | { nameAr: string; kind: string; isWorkDay: boolean; window: { start: string; end: string } | null; ramadan: boolean; fromAssignment: boolean };
  sites: { _id: string; nameAr: string; hasLocation: boolean; radiusM: number | null }[];
  exception: null | { scope: string; fromDay: string; toDay: string };
  punches: PunchRow[];
  nextPunch: 'in' | 'out';
  month: DaysSummary & { from: string; to: string };
  provisional: boolean;
}
interface Verdict {
  reason: 'ok' | 'outside' | 'no_location' | 'inaccurate' | 'no_site';
  siteName?: string;
  distanceM?: number;
  radiusM?: number;
  within: boolean | null;
}
type Geo = { lat: number; lng: number; accuracyM?: number };

function readLocation(): Promise<{ location?: Geo; error?: 'denied' | 'unavailable' | 'timeout' }> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve({ error: 'unavailable' });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ location: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy) } }),
      (err) => resolve({ error: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
    );
  });
}
const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * «واجهة تسجيل الحضور والانصراف» [HR §3.4 ثالثاً], phone-first: the two buttons, live clock, location check, today's
 * state, hours / lateness / overtime, the history, and the correction request. Location is read only when a button is
 * pressed (the spec's privacy note) and the server stamps the time.
 */
export function AttendancePage() {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['attendance', 'me'], queryFn: () => get<Me>('/hr/attendance/me'), refetchInterval: 60_000 });
  const policy = useAttendancePolicy();
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    const h = setInterval(() => setTick(new Date()), 1000);
    return () => clearInterval(h);
  }, []);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<HrRequestType | null>(null);
  const [range, setRange] = useState<'month' | 'last30'>('month');
  const days = useQuery({
    queryKey: ['attendance', 'me', 'days', range],
    queryFn: () => {
      const today = riyadhToday();
      const from = range === 'month' ? `${today.slice(0, 7)}-01` : riyadhToday(new Date(Date.now() - 30 * 86_400_000));
      return get<{ items: AttendanceDayRow[]; summary: DaysSummary }>(`/hr/attendance/me/days?from=${from}&to=${today}`);
    },
  });
  const punch = useMutation({
    mutationFn: async (type: 'in' | 'out') => {
      setLocating(true);
      setLocError(null);
      const loc = await readLocation();
      setLocating(false);
      if (loc.location) {
        const check = await post<Verdict>('/hr/attendance/me/check', { location: loc.location }).catch(() => null);
        if (check) setVerdict(check);
      }
      return post<{ punch: PunchRow; day: AttendanceDayRow; verdict: Verdict; duplicate: boolean }>('/hr/attendance/me/punch', {
        type,
        location: loc.location ?? null,
        locationError: loc.error,
        idempotencyKey: newKey(),
        source: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'web',
      });
    },
    onSuccess: (r) => {
      setVerdict(r.verdict);
      toast(t('attendance.punched', { type: t(`attendance.punchTypes.${r.punch.type}`), time: clock(r.punch.at) }));
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e: unknown) => {
      const err = e as { message?: string; details?: { code?: string } };
      setLocError(err.message ?? t('common.error'));
    },
  });

  const clockFmt = useMemo(() => new Intl.DateTimeFormat('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }), []);
  if (me.isError) return <QueryError error={me.error} onRetry={() => me.refetch()} />;
  if (!me.data) return <Spinner />;
  const d = me.data;
  const next = d.nextPunch;
  const verdictText = (v: Verdict) =>
    v.reason === 'ok'
      ? t('attendance.locationOk', { distance: v.distanceM, site: v.siteName })
      : v.reason === 'outside'
        ? t('attendance.locationOutside', { distance: v.distanceM, site: v.siteName, radius: v.radiusM })
        : v.reason === 'no_site'
          ? t('attendance.locationNoSite')
          : t('attendance.locationUnavailable');

  return (
    <>
      <PageHeader title={t('attendance.title')} subtitle={t('attendance.hint')} />
      {d.provisional && <Alert kind="warning">{t('attendance.provisional')} — {t('attendance.provisionalHint')}</Alert>}
      <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        {/* The punch card: clock, schedule, the two buttons, the location verdict */}
        <Card>
          <div className="text-center">
            <div className="text-xs text-slate-500">{formatDate(tick, { dateStyle: 'full' })}</div>
            <div className="mt-1 flex items-center justify-center gap-2 text-4xl font-bold tabular text-slate-900" dir="ltr">
              <Clock className="size-7 text-brand-600" aria-hidden /> {clockFmt.format(tick)}
            </div>
            <div className="mt-2 text-sm text-slate-600">
              {d.schedule
                ? d.schedule.window
                  ? `${d.schedule.nameAr} · ${t('attendance.window', { start: clock(d.schedule.window.start), end: clock(d.schedule.window.end) })}${d.schedule.ramadan ? ` · ${t('attendance.ramadan')}` : ''}`
                  : `${d.schedule.nameAr} · ${t('attendance.notWorkDay')}`
                : t('attendance.noSchedule')}
            </div>
            {d.exception && (
              <div className="mt-1 text-xs text-sky-800">{t('attendance.exceptionActive', { scope: t(`requests.exceptionScopes.${d.exception.scope}`), to: d.exception.toDay })}</div>
            )}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Button
              className={cx('h-16 text-lg', next !== 'in' && 'opacity-50')}
              disabled={next !== 'in' || punch.isPending}
              loading={punch.isPending && punch.variables === 'in'}
              onClick={() => punch.mutate('in')}
            >
              <LogIn className="size-5" aria-hidden /> {t('attendance.checkIn')}
            </Button>
            <Button
              variant="secondary"
              className={cx('h-16 text-lg', next !== 'out' && 'opacity-50')}
              disabled={next !== 'out' || punch.isPending}
              loading={punch.isPending && punch.variables === 'out'}
              onClick={() => punch.mutate('out')}
            >
              <LogOut className="size-5" aria-hidden /> {t('attendance.checkOut')}
            </Button>
          </div>
          <div className="mt-3 min-h-6 text-sm">
            {locating && <span className="text-slate-500">{t('attendance.locating')}</span>}
            {!locating && verdict && (
              <span className={cx('flex items-center gap-1', verdict.reason === 'ok' ? 'text-emerald-700' : verdict.reason === 'no_site' ? 'text-slate-600' : 'text-red-700')}>
                <MapPin className="size-4" aria-hidden /> {verdictText(verdict)}
              </span>
            )}
          </div>
          {locError && <Alert kind="error">{locError}</Alert>}
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('attendance.statusToday')}</span>
              <Badge tone={dayStatusTone[d.day.status]}>{t(`attendance.statuses.${d.day.status}`)}</Badge>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 tabular">
              <dt className="text-slate-500">{t('attendance.firstIn')}</dt>
              <dd>{clock(d.day.firstInAt)}</dd>
              <dt className="text-slate-500">{t('attendance.lastOut')}</dt>
              <dd>{clock(d.day.lastOutAt)}</dd>
              <dt className="text-slate-500">{t('attendance.worked')}</dt>
              <dd>{hm(d.day.workedMinutes)}</dd>
              <dt className="text-slate-500">{t('attendance.late')}</dt>
              <dd className={d.day.lateMinutes ? 'text-amber-700' : ''}>{t('attendance.minutes', { n: d.day.lateMinutes })}</dd>
              <dt className="text-slate-500">{t('attendance.overtime')}</dt>
              <dd>
                {hm(d.day.overtimeMinutes)}
                {d.day.overtimeApprovedMinutes ? ` (${t('attendance.overtimeApproved')}: ${hm(d.day.overtimeApprovedMinutes)})` : ''}
              </dd>
            </dl>
            {d.punches.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 text-xs text-slate-600">
                {d.punches.map((p) => (
                  <span key={p._id} className="rounded bg-white px-2 py-0.5 tabular">
                    {t(`attendance.punchTypes.${p.type}`)} {clock(p.at)}
                    {p.withinGeofence === false ? ' ⚠' : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
          {d.sites.length > 0 && (
            <div className="mt-3 text-xs text-slate-500">
              {t('attendance.sites')}: {d.sites.map((s) => `${s.nameAr}${s.radiusM ? ` (${t('attendance.metersShort', { n: s.radiusM })})` : ''}`).join(t('common.listSeparator'))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setDialog('attendance_correction')}>
              {t('attendance.requestCorrection')}
            </Button>
            <Button variant="secondary" onClick={() => setDialog('geofence_exception')}>
              {t('attendance.requestException')}
            </Button>
            <Button variant="secondary" onClick={() => setDialog('overtime')}>
              {t('attendance.requestOvertime')}
            </Button>
          </div>
        </Card>

        {/* The month cards and the history */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={t('attendance.worked')} value={`${hours(d.month.workedMinutes)} ${t('attendance.hoursUnit')}`} />
            <Stat label={t('attendance.presentDays')} value={d.month.presentDays} tone="green" />
            <Stat label={t('attendance.lateDays')} value={d.month.lateDays} tone={d.month.lateDays ? 'amber' : 'slate'} hint={t('attendance.minutes', { n: d.month.lateMinutes })} />
            <Stat label={t('attendance.absentDays')} value={d.month.absentDays} tone={d.month.absentDays ? 'red' : 'slate'} />
            <Stat label={t('attendance.missingDays')} value={d.month.missingPunchDays} tone={d.month.missingPunchDays ? 'amber' : 'slate'} />
            <Stat label={t('attendance.overtime')} value={hm(d.month.overtimeApprovedMinutes)} hint={t('attendance.overtimeApproved')} />
          </div>
          <Card
            title={t('attendance.history')}
            actions={
              <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs" role="group">
                {(['month', 'last30'] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setRange(k)} className={cx('rounded-md px-2.5 py-1', range === k ? 'bg-brand-700 text-white' : 'text-slate-600')}>
                    {t(k === 'month' ? 'attendance.month' : 'attendance.last30')}
                  </button>
                ))}
              </div>
            }
          >
            {days.isLoading ? (
              <Spinner />
            ) : !days.data?.items.length ? (
              <p className="text-sm text-slate-500">{t('common.empty')}</p>
            ) : (
              <Table head={[t('attendance.day'), t('common.status'), t('attendance.firstIn'), t('attendance.lastOut'), t('attendance.worked'), t('attendance.late')]}>
                {days.data.items.map((r) => (
                  <tr key={r._id}>
                    <Td className="tabular text-xs">{formatDate(r.day)}</Td>
                    <Td>
                      <Badge tone={dayStatusTone[r.status]}>{t(`attendance.statuses.${r.status}`)}</Badge>
                      {r.flags.includes('corrected') && <span className="ms-1 text-xs text-slate-500">{t('attendance.flags.corrected')}</span>}
                    </Td>
                    <Td className="tabular text-xs">{clock(r.firstInAt)}</Td>
                    <Td className="tabular text-xs">{clock(r.lastOutAt)}</Td>
                    <Td className="tabular text-xs">{hm(r.workedMinutes)}</Td>
                    <Td className={cx('tabular text-xs', r.lateMinutes > 0 && 'text-amber-700')}>{r.lateMinutes ? t('attendance.minutes', { n: r.lateMinutes }) : '—'}</Td>
                  </tr>
                ))}
              </Table>
            )}
            <p className="mt-2 text-xs text-slate-500">
              <Link to="/me/requests" className="text-brand-700 hover:underline">
                {t('attendance.myRequestsLink')}
              </Link>
              {policy.data && ` · ${t('attendance.correctionDeadline', { days: policy.data.correction.deadlineDays })}`}
            </p>
          </Card>
        </div>
      </div>
      <NewRequestDialog open={!!dialog} onClose={() => setDialog(null)} initialType={dialog ?? undefined} />
    </>
  );
}

function Stat({ label, value, tone = 'slate', hint }: { label: string; value: string | number; tone?: 'slate' | 'green' | 'amber' | 'red'; hint?: string }) {
  const tones = { slate: 'text-slate-900', green: 'text-emerald-700', amber: 'text-amber-700', red: 'text-red-700' };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={cx('mt-1 text-xl font-bold tabular', tones[tone])}>{value}</div>
      {hint && <div className="text-xs text-slate-400">{hint}</div>}
    </div>
  );
}
