import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CONTRACT_TYPES, EMPLOYMENT_TYPES, IDENTITY_TYPES, WAGE_PERIODS } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { riyadhToday } from '@/lib/dates';
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, QueryError, Select, Spinner, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { FileUploader } from '@/shared/files/FileUploader';
import { useHrLookups, type EmployeeRow } from './_data';
import { offerTone, riyals, type OfferDetail, type RecruitmentPolicy } from './_h3b';

/** «العرض الوظيفي» [HR §3.2.7–3.2.10]: creation (T2–T10 checks on the server), approval, acceptance, the hire from the offer, the government registration by hand. */
export function OfferPage() {
  const { id = '' } = useParams();
  const isNew = id === 'new';
  return isNew ? <NewOffer /> : <OfferDetailView id={id} />;
}

function NewOffer() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const lk = useHrLookups();
  const policy = useQuery({ queryKey: ['recruitment', 'policy'], queryFn: () => get<RecruitmentPolicy>('/hr/recruitment/policy') });
  const managers = useQuery({ queryKey: ['employees', 'all', 'picker'], queryFn: () => get<{ items: EmployeeRow[] }>('/hr/employees?limit=200') });
  const [f, setF] = useState({
    applicantId: params.get('applicantId') ?? '',
    positionId: '',
    directManagerId: '',
    employmentType: 'full_time',
    contractType: 'fixed_term',
    durationMonths: '12',
    workDescription: '',
    probationDays: '90',
    wagePeriod: 'monthly',
    basic: '',
    allowances: [{ type: '', amount: '' }],
    renewal: false,
    renewalPeriod: '12',
    excludeCommissions: false,
    clauseRef: '',
    nonCompete: false,
    nonCompeteMonths: '12',
    nonCompeteScope: '',
    permitNumber: '',
    permitProfession: '',
    permitExpiry: '',
    startDate: '',
    validUntil: '',
    notes: '',
  });
  const create = useMutation({
    mutationFn: () =>
      post<OfferDetail>('/hr/recruitment/offers', {
        applicantId: f.applicantId,
        positionId: f.positionId || undefined,
        directManagerId: f.directManagerId || undefined,
        employmentType: f.employmentType,
        contractType: f.contractType,
        durationMonths: f.contractType === 'fixed_term' && f.durationMonths ? Number(f.durationMonths) : undefined,
        workDescription: f.contractType === 'specific_work' ? f.workDescription : undefined,
        probationDays: Number(f.probationDays || 0),
        wagePeriod: f.wagePeriod,
        basicSalaryHalalas: Math.round(Number(f.basic) * 100),
        allowances: f.allowances.filter((a) => a.type && a.amount).map((a) => ({ type: a.type, amountHalalas: Math.round(Number(a.amount) * 100) })),
        renewalClause: f.renewal ? { enabled: true, periodMonths: Number(f.renewalPeriod) } : { enabled: false },
        awardExcludesVariableWage: f.excludeCommissions,
        awardExclusionClauseRef: f.excludeCommissions ? f.clauseRef : undefined,
        nonCompete: f.nonCompete ? { months: Number(f.nonCompeteMonths), scopeAr: f.nonCompeteScope } : undefined,
        workPermit: f.permitNumber || f.permitExpiry ? { number: f.permitNumber || undefined, professionAr: f.permitProfession || undefined, expiryDate: f.permitExpiry || undefined } : undefined,
        startDate: f.startDate,
        validUntil: f.validUntil,
        notes: f.notes || undefined,
      }),
    onSuccess: (o) => {
      toast(o.number);
      navigate(`/hr/recruitment/offers/${o._id}`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <>
      <PageHeader title={t('recruitment.newOffer')} subtitle={t('recruitment.contractHint')} />
      <Card>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('recruitment.position')}>
              <Select value={f.positionId} onChange={(e) => setF({ ...f, positionId: e.target.value })}>
                <option value="">—</option>
                {lk.positions.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.titleAr}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('recruitment.directManager')}>
              <Select value={f.directManagerId} onChange={(e) => setF({ ...f, directManagerId: e.target.value })}>
                <option value="">—</option>
                {(managers.data?.items ?? []).map((m) => (
                  <option key={m._id} value={m._id}>
                    {m.fullNameAr}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('recruitment.employmentType')}>
              <Select value={f.employmentType} onChange={(e) => setF({ ...f, employmentType: e.target.value })}>
                {EMPLOYMENT_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`hr.employmentTypes.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('recruitment.contractType')}>
              <Select value={f.contractType} onChange={(e) => setF({ ...f, contractType: e.target.value })}>
                {CONTRACT_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`hr.contractTypes.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {f.contractType === 'fixed_term' && (
              <Field label={t('recruitment.durationMonths')} hint={t('recruitment.durationHint')}>
                <Input dir="ltr" type="number" min={1} value={f.durationMonths} onChange={(e) => setF({ ...f, durationMonths: e.target.value })} />
              </Field>
            )}
            <Field label={t('recruitment.probationDays')} hint={t('recruitment.probationHint')}>
              <Input dir="ltr" type="number" min={0} max={policy.data?.maxProbationDays ?? 180} value={f.probationDays} onChange={(e) => setF({ ...f, probationDays: e.target.value })} />
            </Field>
          </div>
          {f.contractType === 'specific_work' && (
            <Field label={t('recruitment.workDescription')} required>
              <Textarea rows={2} value={f.workDescription} onChange={(e) => setF({ ...f, workDescription: e.target.value })} required />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('recruitment.wagePeriod')}>
              <Select value={f.wagePeriod} onChange={(e) => setF({ ...f, wagePeriod: e.target.value })}>
                {WAGE_PERIODS.map((x) => (
                  <option key={x} value={x}>
                    {t(`recruitment.wagePeriods.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('recruitment.basicSalary')} required>
              <Input dir="ltr" type="number" min={0} value={f.basic} onChange={(e) => setF({ ...f, basic: e.target.value })} required />
            </Field>
            <Field label={t('recruitment.startDate')} required>
              <Input dir="ltr" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required />
            </Field>
            <Field label={t('recruitment.validUntil')} required>
              <Input dir="ltr" type="date" min={riyadhToday()} value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} required />
            </Field>
          </div>
          <Field label={t('recruitment.allowances')}>
            <div className="space-y-1">
              {f.allowances.map((a, i) => (
                <div key={i} className="grid grid-cols-[1fr_140px] gap-2">
                  <Input placeholder={t('recruitment.allowanceType')} value={a.type} onChange={(e) => setF({ ...f, allowances: f.allowances.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) })} />
                  <Input dir="ltr" type="number" min={0} placeholder={t('recruitment.amount')} value={a.amount} onChange={(e) => setF({ ...f, allowances: f.allowances.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })} />
                </div>
              ))}
              <button type="button" className="text-xs text-brand-700 underline" onClick={() => setF({ ...f, allowances: [...f.allowances, { type: '', amount: '' }] })}>
                {t('recruitment.addAllowance')}
              </button>
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.renewal} onChange={(e) => setF({ ...f, renewal: e.target.checked })} /> {t('recruitment.renewalClause')}
            </label>
            {f.renewal && (
              <Field label={t('recruitment.renewalPeriod')} hint={t('recruitment.renewalHint')}>
                <Input dir="ltr" type="number" min={1} value={f.renewalPeriod} onChange={(e) => setF({ ...f, renewalPeriod: e.target.value })} />
              </Field>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.excludeCommissions} onChange={(e) => setF({ ...f, excludeCommissions: e.target.checked })} /> {t('recruitment.awardExcludes')}
            </label>
            {f.excludeCommissions && (
              <Field label={t('recruitment.awardExclusionClauseRef')} required>
                <Input value={f.clauseRef} onChange={(e) => setF({ ...f, clauseRef: e.target.value })} required />
              </Field>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.nonCompete} onChange={(e) => setF({ ...f, nonCompete: e.target.checked })} /> {t('recruitment.nonCompete')}
            </label>
            {f.nonCompete && (
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <Field label={t('recruitment.nonCompeteMonths')}>
                  <Input dir="ltr" type="number" min={1} max={24} value={f.nonCompeteMonths} onChange={(e) => setF({ ...f, nonCompeteMonths: e.target.value })} />
                </Field>
                <Field label={t('recruitment.nonCompeteScope')} required>
                  <Input value={f.nonCompeteScope} onChange={(e) => setF({ ...f, nonCompeteScope: e.target.value })} required />
                </Field>
              </div>
            )}
          </div>
          <Field label={t('recruitment.workPermit')}>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input dir="ltr" placeholder={t('recruitment.workPermitNumber')} value={f.permitNumber} onChange={(e) => setF({ ...f, permitNumber: e.target.value })} />
              <Input placeholder={t('recruitment.workPermitProfession')} value={f.permitProfession} onChange={(e) => setF({ ...f, permitProfession: e.target.value })} />
              <Input dir="ltr" type="date" value={f.permitExpiry} onChange={(e) => setF({ ...f, permitExpiry: e.target.value })} />
            </div>
          </Field>
          <Field label={t('hr.notes')}>
            <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!f.applicantId}>
              {t('actions.save')}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function OfferDetailView({ id }: { id: string }) {
  const { t } = useTranslation();
  const { formatDate, formatDateTime } = usePrefs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['recruitment', 'offer', id], queryFn: () => get<OfferDetail>(`/hr/recruitment/offers/${id}`) });
  const [dialog, setDialog] = useState<'reject' | 'decline' | 'withdraw' | 'accept' | 'contract' | 'gov' | null>(null);
  const [reason, setReason] = useState('');
  const [acceptedAt, setAcceptedAt] = useState(riyadhToday());
  const [signedId, setSignedId] = useState('');
  const [hire, setHire] = useState({ workEmail: '', identityType: 'national_id', identityNumber: '', identityExpiry: '', gender: 'male', birthDate: '', mobile: '', bankName: '', iban: '', policyNumber: '', policyExpiry: '', createAccount: true, contractAttachmentId: '', differentProfession: false });
  const [gov, setGov] = useState({ qiwaRef: '', qiwaAt: '', gosiRef: '', gosiAt: '' });
  const [tempPassword, setTempPassword] = useState<string | undefined>();
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<OfferDetail>(`/hr/recruitment/offers/${id}/transition`, body),
    onSuccess: (r) => {
      toast(t('actions.save'));
      if (r.temporaryPassword) setTempPassword(r.temporaryPassword);
      setDialog(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['recruitment'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const o = q.data;
  const has = (a: string) => o.actions.includes(a);
  return (
    <>
      <PageHeader
        title={`${o.number} — ${o.applicant?.fullNameAr ?? ''}`}
        subtitle={`${o.departmentName ?? ''} · ${o.positionTitle ?? ''} · ${t('recruitment.startDate')} ${formatDate(o.startDate)}`}
        actions={
          <>
            <Badge tone={offerTone[o.state]}>{t(`recruitment.offerStates.${o.state}`)}</Badge>
            <Link to={`/hr/recruitment/requisitions/${o.requisitionId}`} className="text-sm text-brand-700 hover:underline">
              {t('actions.back')}
            </Link>
          </>
        }
      />
      {o.flags.map((f) => (
        <Alert key={f} kind="warning">
          {t(`recruitment.flags.${f}`, f)}
        </Alert>
      ))}
      {tempPassword && (
        <Alert kind="info">
          {t('recruitment.temporaryPassword')}: <code dir="ltr">{tempPassword}</code>
        </Alert>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {has('submit') && <Button onClick={() => act.mutate({ transition: 'submit' })}>{t('recruitment.submit')}</Button>}
        {has('approve') && <Button onClick={() => act.mutate({ transition: 'approve' })}>{t('recruitment.approve')}</Button>}
        {has('reject') && (
          <Button variant="danger" onClick={() => setDialog('reject')}>
            {t('recruitment.reject')}
          </Button>
        )}
        {has('send') && <Button onClick={() => act.mutate({ transition: 'send' })}>{t('recruitment.send')}</Button>}
        {has('accept') && <Button onClick={() => setDialog('accept')}>{t('recruitment.accept')}</Button>}
        {has('decline') && (
          <Button variant="secondary" onClick={() => setDialog('decline')}>
            {t('recruitment.decline')}
          </Button>
        )}
        {has('withdraw') && (
          <Button variant="danger" onClick={() => setDialog('withdraw')}>
            {t('recruitment.withdraw')}
          </Button>
        )}
        {has('contract') && <Button onClick={() => setDialog('contract')}>{t('recruitment.contract')}</Button>}
        {['contracted', 'onboarded'].includes(o.state) && (
          <Button variant="secondary" onClick={() => setDialog('gov')}>
            {t('recruitment.govRegistration')}
          </Button>
        )}
        {has('onboard') && (
          <Button variant="secondary" onClick={() => act.mutate({ transition: 'onboard' })}>
            {t('recruitment.onboard')}
          </Button>
        )}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card title={t('recruitment.offer')}>
          <dl className="text-sm">
            <Row label={t('recruitment.employmentType')} value={t(`hr.employmentTypes.${o.employmentType}`)} />
            <Row label={t('recruitment.contractType')} value={`${t(`hr.contractTypes.${o.contractType}`)}${o.durationMonths ? ` · ${o.durationMonths} ${t('hr.durationMonths')}` : ''}`} />
            {o.workDescription && <Row label={t('recruitment.workDescription')} value={o.workDescription} />}
            <Row label={t('recruitment.probationDays')} value={String(o.probationDays)} />
            <Row label={t('recruitment.wagePeriod')} value={t(`recruitment.wagePeriods.${o.wagePeriod}`)} />
            {typeof o.basicSalaryHalalas === 'number' && <Row label={t('recruitment.basicSalary')} value={riyals(o.basicSalaryHalalas)} />}
            {o.allowances && <Row label={t('recruitment.allowances')} value={o.allowances.map((a) => `${a.type}: ${riyals(a.amountHalalas)}`).join(' · ') || '—'} />}
            <Row label={t('recruitment.renewalClause')} value={o.renewalClause?.enabled ? `${t('offboarding.yes')} — ${o.renewalClause.periodMonths} ${t('hr.durationMonths')}` : t('offboarding.no')} />
            <Row label={t('recruitment.awardExcludes')} value={o.awardExcludesVariableWage ? `${t('offboarding.yes')} — ${o.awardExclusionClauseRef}` : t('offboarding.no')} />
            {o.nonCompete && <Row label={t('recruitment.nonCompete')} value={`${o.nonCompete.months} ${t('hr.durationMonths')} — ${o.nonCompete.scopeAr}`} />}
            {o.workPermit && (o.workPermit.number || o.workPermit.expiryDate) && <Row label={t('recruitment.workPermit')} value={`${o.workPermit.number ?? '—'} · ${o.workPermit.professionAr ?? ''} · ${o.workPermit.expiryDate ?? ''}`} />}
            <Row label={t('recruitment.validUntil')} value={formatDate(o.validUntil)} />
            {o.response?.at && <Row label={t('recruitment.acceptedAt')} value={`${formatDate(o.response.at)} — ${o.response.accepted ? t('recruitment.offerStates.accepted') : t('recruitment.offerStates.declined')}`} />}
            {o.createdEmployeeId && (
              <Row
                label={t('recruitment.hiredEmployee')}
                value={
                  <Link to={`/hr/employees/${o.createdEmployeeId}`} className="text-brand-700 underline">
                    {t('recruitment.hiredEmployee')}
                  </Link>
                }
              />
            )}
            {o.govRegistration?.at && <Row label={t('recruitment.govRegistration')} value={`${t('recruitment.qiwaRef')}: ${o.govRegistration.qiwaRef ?? '—'} (${o.govRegistration.qiwaAt ?? '—'}) · ${t('recruitment.gosiRef')}: ${o.govRegistration.gosiRef ?? '—'} (${o.govRegistration.gosiAt ?? '—'})`} />}
          </dl>
        </Card>
        <Card title={t('recruitment.applicant')}>
          {o.applicant && (
            <dl className="text-sm">
              <Row label={t('recruitment.nationality')} value={o.applicant.nationality} />
              <Row label={t('recruitment.birthDate')} value={o.applicant.birthDate} />
              <Row label={t('recruitment.phone')} value={o.applicant.phone} />
              <Row label={t('recruitment.email')} value={o.applicant.email} />
              <Row label={t('recruitment.qualification')} value={o.applicant.qualificationAr} />
              <Row label={t('recruitment.experienceYears')} value={o.applicant.experienceYears?.toString()} />
            </dl>
          )}
          <h3 className="mt-3 text-xs font-semibold text-slate-600">{t('requests.log')}</h3>
          <ul className="space-y-1 text-xs text-slate-600">
            {o.stages.map((s) => (
              <li key={s._id}>
                {formatDateTime(s.at)} — {s.transition}: {s.fromState ?? '—'} → {s.toState} {s.actorEmail ? `(${s.actorEmail})` : ''} {s.reason ? `— ${s.reason}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Dialog open={dialog === 'reject' || dialog === 'decline' || dialog === 'withdraw'} onClose={() => setDialog(null)} title={dialog ? t(`recruitment.${dialog}`) : ''}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ transition: dialog, reason });
          }}
        >
          <Field label={t('recruitment.reasonRequired')} required>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending}>
              {t('actions.save')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'accept'} onClose={() => setDialog(null)} title={t('recruitment.accept')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ transition: 'accept', acceptedAt, signedAttachmentId: signedId || undefined });
          }}
        >
          <Field label={t('recruitment.acceptedAt')} required>
            <Input dir="ltr" type="date" value={acceptedAt} onChange={(e) => setAcceptedAt(e.target.value)} required />
          </Field>
          <Field label={t('recruitment.signedFile')}>
            <FileUploader onUploaded={(a) => setSignedId(a.attachmentId)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending}>
              {t('actions.save')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'contract'} onClose={() => setDialog(null)} title={t('recruitment.contract')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({
              transition: 'contract',
              hire: {
                workEmail: hire.workEmail,
                identity: { type: hire.identityType, number: hire.identityNumber, expiryDate: hire.identityExpiry || undefined },
                gender: hire.gender,
                birthDate: hire.birthDate || undefined,
                mobile: hire.mobile || undefined,
                bank: hire.bankName && hire.iban ? { bankName: hire.bankName, iban: hire.iban } : undefined,
                medicalInsurancePolicy: hire.policyNumber || hire.policyExpiry ? { number: hire.policyNumber || undefined, expiryDate: hire.policyExpiry || undefined } : undefined,
                createAccount: hire.createAccount,
                contractAttachmentId: hire.contractAttachmentId || undefined,
                differentProfession: hire.differentProfession || undefined,
              },
            });
          }}
        >
          <Alert kind="info">{t('recruitment.contractHint')}</Alert>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('recruitment.workEmail')} required>
              <Input dir="ltr" type="email" value={hire.workEmail} onChange={(e) => setHire({ ...hire, workEmail: e.target.value })} required />
            </Field>
            <Field label={t('recruitment.gender')} required>
              <Select value={hire.gender} onChange={(e) => setHire({ ...hire, gender: e.target.value })}>
                <option value="male">{t('hr.genders.male')}</option>
                <option value="female">{t('hr.genders.female')}</option>
              </Select>
            </Field>
            <Field label={t('recruitment.identityType')} required>
              <Select value={hire.identityType} onChange={(e) => setHire({ ...hire, identityType: e.target.value })}>
                {IDENTITY_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`hr.identityTypes.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('recruitment.identityNumber')} required>
              <Input dir="ltr" value={hire.identityNumber} onChange={(e) => setHire({ ...hire, identityNumber: e.target.value })} required />
            </Field>
            <Field label={t('recruitment.identityExpiry')}>
              <Input dir="ltr" type="date" value={hire.identityExpiry} onChange={(e) => setHire({ ...hire, identityExpiry: e.target.value })} />
            </Field>
            <Field label={t('recruitment.birthDate')}>
              <Input dir="ltr" type="date" value={hire.birthDate} onChange={(e) => setHire({ ...hire, birthDate: e.target.value })} />
            </Field>
            <Field label={t('recruitment.mobile')}>
              <Input dir="ltr" value={hire.mobile} onChange={(e) => setHire({ ...hire, mobile: e.target.value })} />
            </Field>
            <Field label={t('recruitment.bank')}>
              <Input value={hire.bankName} onChange={(e) => setHire({ ...hire, bankName: e.target.value })} />
            </Field>
            <Field label={t('recruitment.iban')}>
              <Input dir="ltr" value={hire.iban} onChange={(e) => setHire({ ...hire, iban: e.target.value })} />
            </Field>
            <Field label={t('recruitment.policyNumber')}>
              <Input dir="ltr" value={hire.policyNumber} onChange={(e) => setHire({ ...hire, policyNumber: e.target.value })} />
            </Field>
            <Field label={t('recruitment.policyExpiry')}>
              <Input dir="ltr" type="date" value={hire.policyExpiry} onChange={(e) => setHire({ ...hire, policyExpiry: e.target.value })} />
            </Field>
          </div>
          <Field label={t('recruitment.contractFile')}>
            <FileUploader onUploaded={(a) => setHire({ ...hire, contractAttachmentId: a.attachmentId })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hire.createAccount} onChange={(e) => setHire({ ...hire, createAccount: e.target.checked })} /> {t('recruitment.createAccount')}
          </label>
          {o.applicant?.previousEmployeeId && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={hire.differentProfession} onChange={(e) => setHire({ ...hire, differentProfession: e.target.checked })} /> {t('recruitment.differentProfession')}
            </label>
          )}
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending}>
              {t('recruitment.contract')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={dialog === 'gov'} onClose={() => setDialog(null)} title={t('recruitment.govRegistration')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ transition: 'record_gov_registration', gov: { qiwaRef: gov.qiwaRef || undefined, qiwaAt: gov.qiwaAt || undefined, gosiRef: gov.gosiRef || undefined, gosiAt: gov.gosiAt || undefined } });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('recruitment.qiwaRef')}>
              <Input dir="ltr" value={gov.qiwaRef} onChange={(e) => setGov({ ...gov, qiwaRef: e.target.value })} />
            </Field>
            <Field label={t('recruitment.qiwaAt')}>
              <Input dir="ltr" type="date" value={gov.qiwaAt} onChange={(e) => setGov({ ...gov, qiwaAt: e.target.value })} />
            </Field>
            <Field label={t('recruitment.gosiRef')}>
              <Input dir="ltr" value={gov.gosiRef} onChange={(e) => setGov({ ...gov, gosiRef: e.target.value })} />
            </Field>
            <Field label={t('recruitment.gosiAt')}>
              <Input dir="ltr" type="date" value={gov.gosiAt} onChange={(e) => setGov({ ...gov, gosiAt: e.target.value })} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={act.isPending}>
              {t('recruitment.recordGov')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
function Row({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2 py-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-900">{value || '—'}</dd>
    </div>
  );
}
