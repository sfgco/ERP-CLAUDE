import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CONTRACT_TYPES, EMPLOYMENT_TYPES, REQUISITION_STATES } from '@eayni/shared';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePrefs } from '@/lib/preferences';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, QueryError, Select, Spinner, Table, Td, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';
import { useHrLookups } from './_data';
import { requisitionTone, type RecruitmentPolicy, type RequisitionRow } from './_h3b';

/** «التوظيف وإجراءات مباشرة الموظف» [HR §3.2, §9.4]: the requisitions register; a department manager raises for their department, HR runs the rest. */
export function RecruitmentPage() {
  const { t } = useTranslation();
  const { can, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { formatDate } = usePrefs();
  const lk = useHrLookups();
  const [state, setState] = useState('');
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['recruitment', 'requisitions', state], queryFn: () => get<{ items: RequisitionRow[]; total: number }>(`/hr/recruitment/requisitions?limit=100${state ? `&state=${state}` : ''}`) });
  const policy = useQuery({ queryKey: ['recruitment', 'policy'], queryFn: () => get<RecruitmentPolicy>('/hr/recruitment/policy') });
  const myDept = user?.departmentId ? String(user.departmentId) : '';
  const [form, setForm] = useState({ departmentId: myDept, titleAr: '', headcount: 1, justification: '', requirements: '', employmentType: 'full_time', contractType: 'fixed_term', durationMonths: 12, salaryMin: '', salaryMax: '', neededBy: '', costs: [] as { labelAr: string; amountHalalas: string }[] });
  const create = useMutation({
    mutationFn: (draft: boolean) =>
      post<RequisitionRow>('/hr/recruitment/requisitions', {
        departmentId: form.departmentId,
        titleAr: form.titleAr,
        headcount: Number(form.headcount),
        justification: form.justification,
        requirements: form.requirements || undefined,
        employmentType: form.employmentType,
        contractType: form.contractType,
        durationMonths: form.contractType === 'fixed_term' ? Number(form.durationMonths) : undefined,
        salaryRange: form.salaryMin && form.salaryMax ? { minHalalas: Math.round(Number(form.salaryMin) * 100), maxHalalas: Math.round(Number(form.salaryMax) * 100) } : undefined,
        neededBy: form.neededBy || undefined,
        recruitmentCosts: form.costs.filter((c) => c.labelAr).map((c) => ({ labelAr: c.labelAr, amountHalalas: Math.round(Number(c.amountHalalas || 0) * 100) })),
        draft,
      }),
    onSuccess: (r) => {
      toast(r.number);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['recruitment'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const saud = policy.data?.saudization;
  return (
    <>
      <PageHeader title={t('recruitment.title')} subtitle={t('recruitment.hint')} actions={can('hr.recruitment', 'create') ? <Button onClick={() => setOpen(true)}>{t('recruitment.newRequisition')}</Button> : undefined} />
      {policy.data?.provisional && <Alert kind="warning">{t('recruitment.provisional')}</Alert>}
      {saud && (
        <p className="mt-2 text-xs text-slate-500">
          {saud.setting.requiredRatePct === null ? t('recruitment.saudizationUnset') : t('recruitment.saudizationNow', { rate: saud.ratePct ?? '—', required: saud.setting.requiredRatePct })}
          {saud.below && <Badge tone="amber">{t('hr.home.saudizationBelow')}</Badge>}
        </p>
      )}
      <Card className="mt-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={state} onChange={(e) => setState(e.target.value)} className="sm:w-64">
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            {REQUISITION_STATES.map((s) => (
              <option key={s} value={s}>
                {t(`recruitment.states.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <EmptyState title={t('recruitment.empty')} />
        ) : (
          <Table head={[t('recruitment.number'), t('recruitment.jobTitle'), t('recruitment.department'), t('recruitment.headcount'), t('recruitment.hired'), t('common.status'), t('recruitment.neededBy')]}>
            {q.data.items.map((r) => (
              <tr key={r._id}>
                <Td className="tabular text-xs">
                  <Link to={`/hr/recruitment/requisitions/${r._id}`} className="text-brand-800 hover:underline">
                    {r.number}
                  </Link>
                </Td>
                <Td>{r.titleAr}</Td>
                <Td>{r.departmentName ?? lk.deptName(r.departmentId)}</Td>
                <Td className="tabular">{r.headcount}</Td>
                <Td className="tabular">{r.hiredCount}</Td>
                <Td>
                  <Badge tone={requisitionTone[r.state]}>{t(`recruitment.states.${r.state}`)}</Badge>
                </Td>
                <Td className="tabular text-xs">{r.neededBy ? formatDate(r.neededBy) : '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('recruitment.newRequisition')}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(false);
          }}
        >
          <Field label={t('recruitment.department')} required>
            <Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} required>
              <option value="">—</option>
              {lk.departments.map((d) => (
                <option key={d._id} value={d._id}>
                  {d.nameAr}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('recruitment.jobTitle')} required>
            <Input value={form.titleAr} onChange={(e) => setForm({ ...form, titleAr: e.target.value })} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('recruitment.headcount')} required>
              <Input type="number" min={1} value={form.headcount} onChange={(e) => setForm({ ...form, headcount: Number(e.target.value) })} />
            </Field>
            <Field label={t('recruitment.employmentType')}>
              <Select value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })}>
                {EMPLOYMENT_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`hr.employmentTypes.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('recruitment.contractType')}>
              <Select value={form.contractType} onChange={(e) => setForm({ ...form, contractType: e.target.value })}>
                {CONTRACT_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`hr.contractTypes.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {form.contractType === 'fixed_term' && (
            <Field label={t('recruitment.durationMonths')} hint={t('recruitment.durationHint')}>
              <Input type="number" min={1} value={form.durationMonths} onChange={(e) => setForm({ ...form, durationMonths: Number(e.target.value) })} />
            </Field>
          )}
          <Field label={t('recruitment.justification')} required>
            <Textarea rows={2} value={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.value })} required />
          </Field>
          <Field label={t('recruitment.requirements')} hint={t('recruitment.requirementsHint')}>
            <Textarea rows={2} value={form.requirements} onChange={(e) => setForm({ ...form, requirements: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('recruitment.salaryMin')}>
              <Input dir="ltr" type="number" min={0} value={form.salaryMin} onChange={(e) => setForm({ ...form, salaryMin: e.target.value })} />
            </Field>
            <Field label={t('recruitment.salaryMax')}>
              <Input dir="ltr" type="number" min={0} value={form.salaryMax} onChange={(e) => setForm({ ...form, salaryMax: e.target.value })} />
            </Field>
            <Field label={t('recruitment.neededBy')}>
              <Input dir="ltr" type="date" value={form.neededBy} onChange={(e) => setForm({ ...form, neededBy: e.target.value })} />
            </Field>
          </div>
          <Field label={t('recruitment.recruitmentCosts')} hint={t('recruitment.recruitmentCostsHint')}>
            <div className="space-y-1">
              {form.costs.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_120px] gap-2">
                  <Input placeholder={t('recruitment.costLabel')} value={c.labelAr} onChange={(e) => setForm({ ...form, costs: form.costs.map((x, j) => (j === i ? { ...x, labelAr: e.target.value } : x)) })} />
                  <Input dir="ltr" type="number" min={0} placeholder={t('recruitment.amount')} value={c.amountHalalas} onChange={(e) => setForm({ ...form, costs: form.costs.map((x, j) => (j === i ? { ...x, amountHalalas: e.target.value } : x)) })} />
                </div>
              ))}
              <button type="button" className="text-xs text-brand-700 underline" onClick={() => setForm({ ...form, costs: [...form.costs, { labelAr: '', amountHalalas: '' }] })}>
                {t('recruitment.addCost')}
              </button>
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => create.mutate(true)} loading={create.isPending}>
              {t('recruitment.saveDraft')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('recruitment.submit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
