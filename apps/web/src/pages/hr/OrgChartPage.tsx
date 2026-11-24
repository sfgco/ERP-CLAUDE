import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { get } from '@/lib/api';
import { Badge, Button, Card, EmptyState, Input, PageHeader, QueryError, Spinner, cx } from '@/shared/ui';
import { statusTone } from './EmployeesPage';
import type { EmployeeStatus } from '@eayni/shared';

interface Node {
  _id: string;
  fullNameAr: string;
  employeeNumber: string;
  departmentId: string;
  unitId?: string;
  positionTitle: string;
  directManagerId?: string;
  status: EmployeeStatus;
  reports: number;
}
interface Data {
  departments: { _id: string; code: string; nameAr: string }[];
  units: { _id: string; nameAr: string; departmentId: string }[];
  employees: Node[];
  scope: string;
}

/**
 * «واجهة الهيكل التنظيمي» [HR §9.2, §3.1]: departments → units → employees under their direct manager.
 * Employees outside the viewer's scope are not returned by the API, so a manager whose manager is out of scope
 * appears as a root with a note.
 */
export function OrgChartPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['hr', 'org-chart'], queryFn: () => get<Data>('/hr/org-chart') });
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const d = q.data;
  const byId = useMemo(() => new Map((d?.employees ?? []).map((e) => [e._id, e])), [d]);
  const matches = (e: Node) =>
    !search.trim() ||
    e.fullNameAr.includes(search.trim()) ||
    e.employeeNumber.includes(search.trim()) ||
    e.positionTitle.includes(search.trim());
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Spinner />;

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const isCollapsed = (id: string) => (allCollapsed ? !collapsed.has(id) : collapsed.has(id));

  /** Roots of a department: employees whose manager is missing, out of scope, or in another department. */
  const rootsOf = (deptId: string, unitId?: string) =>
    d.employees.filter(
      (e) =>
        String(e.departmentId) === deptId &&
        (unitId ? String(e.unitId ?? '') === unitId : !e.unitId) &&
        (!e.directManagerId ||
          !byId.has(String(e.directManagerId)) ||
          String(byId.get(String(e.directManagerId))!.departmentId) !== deptId),
    );
  const childrenOf = (id: string) => d.employees.filter((e) => String(e.directManagerId ?? '') === id);

  const Tree = ({ node, depth }: { node: Node; depth: number }) => {
    const kids = childrenOf(node._id);
    const open = !isCollapsed(node._id);
    const outside = node.directManagerId && !byId.has(String(node.directManagerId));
    const visible = matches(node) || kids.some((k) => subtreeMatches(k));
    if (!visible) return null;
    return (
      <li>
        <div
          className={cx(
            'flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50',
            matches(node) && search.trim() && 'bg-brand-50',
          )}
          style={{ marginInlineStart: depth * 16 }}
        >
          {kids.length ? (
            <button
              type="button"
              onClick={() => toggle(node._id)}
              className="text-slate-500"
              aria-label={open ? t('hr.orgChart.collapseAll') : t('hr.orgChart.expandAll')}
            >
              {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronLeft className="size-4" aria-hidden />}
            </button>
          ) : (
            <span className="inline-block size-4" />
          )}
          <Link to={`/hr/employees/${node._id}`} className="font-medium text-brand-700 hover:underline">
            {node.fullNameAr}
          </Link>
          <span className="text-xs text-slate-500">{node.positionTitle}</span>
          <span dir="ltr" className="text-xs text-slate-400">
            {node.employeeNumber}
          </span>
          <Badge tone={statusTone[node.status]}>{t(`hr.status.${node.status}`)}</Badge>
          {kids.length > 0 && (
            <span className="text-xs text-slate-500">{t('hr.orgChart.reports', { count: kids.length })}</span>
          )}
          {outside && <span className="text-xs text-amber-700">{t('hr.orgChart.managerOutside')}</span>}
        </div>
        {open && kids.length > 0 && (
          <ul>
            {kids.map((k) => (
              <Tree key={k._id} node={k} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  };
  const subtreeMatches = (n: Node): boolean => matches(n) || childrenOf(n._id).some(subtreeMatches);

  return (
    <>
      <PageHeader
        title={t('hr.orgChart.title')}
        subtitle={t('hr.orgChart.hint')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('hr.orgChart.search')}
              aria-label={t('hr.orgChart.search')}
            />
            <Button
              variant="secondary"
              onClick={() => {
                setAllCollapsed((v) => !v);
                setCollapsed(new Set());
              }}
            >
              {allCollapsed ? t('hr.orgChart.expandAll') : t('hr.orgChart.collapseAll')}
            </Button>
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {d.departments.map((dep) => {
          const units = d.units.filter((u) => String(u.departmentId) === dep._id);
          const roots = rootsOf(dep._id);
          const count = d.employees.filter((e) => String(e.departmentId) === dep._id).length;
          return (
            <Card key={dep._id} title={`${dep.nameAr} (${count})`}>
              {!count ? (
                <p className="text-sm text-slate-500">{t('hr.orgChart.empty')}</p>
              ) : (
                <>
                  {roots.length > 0 && (
                    <ul className="space-y-0.5">
                      {roots.map((r) => (
                        <Tree key={r._id} node={r} depth={0} />
                      ))}
                    </ul>
                  )}
                  {units.map((u) => {
                    const uroots = rootsOf(dep._id, u._id);
                    if (!uroots.length) return null;
                    return (
                      <div key={u._id} className="mt-2">
                        <h3 className="mb-1 text-xs font-semibold text-slate-500">{u.nameAr}</h3>
                        <ul className="space-y-0.5">
                          {uroots.map((r) => (
                            <Tree key={r._id} node={r} depth={0} />
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </>
              )}
            </Card>
          );
        })}
        {!d.departments.length && <EmptyState title={t('common.empty')} />}
      </div>
    </>
  );
}
