import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get } from '@/lib/api';
import { Input } from '@/shared/ui';

interface Person {
  userId: string;
  fullNameAr: string;
}
/** Multi-select over the employee file (the calendar's people search) — interview panels, participants. */
export function PeoplePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Person[]>([]);
  const people = useQuery({ queryKey: ['calendar', 'people', q], queryFn: () => get<{ items: Person[] }>(`/calendar/people?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  const add = (p: Person) => {
    if (value.includes(p.userId)) return;
    setChosen((s) => [...s, p]);
    onChange([...value, p.userId]);
  };
  const remove = (id: string) => {
    setChosen((s) => s.filter((x) => x.userId !== id));
    onChange(value.filter((x) => x !== id));
  };
  return (
    <div className="space-y-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('actions.search')} />
      {people.data?.items.length ? (
        <div className="max-h-32 space-y-1 overflow-y-auto">
          {people.data.items
            .filter((p) => !value.includes(p.userId))
            .map((p) => (
              <button key={p.userId} type="button" className="block w-full rounded-md border border-slate-200 px-2 py-1 text-start text-sm hover:bg-slate-50" onClick={() => add(p)}>
                {p.fullNameAr}
              </button>
            ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {chosen.map((p) => (
          <span key={p.userId} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-800">
            {p.fullNameAr}
            <button type="button" aria-label={t('actions.remove')} onClick={() => remove(p.userId)}>
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
