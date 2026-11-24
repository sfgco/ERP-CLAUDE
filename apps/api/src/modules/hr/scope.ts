import type { AuthedRequest } from '../../core/http/context';
import { notFound } from '../../core/http/errors';
import { Employee } from './model';
import { employeeScopeFilter } from './service';

/**
 * Employee ids the viewer may reach for the authorized resource (own / team / department / all) — shared by the H2/H3a
 * routers. `null` = no restriction (scope all without a requested employee). A requested employee outside the scope is
 * a 404, never a 403 (existence is not revealed).
 */
export async function scopedEmployeeIds(req: AuthedRequest, requested?: string): Promise<unknown[] | null> {
  const filter = await employeeScopeFilter(req.authz!, req.auth.user);
  if (req.authz!.scope === 'all' && !requested) return null;
  const f: Record<string, unknown> = { deletedAt: null, ...filter };
  if (requested) f._id = requested;
  const rows = await Employee.find(f).select('_id').lean();
  if (requested && !rows.length) throw notFound('الموظف غير موجود');
  return rows.map((r) => r._id);
}

/** True when every id is inside the viewer's scope. */
export async function allInScope(req: AuthedRequest, employeeIds: string[]): Promise<boolean> {
  if (req.authz!.scope === 'all') return true;
  const filter = await employeeScopeFilter(req.authz!, req.auth.user);
  const n = await Employee.countDocuments({ _id: { $in: employeeIds }, deletedAt: null, ...filter });
  return n === new Set(employeeIds).size;
}
