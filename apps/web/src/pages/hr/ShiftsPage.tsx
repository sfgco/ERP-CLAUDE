import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SHIFT_KINDS, type ShiftKind } from '@eayni/shared';
import { get, patch, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { useHrLookups } from './_data';

interface Period {
  start: string;
  end: string;
  crossesMidnight?: boolean;
}
interface Shift {
  _id: string;
  code: string;
  nameAr: string;
  kind: ShiftKind;
  periods: Period[];
  ramadanPeriods: Period[];
  workDays: number[];
  graceMinutes?: number | null;
  active: boolean;
  version: number;
  notes?: string;
}
interface Assignment {
  _id: string;
  employeeId: string;
  shiftId: string;
  siteIds: string[];
  fromDay: string;
  toDay: string | null;
  reason?: string;
}
type ShiftForm = Omit<Shift, '_id' | 'version'>;
const EMPTY: ShiftForm = { code: '', nameAr: '', kind: 'fixed', periods: [{ start: '08:00', end: '16:00', crossesMidnight: false }], ramadanPeriods: [], workDays: [0, 1, 2, 3, 4], graceMinutes: null, active: true, notes: '' };
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** «إعداد أوقات العمل» [HR §3.4 أولاً]: shifts with their periods, Ramadan hours and work days; employee assignments with sites. */
export function ShiftsPage() {
  const { t } = useTranslation();
  const { formatDate } = usePrefs();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const lk = useHrLookups();
  const shifts = useQuery({ queryKey: ['shifts', 'all'], queryFn: () => get<{ items: Shift[]; defaultShiftCode: string | null; defaultShiftProvisional: boolean }>('/hr/shifts?all=true') });
  const current = useQuery({ queryKey: ['shifts', 'assignments', 'current'], queryFn: () => get<{ items: Assignment[] }>('/hr/shifts/assignments') });
  const [edit, setEdit] = useState<{ id?: string; form: ShiftForm } | null>(null);
  const [assign, setAssign] = useState<{ employeeId: string; shiftId: string; siteIds: string[]; from: string; reason: string } | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ['shifts', 'assignments', historyFor],
    queryFn: () => get<{ items: Assignment[] }>(`/hr/shifts/assignments?employeeId=${historyFor}`),
    enabled: !!historyFor,
  });
  const save = useMutation({
    mutationFn: ({ id, form }: { id?: string; form: ShiftForm }) => {
      const body = { ...form, graceMinutes: form.graceMinutes === null || (form.graceMinutes as unknown) === '' ? null : Number(form.graceMinutes), notes: form.notes || undefined };
      return id ? patch(`/hr/shifts/${id}`, body) : post('/hr/shifts', body);
    },
    onSuccess: () => {
      toast(t('shifts.saved'));
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['shifts'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const assignMut = useMutation({
    mutationFn: (body: NonNullable<typeof assign>) => post('/hr/shifts/assignments', { ...body, reason: body.reason || undefined }),
    onSuccess: () => {
      toast(t('shifts.assignSaved'));
      setAssign(null);
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const shiftName = (id: string) => shifts.data?.items.find((s) => s._id === id)?.nameAr ?? '—';
  const assignedCount = (shiftId: string) => current.data?.items.filter((a) => a.shiftId === shiftId).length ?? 0;
  const periodsText = (ps: Period[]) => ps.map((p) => `${p.start}–${p.end}${p.crossesMidnight ? ' (+1)' : ''}`).join(t('common.listSeparator'));
  const canEdit = can('hr.shifts', 'create');

  return (
    <>
      <PageHeader
        title={t('shifts.title')}
        subtitle={t('shifts.hint')}
        actions={
          canEdit && (
            <>
              <Button variant="secondary" onClick={() => setAssign({ employeeId: '', shiftId: shifts.data?.items[0]?._id ?? '', siteIds: [], from: riyadhToday(), reason: '' })}>
                {t('shifts.assign')}
              </Button>
              <Button onClick={() => setEdit({ form: { ...EMPTY } })}>{t('shifts.new')}</Button>
            </>
          )
        }
      />
      {shifts.data?.defaultShiftProvisional && <Alert kind="warning">{t('shifts.provisionalDefault')}</Alert>}
      <div className="mt-3 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Card title={t('shifts.list')}>
          {shifts.isError ? (
            <QueryError error={shifts.error} onRetry={() => shifts.refetch()} />
          ) : shifts.isLoading ? (
            <Spinner />
          ) : !shifts.data?.items.length ? (
            <EmptyState title={t('shifts.none')} />
          ) : (
            <Table head={[t('shifts.name'), t('shifts.kind'), t('shifts.periods'), t('shifts.workDays'), t('shifts.assignedCountHead'), '']}>
              {shifts.data.items.map((s) => (
                <tr key={s._id}>
                  <Td>
                    <div className="font-medium">
                      {s.nameAr} {shifts.data!.defaultShiftCode === s.code && <Badge tone="brand">{t('shifts.defaultBadge')}</Badge>}
                      {!s.active && <Badge>{t('common.inactive')}</Badge>}
                    </div>
                    <div className="text-xs text-slate-500" dir="ltr">
                      {s.code} · v{s.version}
                    </div>
                  </Td>
                  <Td>{t(`shifts.kinds.${s.kind}`)}</Td>
                  <Td className="text-xs">
                    <div dir="ltr" className="text-start">
                      {periodsText(s.periods)}
                    </div>
                    {s.ramadanPeriods.length > 0 && (
                      <div className="text-slate-500">
                        {t('shifts.ramadanPeriods')}: <span dir="ltr">{periodsText(s.ramadanPeriods)}</span>
                      </div>
                    )}
                    {s.graceMinutes !== null && s.graceMinutes !== undefined && <div className="text-slate-500">{t('shifts.graceShort', { n: s.graceMinutes })}</div>}
                  </Td>
                  <Td className="text-xs">{s.workDays.map((d) => t(`shifts.days.${d}`)).join(t('common.listSeparator'))}</Td>
                  <Td className="tabular">{t('shifts.assignedCount', { count: assignedCount(s._id) })}</Td>
                  <Td>
                    {canEdit && (
                      <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setEdit({ id: s._id, form: { code: s.code, nameAr: s.nameAr, kind: s.kind, periods: s.periods, ramadanPeriods: s.ramadanPeriods, workDays: s.workDays, graceMinutes: s.graceMinutes ?? null, active: s.active, notes: s.notes ?? '' } })}>
                        {t('actions.edit')}
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title={t('shifts.assignments')}>
          <p className="mb-2 text-xs text-slate-500">{t('shifts.assignmentsHint')}</p>
          {current.isLoading ? (
            <Spinner />
          ) : !current.data?.items.length ? (
            <EmptyState title={t('shifts.noAssignments')} hint={t('shifts.noAssignmentsHint')} />
          ) : (
            <Table head={[t('shifts.employee'), t('shifts.shift'), t('shifts.sites'), t('shifts.from'), '']}>
              {current.data.items.map((a) => (
                <tr key={a._id}>
                  <Td className="font-medium">{lk.employeeName(a.employeeId) || '—'}</Td>
                  <Td>{shiftName(a.shiftId)}</Td>
                  <Td className="text-xs">{a.siteIds.length ? a.siteIds.map((s) => lk.siteName(s)).join(t('common.listSeparator')) : t('shifts.siteFromFile')}</Td>
                  <Td className="tabular text-xs">{formatDate(a.fromDay)}</Td>
                  <Td>
                    <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setHistoryFor(a.employeeId)}>
                      {t('shifts.history')}
                    </button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* Shift editor */}
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t('shifts.edit') : t('shifts.new')}>
        {edit && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(edit);
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('shifts.code')} required hint={t('shifts.codeHint')}>
                <Input dir="ltr" value={edit.form.code} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, code: e.target.value } })} required pattern="[a-z0-9_]+" />
              </Field>
              <Field label={t('shifts.name')} required>
                <Input value={edit.form.nameAr} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, nameAr: e.target.value } })} required />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('shifts.kind')}>
                <Select value={edit.form.kind} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, kind: e.target.value as ShiftKind } })}>
                  {SHIFT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`shifts.kinds.${k}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('shifts.grace')} hint={t('shifts.graceHint')}>
                <Input type="number" dir="ltr" min={0} max={120} value={edit.form.graceMinutes ?? ''} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, graceMinutes: e.target.value === '' ? null : Number(e.target.value) } })} />
              </Field>
            </div>
            <PeriodsEditor label={t('shifts.periods')} periods={edit.form.periods} min={1} onChange={(periods) => setEdit({ ...edit, form: { ...edit.form, periods } })} />
            <PeriodsEditor label={t('shifts.ramadanPeriods')} periods={edit.form.ramadanPeriods} min={0} onChange={(ramadanPeriods) => setEdit({ ...edit, form: { ...edit.form, ramadanPeriods } })} />
            <Field label={t('shifts.workDays')}>
              <div className="flex flex-wrap gap-2 text-sm">
                {WEEKDAYS.map((d) => (
                  <label key={d} className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1">
                    <input
                      type="checkbox"
                      checked={edit.form.workDays.includes(d)}
                      onChange={(e) => setEdit({ ...edit, form: { ...edit.form, workDays: e.target.checked ? [...edit.form.workDays, d].sort() : edit.form.workDays.filter((x) => x !== d) } })}
                    />
                    {t(`shifts.days.${d}`)}
                  </label>
                ))}
              </div>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={edit.form.active} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, active: e.target.checked } })} /> {t('common.active')}
            </label>
            <Field label={t('hr.notes')}>
              <Textarea rows={2} value={edit.form.notes ?? ''} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, notes: e.target.value } })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setEdit(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={!edit.form.workDays.length || !edit.form.periods.length}>
                {t('actions.save')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* Assignment */}
      <Dialog open={!!assign} onClose={() => setAssign(null)} title={t('shifts.assign')}>
        {assign && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              assignMut.mutate(assign);
            }}
          >
            <Field label={t('shifts.employee')} required>
              <Select value={assign.employeeId} onChange={(e) => setAssign({ ...assign, employeeId: e.target.value })} required>
                <option value="">—</option>
                {[...lk.employees].sort((a, b) => a.fullNameAr.localeCompare(b.fullNameAr, 'ar')).map((e) => (
                  <option key={e._id} value={e._id}>
                    {e.fullNameAr} · {e.employeeNumber}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('shifts.shift')} required>
              <Select value={assign.shiftId} onChange={(e) => setAssign({ ...assign, shiftId: e.target.value })} required>
                {shifts.data?.items.filter((s) => s.active).map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.nameAr}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('shifts.sites')} hint={t('shifts.sitesHint')}>
              <div className="flex flex-wrap gap-2 text-sm">
                {lk.sites.map((s) => (
                  <label key={s._id} className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1">
                    <input type="checkbox" checked={assign.siteIds.includes(s._id)} onChange={(e) => setAssign({ ...assign, siteIds: e.target.checked ? [...assign.siteIds, s._id] : assign.siteIds.filter((x) => x !== s._id) })} />
                    {s.nameAr}
                  </label>
                ))}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('shifts.from')} required>
                <Input type="date" dir="ltr" value={assign.from} onChange={(e) => setAssign({ ...assign, from: e.target.value })} required />
              </Field>
              <Field label={t('shifts.reason')}>
                <Input value={assign.reason} onChange={(e) => setAssign({ ...assign, reason: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAssign(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" loading={assignMut.isPending} disabled={!assign.employeeId || !assign.shiftId}>
                {t('shifts.assign')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* History */}
      <Dialog open={!!historyFor} onClose={() => setHistoryFor(null)} title={`${t('shifts.history')} — ${lk.employeeName(historyFor)}`}>
        {history.isLoading ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {history.data?.items.map((a) => (
              <li key={a._id} className="py-2">
                <div className="font-medium">{shiftName(a.shiftId)}</div>
                <div className="text-xs text-slate-500 tabular">
                  {formatDate(a.fromDay)} → {a.toDay ? formatDate(a.toDay) : t('shifts.current')}
                  {a.reason ? ` · ${a.reason}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}

function PeriodsEditor({ label, periods, min, onChange }: { label: string; periods: Period[]; min: number; onChange: (p: Period[]) => void }) {
  const { t } = useTranslation();
  const set = (i: number, patchP: Partial<Period>) => onChange(periods.map((p, j) => (j === i ? { ...p, ...patchP } : p)));
  return (
    <Field label={label}>
      <div className="space-y-2">
        {periods.map((p, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <Input type="time" dir="ltr" className="w-28" value={p.start} onChange={(e) => set(i, { start: e.target.value })} required />
            <span>–</span>
            <Input type="time" dir="ltr" className="w-28" value={p.end} onChange={(e) => set(i, { end: e.target.value })} required />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={!!p.crossesMidnight} onChange={(e) => set(i, { crossesMidnight: e.target.checked })} /> {t('shifts.crossesMidnight')}
            </label>
            {periods.length > min && (
              <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => onChange(periods.filter((_, j) => j !== i))}>
                {t('actions.delete')}
              </button>
            )}
          </div>
        ))}
        {periods.length < 4 && (
          <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => onChange([...periods, { start: '08:00', end: '16:00', crossesMidnight: false }])}>
            {t('shifts.addPeriod')}
          </button>
        )}
      </div>
    </Field>
  );
}
