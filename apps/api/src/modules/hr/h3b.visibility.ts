import type { FilterQuery } from 'mongoose';
import type { Authz } from '../../core/http/context';
import type { UserDoc } from '../../core/auth/model';

/** Visibility filters shared by the routes and the export resources (HR_PLAN §6) — kept free of service imports. */
export function requisitionVisibility(user: UserDoc, authz: Authz): FilterQuery<unknown> {
  if (authz.scope === 'all') return {};
  const or: Record<string, unknown>[] = [{ requestedBy: user._id }];
  if (authz.scope === 'department' && authz.departmentIds.length) or.push({ departmentId: { $in: authz.departmentIds } });
  return { $or: or };
}
export function visibilityFilter(user: UserDoc, authz: Authz, employeeIdOfUser?: unknown): FilterQuery<unknown> {
  if (authz.scope === 'all') return {};
  const or: Record<string, unknown>[] = [{ requestedBy: user._id }];
  if (employeeIdOfUser) or.push({ employeeId: employeeIdOfUser });
  if (authz.scope === 'department' && authz.departmentIds.length) or.push({ departmentId: { $in: authz.departmentIds } });
  return { $or: or };
}
