import { Types, type ClientSession } from 'mongoose';
import {
  LEAVE_TYPES,
  LEAVE_TYPE_AR,
  type LeaveLedgerEntryInput,
  type LeavePolicies,
  type LeavePolicy,
  type LeaveType,
} from '@eayni/shared';
import { badRequest, notFound } from '../../core/http/errors';
import type { Actor } from '../../core/http/context';
import { recordAudit } from '../../core/audit/service';
import { getSettingMeta } from '../../core/settings/service';
import { riyadhDate } from '../../core/dates/businessDays';
import { Employee, type EmployeeDoc } from './model';
import { LeaveLedger } from './attendance.model';
import { addDays, daysBetween } from './attendance.service';
import { ON_DUTY_STATUSES } from './service';

const DAY_MS = 86_400_000;

/** Leave policies with the provisional flag of the whole setting (DECISIONS §21: «مؤقت حتى اعتماد الموارد البشرية»). */
export async function leavePolicies(): Promise<{ policies: LeavePolicies; provisional: boolean }> {
  const meta = await getSettingMeta('hr.leave.policies');
  return { policies: meta.value, provisional: meta.provisional };
}

/** Calendar days of a leave, inclusive (Labor Law counts leave in calendar days). Whole days only (Q7). */
export function leaveDaysCount(startDate: Date, endDate: Date): number {
  return Math.round((Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()) -
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())) / DAY_MS) + 1;
}

/** Years of service at a date (for the five-year annual entitlement, art. 109). */
export function serviceYears(hireDate: Date, at: Date): number {
  return (at.getTime() - hireDate.getTime()) / (365.25 * DAY_MS);
}

export function entitlementFor(policy: LeavePolicy, employee: Pick<EmployeeDoc, 'hireDate'>, at: Date): number | null {
  if (policy.entitlementDays === null) return null;
  if (policy.entitlementAfter5YearsDays !== null && serviceYears(employee.hireDate, at) >= 5)
    return policy.entitlementAfter5YearsDays;
  return policy.entitlementDays;
}

/** Sum of the ledger for one type and year. */
export async function balance(employeeId: unknown, leaveType: LeaveType, year: number): Promise<number> {
  const rows = await LeaveLedger.aggregate<{ total: number }>([
    { $match: { employeeId: new Types.ObjectId(String(employeeId)), leaveType, year } },
    { $group: { _id: null, total: { $sum: '$days' } } },
  ]);
  return round2(rows[0]?.total ?? 0);
}
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface BalanceRow {
  leaveType: LeaveType;
  labelAr: string;
  entitlementDays: number | null;
  accrued: number;
  taken: number;
  balance: number;
  provisional: boolean;
  articleAr?: string;
}
/** «رصيد الإجازات» per type for a year: entitlement, accrued so far, taken, balance, and the provisional marker. */
export async function balancesFor(employee: EmployeeDoc, year: number, at = new Date()): Promise<BalanceRow[]> {
  const { policies, provisional } = await leavePolicies();
  const rows = await LeaveLedger.aggregate<{ _id: { leaveType: string; entryType: string }; total: number }>([
    { $match: { employeeId: new Types.ObjectId(String(employee._id)), year } },
    { $group: { _id: { leaveType: '$leaveType', entryType: '$entryType' }, total: { $sum: '$days' } } },
  ]);
  const sum = (type: string, pred: (entry: string) => boolean) =>
    round2(rows.filter((r) => r._id.leaveType === type && pred(r._id.entryType)).reduce((s, r) => s + r.total, 0));
  return LEAVE_TYPES.map((leaveType) => {
    const p = policies[leaveType];
    return {
      leaveType,
      labelAr: LEAVE_TYPE_AR[leaveType],
      entitlementDays: entitlementFor(p, employee, at),
      accrued: sum(leaveType, (e) => e !== 'taken' && e !== 'returned'),
      taken: -sum(leaveType, (e) => e === 'taken' || e === 'returned'),
      balance: sum(leaveType, () => true),
      provisional: provisional || p.provisional,
      articleAr: p.articleAr,
    };
  });
}

/** HR writes an opening balance / adjustment / carry-over with a reason — audited, append-only. */
export async function addLedgerEntry(input: LeaveLedgerEntryInput, actor: Actor) {
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null }).select('_id').lean();
  if (!employee) throw notFound('الموظف غير موجود');
  const row = await LeaveLedger.create({
    employeeId: employee._id,
    leaveType: input.leaveType,
    entryType: input.entryType,
    days: input.days,
    year: input.year,
    effectiveAt: new Date(),
    refType: 'manual',
    note: input.note,
    actorUserId: actor.userId,
    actorEmail: actor.email,
  });
  await recordAudit(actor, {
    action: 'create',
    resource: 'hr.leave',
    resourceId: String(row._id),
    after: { employeeId: String(employee._id), leaveType: input.leaveType, entryType: input.entryType, days: input.days, year: input.year },
  });
  return row;
}

/** CSV-style import of opening balances by employee number (DECISIONS §3). Unknown numbers are reported, not inserted. */
export async function importOpeningBalances(
  year: number,
  rows: { employeeNumber: string; leaveType: LeaveType; days: number; note?: string }[],
  actor: Actor,
): Promise<{ inserted: number; skipped: { employeeNumber: string; reason: string }[] }> {
  const skipped: { employeeNumber: string; reason: string }[] = [];
  let inserted = 0;
  for (const r of rows) {
    const e = await Employee.findOne({ employeeNumber: r.employeeNumber, deletedAt: null }).select('_id').lean();
    if (!e) {
      skipped.push({ employeeNumber: r.employeeNumber, reason: 'employee_not_found' });
      continue;
    }
    const dup = await LeaveLedger.exists({ employeeId: e._id, leaveType: r.leaveType, year, entryType: 'opening' });
    if (dup) {
      skipped.push({ employeeNumber: r.employeeNumber, reason: 'opening_exists' });
      continue;
    }
    await LeaveLedger.create({
      employeeId: e._id,
      leaveType: r.leaveType,
      entryType: 'opening',
      days: r.days,
      year,
      effectiveAt: new Date(),
      refType: 'import',
      refId: `${year}:${r.employeeNumber}:${r.leaveType}`,
      note: r.note ?? 'رصيد افتتاحي مستورد',
      actorUserId: actor.userId,
      actorEmail: actor.email,
    });
    inserted++;
  }
  await recordAudit(actor, { action: 'create', resource: 'hr.leave', meta: { import: true, year, inserted, skipped: skipped.length } });
  return { inserted, skipped };
}

type LeaveDetails = { leaveType: LeaveType; startDate: Date; endDate: Date; eventDate?: Date; reason: string };

/**
 * Leave-request rules at creation [HR §3.5.1, DECISIONS §21 Q7]: balance (refuse / flag / allow per policy), the longest
 * request, the 2025 event rules (birth leave within 7 days; maternity covering 6 weeks after the birth) and the
 * attachment requirement (flagged, not refused). Returns the flags for HR.
 */
export async function validateLeaveRequest(details: LeaveDetails, employee: EmployeeDoc, attachmentCount: number): Promise<string[]> {
  const { policies } = await leavePolicies();
  const policy = policies[details.leaveType];
  const flags: string[] = [];
  const days = leaveDaysCount(details.startDate, details.endDate);
  if (policy.maxDaysPerRequest !== null && days > policy.maxDaysPerRequest)
    throw badRequest(`الحد الأقصى لهذا النوع ${policy.maxDaysPerRequest} يوماً (${policy.articleAr ?? ''})`.trim());
  if (details.eventDate) {
    const ev = riyadhDate(details.eventDate);
    const start = riyadhDate(details.startDate);
    const end = riyadhDate(details.endDate);
    if (policy.startWithinDaysOfEvent !== null && (start < ev || start > addDays(ev, policy.startWithinDaysOfEvent)))
      throw badRequest(`يجب أن تبدأ الإجازة خلال ${policy.startWithinDaysOfEvent} أيام من تاريخ الواقعة (${policy.articleAr ?? ''})`.trim());
    if (policy.minDaysAfterEvent !== null && (start > ev || end < addDays(ev, policy.minDaysAfterEvent - 1)))
      throw badRequest(`يجب أن تغطي الإجازة تاريخ الواقعة و${policy.minDaysAfterEvent} يوماً بعده على الأقل (${policy.articleAr ?? ''})`.trim());
  }
  const year = Number(riyadhDate(details.startDate).slice(0, 4));
  const entitlement = entitlementFor(policy, employee, details.startDate);
  if (entitlement === null) {
    if (policy.provisional) flags.push('leave_policy_provisional');
    else flags.push('leave_balance_unset');
  } else if (policy.overBalance !== 'allow') {
    // No ledger row at all for this type and year = HR has not loaded the balance yet (DECISIONS §3 migration):
    // flag for HR instead of refusing everyone until the opening balances arrive.
    const initialised = await LeaveLedger.exists({ employeeId: employee._id, leaveType: details.leaveType, year });
    if (!initialised) flags.push('leave_balance_unset');
    const available = initialised ? await balance(employee._id, details.leaveType, year) : Number.POSITIVE_INFINITY;
    if (days > available) {
      if (policy.overBalance === 'refuse')
        throw badRequest(`الرصيد المتاح من إجازة «${LEAVE_TYPE_AR[details.leaveType]}» ${available} يوماً، والمطلوب ${days}`, {
          code: 'over_balance',
          available,
          requested: days,
        });
      flags.push('over_balance');
    }
  }
  if (policy.requiresAttachment && attachmentCount === 0) flags.push('attachment_missing');
  if (policy.provisional && !flags.includes('leave_policy_provisional')) flags.push('leave_policy_provisional');
  return flags;
}

/** On approval: the `taken` ledger row (idempotent on the request id) inside the approval transaction. */
export async function onLeaveApproved(
  request: { _id: unknown; employeeId: unknown; details: Record<string, unknown>; number: string },
  actor: Actor,
  session: ClientSession | undefined,
): Promise<{ from: string; to: string }> {
  const d = request.details as unknown as LeaveDetails;
  const start = new Date(d.startDate);
  const end = new Date(d.endDate);
  const days = leaveDaysCount(start, end);
  const exists = await LeaveLedger.exists({ employeeId: request.employeeId, leaveType: d.leaveType, refType: 'hr_request', refId: String(request._id) }).session(session ?? null);
  if (!exists)
    await LeaveLedger.create(
      [
        {
          employeeId: request.employeeId,
          leaveType: d.leaveType,
          entryType: 'taken',
          days: -days,
          year: Number(riyadhDate(start).slice(0, 4)),
          effectiveAt: start,
          refType: 'hr_request',
          refId: String(request._id),
          note: `${request.number}: ${riyadhDate(start)} → ${riyadhDate(end)}`,
          actorUserId: actor.userId,
          actorEmail: actor.email,
        },
      ],
      { session },
    );
  return { from: riyadhDate(start), to: riyadhDate(end) };
}

/**
 * Daily job «استحقاق الإجازات»: monthly accrual (1/12 of the entitlement, annual leave) on the first run of each
 * Riyadh month and yearly accrual (sick leave) on the first run of each year, for on-duty employees. Idempotent through
 * the ledger's unique (employee, type, refType, refId) key.
 */
export async function runLeaveAccrual(now = new Date()): Promise<number> {
  const { policies } = await leavePolicies();
  const today = riyadhDate(now);
  const year = Number(today.slice(0, 4));
  const month = today.slice(0, 7);
  const employees = await Employee.find({
    deletedAt: null,
    status: { $in: [...ON_DUTY_STATUSES, 'suspended'] },
    hireDate: { $lte: now },
  }).select('_id hireDate employmentType');
  let inserted = 0;
  for (const e of employees) {
    if (e.employmentType === 'contractor') continue; // DECISIONS §21 Q18: contractors outside payroll and accrual
    for (const leaveType of LEAVE_TYPES) {
      const p = policies[leaveType];
      if (p.accrual === 'none') continue;
      const entitlement = entitlementFor(p, e as EmployeeDoc, now);
      if (entitlement === null) continue;
      const refId = p.accrual === 'monthly' ? month : String(year);
      // The hire month accrues too (pro-rata is a policy question — whole twelfths until HR says otherwise).
      if (p.accrual === 'monthly' && riyadhDate(e.hireDate).slice(0, 7) > month) continue;
      const dup = await LeaveLedger.exists({ employeeId: e._id, leaveType, refType: 'accrual', refId });
      if (dup) continue;
      await LeaveLedger.create({
        employeeId: e._id,
        leaveType,
        entryType: 'accrual',
        days: p.accrual === 'monthly' ? round2(entitlement / 12) : entitlement,
        year,
        effectiveAt: now,
        refType: 'accrual',
        refId,
        note: p.accrual === 'monthly' ? `استحقاق شهر ${month}` : `استحقاق سنة ${year}`,
        actorUserId: undefined,
        actorEmail: 'system',
      });
      inserted++;
    }
  }
  return inserted;
}

/** Days of approved leave inside a window, per employee (the «في إجازة» cards and the leave-taken report). */
export function leaveDaysInWindow(start: Date, end: Date, from: string, to: string): number {
  const s = riyadhDate(start);
  const e = riyadhDate(end);
  const lo = s > from ? s : from;
  const hi = e < to ? e : to;
  return hi < lo ? 0 : daysBetween(lo, hi).length;
}
