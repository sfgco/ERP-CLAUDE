import type { ReactNode } from 'react';
import type { FieldErrors, UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { CORRECTION_KINDS, EXCEPTION_SCOPES, LEAVE_TYPES, LEAVE_TYPES_WITH_EVENT, type HrRequestType, type LeaveType } from '@eayni/shared';
import { useSites } from '@/lib/lookups';
import { Alert, Field, Input, Select, Textarea } from '@/shared/ui';

/** Flat form values for every request type; `detailsFromForm` / `formFromDetails` map to the API shape. */
export type RequestFormValues = Record<string, string | boolean>;

/** Form values → `details` as HR §3.5 lists them per type (shared by "new" and "resubmit", review C19). */
export function detailsFromForm(type: HrRequestType, v: RequestFormValues): Record<string, unknown> {
  const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
  switch (type) {
    case 'leave':
      return {
        leaveType: s('leaveType'),
        startDate: s('startDate'),
        endDate: s('endDate'),
        reason: s('reason'),
        eventDate: s('eventDate') || undefined,
      };
    case 'permission':
      return { date: s('date'), startTime: s('startTime'), endTime: s('endTime'), reason: s('reason') };
    case 'remote_work':
      return { startDate: s('startDate'), days: Number(s('days')), reason: s('reason') };
    case 'salary_certificate':
      return {
        addressedTo: s('addressedTo'),
        purpose: s('purpose'),
        detailed: !!v.detailed,
        chamberAttestation: !!v.chamberAttestation,
      };
    case 'experience_certificate':
      return { purpose: s('purpose') };
    case 'advance':
      return {
        amountHalalas: Math.round(Number(s('amount')) * 100),
        reason: s('reason'),
        notes: s('notes') || undefined,
        instalments: s('instalments') ? Number(s('instalments')) : undefined,
        // Owner decision 2026-11-24: written consent to a schedule whose instalment exceeds 10 % of the wage.
        scheduleConsent: v.scheduleConsent === true ? true : undefined,
      };
    case 'data_update':
      return {
        changes: [
          { field: s('field'), currentValue: s('currentValue') || undefined, newValue: s('newValue') },
        ],
        reason: s('reason') || undefined,
      };
    case 'official_letter':
      return { letterType: s('letterType'), addressedTo: s('addressedTo'), purpose: s('purpose') };
    // H2 [HR §3.4 ثالثاً، ثانياً 6; Q16]
    case 'attendance_correction':
      return {
        day: s('day'),
        kind: s('kind') || 'missing_out',
        requestedTime: s('requestedTime'),
        punchId: s('punchId') || undefined,
        reason: s('reason'),
      };
    case 'geofence_exception':
      return { from: s('from'), to: s('to'), scope: s('scope') || 'any_location', siteId: s('siteId') || undefined, reason: s('reason') };
    case 'overtime':
      return {
        day: s('day'),
        startTime: s('startTime'),
        endTime: s('endTime'),
        reason: s('reason'),
        compensation: s('compensation') || undefined,
      };
  }
}

/** Stored `details` → form values, for editing a returned request. */
export function formFromDetails(type: HrRequestType, d: Record<string, unknown>): RequestFormValues {
  const out: RequestFormValues = {};
  const str = (k: string) => (d[k] === undefined || d[k] === null ? '' : String(d[k]));
  const date = (k: string) => (d[k] ? String(d[k]).slice(0, 10) : '');
  switch (type) {
    case 'leave':
      Object.assign(out, {
        leaveType: str('leaveType'),
        startDate: date('startDate'),
        endDate: date('endDate'),
        reason: str('reason'),
        eventDate: date('eventDate'),
      });
      break;
    case 'permission':
      Object.assign(out, {
        date: date('date'),
        startTime: str('startTime'),
        endTime: str('endTime'),
        reason: str('reason'),
      });
      break;
    case 'remote_work':
      Object.assign(out, { startDate: date('startDate'), days: str('days'), reason: str('reason') });
      break;
    case 'salary_certificate':
      Object.assign(out, {
        addressedTo: str('addressedTo'),
        purpose: str('purpose'),
        detailed: !!d.detailed,
        chamberAttestation: !!d.chamberAttestation,
      });
      break;
    case 'experience_certificate':
      out.purpose = str('purpose');
      break;
    case 'advance':
      Object.assign(out, {
        amount: typeof d.amountHalalas === 'number' ? String(d.amountHalalas / 100) : '',
        reason: str('reason'),
        notes: str('notes'),
        instalments: typeof d.requestedInstalments === 'number' ? String(d.requestedInstalments) : typeof d.instalments === 'number' ? String(d.instalments) : '',
        scheduleConsent: d.scheduleConsent === true,
      });
      break;
    case 'data_update': {
      const c = (Array.isArray(d.changes) ? d.changes[0] : {}) as Record<string, unknown>;
      Object.assign(out, {
        field: c.field ? String(c.field) : '',
        currentValue: c.currentValue ? String(c.currentValue) : '',
        newValue: c.newValue ? String(c.newValue) : '',
        reason: str('reason'),
      });
      break;
    }
    case 'official_letter':
      Object.assign(out, {
        letterType: str('letterType'),
        addressedTo: str('addressedTo'),
        purpose: str('purpose'),
      });
      break;
    case 'attendance_correction':
      Object.assign(out, { day: str('day'), kind: str('kind'), requestedTime: str('requestedTime'), punchId: str('punchId'), reason: str('reason') });
      break;
    case 'geofence_exception':
      Object.assign(out, { from: str('from'), to: str('to'), scope: str('scope'), siteId: str('siteId'), reason: str('reason') });
      break;
    case 'overtime':
      Object.assign(out, { day: str('day'), startTime: str('startTime'), endTime: str('endTime'), reason: str('reason'), compensation: str('compensation') });
      break;
  }
  return out;
}

const msg = (errors: FieldErrors<RequestFormValues>, name: string): string | undefined => {
  const e = errors[name];
  return e ? (typeof e.message === 'string' && e.message) || undefined : undefined;
};

/** The per-type fields of HR §3.5, with inline validation messages (review C19). */
export function RequestFields({
  type,
  form,
  advanceLimitUnset,
  advanceInstalmentCapHalalas,
  advanceInstalmentCapBp,
}: {
  type: HrRequestType;
  form: UseFormReturn<RequestFormValues>;
  advanceLimitUnset?: boolean;
  /** The requester's own cap on a monthly instalment (10 % of the wage) — from `/hr/requests/types`. */
  advanceInstalmentCapHalalas?: number;
  advanceInstalmentCapBp?: number;
}) {
  const { t } = useTranslation();
  const sites = useSites();
  const required = t('common.requiredField');
  const errors = form.formState.errors;
  const leaveType = form.watch('leaveType') as LeaveType | undefined;
  const kind = form.watch('kind');
  const scope = form.watch('scope');
  const advAmount = Number(form.watch('amount') || 0);
  const advInstalments = Math.max(1, Number(form.watch('instalments') || 1));
  const advMonthly = advAmount > 0 ? Math.ceil((advAmount * 100) / advInstalments) : 0;
  const advOverCap = !!advanceInstalmentCapHalalas && advMonthly > advanceInstalmentCapHalalas;
  const text = (name: string, label: string, req = true, props: Record<string, unknown> = {}): ReactNode => (
    <Field label={label} required={req} error={msg(errors, name) ?? (errors[name] ? required : undefined)}>
      <Input {...props} {...form.register(name, { required: req ? required : false })} />
    </Field>
  );
  const reason = (name = 'reason', label = t('requests.fields.reason'), req = true) => (
    <Field label={label} required={req} error={msg(errors, name)}>
      <Textarea
        rows={2}
        {...form.register(name, {
          required: req ? required : false,
          minLength: { value: 2, message: t('requests.reasonTooShort') },
        })}
      />
    </Field>
  );
  switch (type) {
    case 'leave':
      return (
        <>
          <Field label={t('requests.fields.leaveType')}>
            <Select {...form.register('leaveType')}>
              {LEAVE_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`requests.leaveTypes.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            {text('startDate', t('requests.fields.startDate'), true, { type: 'date', dir: 'ltr' })}
            {text('endDate', t('requests.fields.endDate'), true, { type: 'date', dir: 'ltr' })}
          </div>
          {leaveType && LEAVE_TYPES_WITH_EVENT.includes(leaveType) && text('eventDate', t('requests.fields.eventDate'), true, { type: 'date', dir: 'ltr' })}
          {reason()}
        </>
      );
    case 'attendance_correction':
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            {text('day', t('requests.fields.day'), true, { type: 'date', dir: 'ltr' })}
            <Field label={t('requests.fields.kind')}>
              <Select {...form.register('kind')}>
                {CORRECTION_KINDS.map((x) => (
                  <option key={x} value={x}>
                    {t(`requests.correctionKinds.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {text('requestedTime', t('requests.fields.requestedTime'), true, { type: 'time', dir: 'ltr' })}
          {kind === 'wrong_time' && text('punchId', t('requests.fields.punchId'), true, { dir: 'ltr' })}
          {reason()}
        </>
      );
    case 'geofence_exception':
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            {text('from', t('requests.fields.from'), true, { type: 'date', dir: 'ltr' })}
            {text('to', t('requests.fields.to'), true, { type: 'date', dir: 'ltr' })}
          </div>
          <Field label={t('requests.fields.scope')}>
            <Select {...form.register('scope')}>
              {EXCEPTION_SCOPES.map((x) => (
                <option key={x} value={x}>
                  {t(`requests.exceptionScopes.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          {scope === 'site' && (
            <Field label={t('requests.fields.siteId')} required>
              <Select {...form.register('siteId', { required })}>
                <option value="">—</option>
                {sites.data?.items.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.nameAr}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {reason()}
        </>
      );
    case 'overtime':
      return (
        <>
          {text('day', t('requests.fields.day'), true, { type: 'date', dir: 'ltr' })}
          <div className="grid grid-cols-2 gap-3">
            {text('startTime', t('requests.fields.startTime'), true, { type: 'time', dir: 'ltr' })}
            {text('endTime', t('requests.fields.endTime'), true, { type: 'time', dir: 'ltr' })}
          </div>
          <Field label={t('requests.fields.compensation')} hint={t('requests.compensationHint')}>
            <Select {...form.register('compensation')}>
              <option value="">{t('requests.compensationPolicy')}</option>
              <option value="pay">{t('requests.compensations.pay')}</option>
              <option value="leave">{t('requests.compensations.leave')}</option>
            </Select>
          </Field>
          {reason()}
        </>
      );
    case 'permission':
      return (
        <>
          {text('date', t('common.date'), true, { type: 'date', dir: 'ltr' })}
          <div className="grid grid-cols-2 gap-3">
            {text('startTime', t('requests.fields.startTime'), true, { type: 'time', dir: 'ltr' })}
            {text('endTime', t('requests.fields.endTime'), true, { type: 'time', dir: 'ltr' })}
          </div>
          {reason()}
        </>
      );
    case 'remote_work':
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            {text('startDate', t('requests.fields.startDate'), true, { type: 'date', dir: 'ltr' })}
            {text('days', t('requests.fields.days'), true, { type: 'number', min: 1, dir: 'ltr' })}
          </div>
          {reason()}
        </>
      );
    case 'salary_certificate':
      return (
        <>
          {text('addressedTo', t('requests.fields.addressedTo'))}
          {text('purpose', t('requests.fields.purpose'))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...form.register('detailed')} /> {t('requests.fields.detailed')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...form.register('chamberAttestation')} />{' '}
            {t('requests.fields.chamberAttestation')}
          </label>
        </>
      );
    case 'experience_certificate':
      return text('purpose', t('requests.fields.purpose'));
    case 'advance':
      return (
        <>
          {text('amount', t('requests.fields.amount'), true, {
            type: 'number',
            min: 1,
            step: '0.01',
            dir: 'ltr',
          })}
          {advanceLimitUnset && <Alert kind="info">{t('requests.advanceLimitUnset')}</Alert>}
          {text('instalments', t('requests.fields.instalments'), false, { type: 'number', min: 1, max: 36, step: 1, dir: 'ltr', placeholder: '1' })}
          {advMonthly > 0 && (
            <Alert kind={advOverCap ? 'warning' : 'info'}>
              {t('requests.advanceInstalmentLine', { amount: (advMonthly / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }), pct: (advanceInstalmentCapBp ?? 1000) / 100 })}
              {advOverCap ? ` ${t('requests.advanceInstalmentOverCap', { pct: (advanceInstalmentCapBp ?? 1000) / 100 })}` : ''}
            </Alert>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" {...form.register('scheduleConsent')} /> {t('requests.fields.scheduleConsent')}
          </label>
          {reason()}
          <Field label={t('hr.notes')}>
            <Textarea rows={2} {...form.register('notes')} />
          </Field>
        </>
      );
    case 'data_update':
      return (
        <>
          {text('field', t('requests.fields.field'))}
          {text('currentValue', t('requests.fields.currentValue'), false)}
          {text('newValue', t('requests.fields.newValue'))}
          {reason('reason', t('requests.fields.reason'), false)}
        </>
      );
    case 'official_letter':
      return (
        <>
          {text('letterType', t('requests.fields.letterType'))}
          {text('addressedTo', t('requests.fields.addressedTo'))}
          {text('purpose', t('requests.fields.purpose'))}
        </>
      );
  }
}
