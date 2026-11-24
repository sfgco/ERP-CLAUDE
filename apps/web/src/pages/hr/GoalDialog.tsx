import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, post } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/shared/ui';
import { useToast } from '@/shared/ui/Toast';

interface Kpi {
  code: string;
  nameAr: string;
  module: string;
}

/** «تحديد الأهداف الوظيفية لكل موظف» [HR §3.7]: a goal with its weight, tied to a KPI of the registry (validated by the API). */
export function GoalDialog({ open, onClose, employees, employeeId }: { open: boolean; onClose: () => void; employees: { _id: string; fullNameAr: string; employeeNumber: string }[]; employeeId?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const kpis = useQuery({ queryKey: ['perf', 'kpis'], queryFn: () => get<{ items: Kpi[] }>('/hr/performance/kpis'), enabled: open });
  const [form, setForm] = useState({ employeeId: employeeId ?? '', title: '', description: '', weightBp: 10_000, kpiCode: '', targetValue: '', unit: '', dueDate: '' });
  const save = useMutation({
    mutationFn: () =>
      post('/hr/performance/goals', {
        employeeId: form.employeeId,
        title: form.title,
        description: form.description || undefined,
        weightBp: Number(form.weightBp),
        kpiCode: form.kpiCode || undefined,
        targetValue: form.targetValue === '' ? undefined : Number(form.targetValue),
        unit: form.unit || undefined,
        dueDate: form.dueDate || undefined,
      }),
    onSuccess: () => {
      toast(t('performance.goalCreated'));
      qc.invalidateQueries({ queryKey: ['perf'] });
      onClose();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Dialog open={open} onClose={onClose} title={t('performance.newGoal')}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {!employeeId && (
          <Field label={t('hr.employee')} required>
            <Select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required>
              <option value="">—</option>
              {[...employees].sort((a, b) => a.fullNameAr.localeCompare(b.fullNameAr, 'ar')).map((e) => (
                <option key={e._id} value={e._id}>
                  {e.fullNameAr} · {e.employeeNumber}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('performance.goal')} required>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required minLength={3} />
        </Field>
        <Field label={t('hr.notes')}>
          <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label={t('performance.kpi')} hint={t('performance.kpiHint')}>
          <Select value={form.kpiCode} onChange={(e) => setForm({ ...form, kpiCode: e.target.value })}>
            <option value="">{t('performance.noKpi')}</option>
            {kpis.data?.items.map((k) => (
              <option key={k.code} value={k.code}>
                {k.nameAr} ({t(`departments.${k.module}`, k.module)})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('performance.weightPct')} required>
            <Input type="number" dir="ltr" min={1} max={100} value={form.weightBp / 100} onChange={(e) => setForm({ ...form, weightBp: Number(e.target.value) * 100 })} required />
          </Field>
          <Field label={t('performance.target')}>
            <Input type="number" dir="ltr" value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} />
          </Field>
          <Field label={t('performance.unit')}>
            <Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          </Field>
        </div>
        <Field label={t('performance.dueDate')}>
          <Input type="date" dir="ltr" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!form.employeeId || form.title.trim().length < 3}>
            {t('actions.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
