import type { FilterQuery } from 'mongoose';
import { DocumentRecord } from '../../core/documents/model';
import { badRequest } from '../../core/http/errors';
import { Contract, Employee } from './model';

const DAY = 86_400_000;

export type ExpiringKind = 'contracts' | 'identities' | 'documents';
export const EXPIRING_KINDS: ExpiringKind[] = ['contracts', 'identities', 'documents'];
export const EXPIRING_KIND_AR: Record<ExpiringKind, string> = {
  contracts: 'عقد عمل',
  identities: 'هوية / إقامة',
  documents: 'وثيقة',
};

export interface ExpiringRow {
  kind: ExpiringKind;
  employeeId: string;
  fullNameAr: string;
  employeeNumber: string;
  departmentId?: unknown;
  titleAr: string;
  expiryDate: Date;
  daysLeft: number;
}

/**
 * Contracts, identities and employee documents that expire within `within` days [HR §3.9 «تقارير بالوثائق التي
 * قاربت على الانتهاء», HR §5 ثالثاً]. Shared by the dashboard drill-down and the Excel export resource, so both
 * show the same rows. Only the latest version of a document per owner and type counts (go-live review G5).
 */
export async function expiringRows(
  kinds: ExpiringKind[],
  within: number,
  employeeFilter: FilterQuery<unknown>,
  now = new Date(),
): Promise<ExpiringRow[]> {
  for (const k of kinds) if (!EXPIRING_KINDS.includes(k)) throw badRequest('نوع غير معروف');
  const until = new Date(now.getTime() + within * DAY);
  const employees = await Employee.find({
    deletedAt: null,
    status: { $nin: ['resigned', 'terminated'] },
    ...employeeFilter,
  })
    .select('fullNameAr employeeNumber departmentId identity.expiryDate identity.type')
    .lean();
  const byId = new Map(employees.map((e) => [String(e._id), e]));
  const ids = employees.map((e) => e._id);
  const row = (kind: ExpiringKind, employeeId: string, titleAr: string, expiryDate: Date) => {
    const e = byId.get(employeeId);
    if (!e) return undefined;
    return {
      kind,
      employeeId,
      fullNameAr: e.fullNameAr,
      employeeNumber: e.employeeNumber,
      departmentId: e.departmentId,
      titleAr,
      expiryDate,
      daysLeft: Math.ceil((expiryDate.getTime() - now.getTime()) / DAY),
    } as ExpiringRow;
  };
  const items: (ExpiringRow | undefined)[] = [];
  if (kinds.includes('contracts')) {
    const contracts = await Contract.find({
      employeeId: { $in: ids },
      status: { $in: ['active', 'renewing'] },
      endDate: { $ne: null, $lte: until },
    })
      .select('employeeId endDate number')
      .lean();
    items.push(...contracts.map((c) => row('contracts', String(c.employeeId), c.number, c.endDate!)));
  }
  if (kinds.includes('identities')) {
    items.push(
      ...employees
        .filter((e) => e.identity?.expiryDate && e.identity.expiryDate <= until)
        .map((e) =>
          row('identities', String(e._id), e.identity!.type ?? 'identity', e.identity!.expiryDate!),
        ),
    );
  }
  if (kinds.includes('documents')) {
    const docs = await DocumentRecord.find({
      deletedAt: null,
      ownerType: 'employee',
      ownerId: { $in: ids.map(String) },
      expiryDate: { $ne: null, $lte: until },
    })
      .select('ownerId type version titleAr expiryDate')
      .sort({ version: -1 })
      .lean();
    const latest = docs.filter(
      (r, i, arr) => arr.findIndex((x) => x.ownerId === r.ownerId && x.type === r.type) === i,
    );
    items.push(...latest.map((d) => row('documents', d.ownerId, d.titleAr, d.expiryDate!)));
  }
  return items
    .filter((x): x is ExpiringRow => !!x)
    .sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());
}
