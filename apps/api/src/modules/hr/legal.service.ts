import { normalizeArabic } from '@eayni/shared';
import type { EosPolicy, EosReason, HolidayKind, RetirementRule, WagePeriod } from '@eayni/shared';
import { ART80_ABSENCE, EOS_INITIATED_BY_EMPLOYEE, EOS_INITIATED_BY_EMPLOYER, EOS_NO_AWARD_REASONS, EOS_RESIGNATION_FRACTION_REASONS } from '@eayni/shared';
import { Holiday } from '../../core/dates/model';
import { riyadhDate, riyadhDayEndOf, riyadhDayStartOf } from '../../core/dates/businessDays';
import { addDays } from './attendance.service';
import { AttendanceDay } from './attendance.model';
import { HrRequest } from './requests.model';
import { DisciplinaryAction } from './performance.model';
import type { EmployeeDoc } from './model';

/**
 * The Labor-Law rules of H3b as pure functions (docs/HR_H3B_LEGAL.md — every rule cites its article; DECISIONS §22).
 * Days are Riyadh `YYYY-MM-DD`; money is integer halalas; rates are basis points. Nothing here invents a number: the
 * figures are the articles' own, the configurable ones come from `hr.eos`, `hr.retirement.rules`, `hr.saudization`.
 */
const DAY = 86_400_000;
export const daysDiff = (fromDay: string, toDay: string): number => Math.round((riyadhDayStartOf(toDay).getTime() - riyadhDayStartOf(fromDay).getTime()) / DAY);
const round = (n: number) => Math.round(n);

// ---------- nationality, age ----------
/** T3 / T6 / T9: a Saudi national — the nationality is free text on the file (DECISIONS §3 import). */
export function isSaudi(nationality: string | undefined | null): boolean {
  const n = normalizeArabic(nationality ?? '').toLowerCase();
  return n.includes('سعود') || n.includes('saudi');
}
/** T2 (arts. 162–163): full years of age on a day. */
export function ageOn(birthDay: string, onDay: string): number {
  const [by, bm, bd] = birthDay.split('-').map(Number);
  const [oy, om, od] = onDay.split('-').map(Number);
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age--;
  return age;
}

// ---------- T7: probation (art. 53 as amended 1446H) ----------
export const PROBATION_EXCLUDED_HOLIDAY_KINDS: readonly HolidayKind[] = ['eid_fitr', 'eid_adha', 'national_day', 'founding_day'];
/** A holiday without a `kind` is classified from its name so existing rows keep working. */
export function holidayKindOf(h: { kind?: string | null; nameAr: string }): HolidayKind {
  if (h.kind) return h.kind as HolidayKind;
  const n = normalizeArabic(h.nameAr);
  if (n.includes('الفطر')) return 'eid_fitr';
  if (n.includes('الاضحي') || n.includes('الأضحى')) return 'eid_adha';
  if (n.includes('الوطني')) return 'national_day';
  if (n.includes('التاسيس')) return 'founding_day';
  return 'other';
}
/**
 * The last day of a probation of `probationDays` counted days starting on `startDay`: each day in `excluded` (the four
 * official holidays, approved sick-leave days) extends the period by one day. 0 days → null (no probation).
 */
export function probationEndDay(startDay: string, probationDays: number, excluded: Set<string>): string | null {
  if (probationDays <= 0) return null;
  let counted = 0;
  let day = startDay;
  for (let guard = 0; guard < 400; guard++) {
    if (!excluded.has(day)) counted++;
    if (counted === probationDays) return day;
    day = addDays(day, 1);
  }
  return day;
}
/** The excluded days of an employee's probation window: typed holidays + approved sick leave (H2 requests). */
export async function probationExcludedDays(employeeId: unknown, fromDay: string, horizonDay: string): Promise<Set<string>> {
  const out = new Set<string>();
  const holidays = await Holiday.find({ date: { $gte: fromDay, $lte: horizonDay } }).lean();
  for (const h of holidays) if (PROBATION_EXCLUDED_HOLIDAY_KINDS.includes(holidayKindOf(h))) out.add(h.date);
  if (employeeId) {
    const sick = await HrRequest.find({
      employeeId,
      type: 'leave',
      deletedAt: null,
      'details.leaveType': 'sick',
      $or: [{ state: 'approved' }, { state: 'closed', 'decision.outcome': 'approved' }],
      'details.startDate': { $lte: riyadhDayEndOf(horizonDay) },
      'details.endDate': { $gte: riyadhDayStartOf(fromDay) },
    })
      .select('details')
      .lean();
    for (const r of sick) {
      const d = r.details as { startDate: Date; endDate: Date };
      for (let day = riyadhDate(d.startDate); day <= riyadhDate(d.endDate); day = addDays(day, 1)) out.add(day);
    }
  }
  return out;
}

// ---------- T9: fixed-term expiry (art. 55, art. 37) ----------
export type FixedTermOutcome = { kind: 'renew'; periodMonths: number; convertAfter: boolean } | { kind: 'convert_indefinite' } | { kind: 'needs_decision' } | { kind: 'renew_permit_period' };
/**
 * What happens when a fixed-term contract lapses and the employee keeps working.
 * (a) No renewal clause → indefinite at once (Saudi) / permit-period renewal (non-Saudi, art. 37) — but the «both parties
 * continued» fact is HR's to confirm, so the job marks `needs_decision` and HR applies `continueFixedTermContract`.
 * (b) Renewal clause → renew for the agreed period; 3 consecutive renewals or 4 years in total, whichever is less, → indefinite (Saudi).
 */
export function fixedTermExpiryOutcome(c: { renewalClause?: { enabled?: boolean | null; periodMonths?: number | null } | null; renewalCount?: number | null; originalStartDate?: Date | null; startDate: Date; endDate?: Date | null }, saudi: boolean): FixedTermOutcome {
  if (!c.renewalClause?.enabled) return { kind: 'needs_decision' };
  const period = c.renewalClause.periodMonths ?? Math.max(1, Math.round(((c.endDate?.getTime() ?? 0) - c.startDate.getTime()) / (30.44 * DAY)));
  const renewals = (c.renewalCount ?? 0) + 1;
  const start = c.originalStartDate ?? c.startDate;
  const totalMonthsAfter = Math.round(((c.endDate?.getTime() ?? c.startDate.getTime()) - start.getTime()) / (30.44 * DAY)) + period;
  const convertAfter = saudi && (renewals >= 3 || totalMonthsAfter >= 48);
  if (saudi && ((c.renewalCount ?? 0) >= 3 || Math.round(((c.endDate?.getTime() ?? 0) - start.getTime()) / (30.44 * DAY)) >= 48)) return { kind: 'convert_indefinite' };
  return { kind: 'renew', periodMonths: period, convertAfter };
}

// ---------- E2 / E3: notice (arts. 75, 76) ----------
export type EndingParty = 'employer' | 'employee' | 'law' | 'mutual';
export function initiatedByOf(reason: EosReason): EndingParty {
  if (EOS_INITIATED_BY_EMPLOYER.includes(reason)) return 'employer';
  if (EOS_INITIATED_BY_EMPLOYEE.includes(reason)) return 'employee';
  if (reason === 'mutual_agreement') return 'mutual';
  return 'law';
}
/** Art. 75 (as amended): monthly wage → 30 days from the employee, 60 from the employer; non-monthly → 30 for either. */
export function noticeRequiredDays(party: EndingParty, wagePeriod: WagePeriod, policy: EosPolicy): number {
  if (wagePeriod === 'non_monthly') return policy.noticeNonMonthlyDays;
  return party === 'employer' ? policy.noticeEmployerMonthlyDays : policy.noticeEmployeeMonthlyDays;
}
/** Only arts. 74(3) endings of an indefinite contract carry a notice duty. */
export const NOTICE_REASONS: readonly EosReason[] = ['employer_notice', 'employee_notice'];
export function noticeShortfallDays(noticeDay: string | undefined, lastWorkingDay: string, requiredDays: number): { givenDays: number; shortfallDays: number } {
  const given = noticeDay ? Math.max(0, daysDiff(noticeDay, lastWorkingDay)) : 0;
  return { givenDays: given, shortfallDays: Math.max(0, requiredDays - given) };
}
/** Art. 76: the wage of the notice period (or the part of it not observed). */
export const noticeCompensationHalalas = (monthlyWage: number, shortfallDays: number): number => round((monthlyWage * shortfallDays) / 30);

// ---------- E5: unlawful termination (art. 77) ----------
export function art77CompensationHalalas(contractType: string, monthlyWage: number, serviceDays: number, remainingDays: number): { amountHalalas: number; basisAr: string } {
  const minimum = monthlyWage * 2;
  if (contractType === 'fixed_term' || contractType === 'specific_work' || contractType === 'seasonal') {
    const amount = Math.max(round((monthlyWage * remainingDays) / 30), minimum);
    return { amountHalalas: amount, basisAr: `أجر المدة الباقية من العقد (${remainingDays} يوماً) وبحد أدنى أجر شهرين — المادة 77` };
  }
  const years = serviceDays / 365;
  const amount = Math.max(round(monthlyWage * (15 / 30) * years), minimum);
  return { amountHalalas: amount, basisAr: `أجر 15 يوماً عن كل سنة خدمة (${years.toFixed(2)} سنة) وبحد أدنى أجر شهرين — المادة 77` };
}

// ---------- E11–E14: the award (arts. 84–87, art. 2) ----------
/** Art. 84: ½ month per year for the first five years, a full month for each year after, pro-rata on fractions. */
export function eosAwardHalalas(awardWage: number, serviceDays: number): { amountHalalas: number; years: number; basisAr: string } {
  const years = serviceDays / 365;
  const firstFive = Math.min(years, 5);
  const beyond = Math.max(years - 5, 0);
  const amount = round(awardWage * (firstFive * 0.5 + beyond));
  return { amountHalalas: amount, years, basisAr: `نصف أجر شهر × ${firstFive.toFixed(2)} سنة + أجر شهر × ${beyond.toFixed(2)} سنة على الأجر الفعلي الأخير — المادة 84` };
}
/** Art. 85 fractions for a resignation (bp): none before 2 years, ⅓ 2–5, ⅔ 5–10, full after 10. */
export function resignationFractionBp(years: number): number {
  if (years < 2) return 0;
  if (years < 5) return 3334;
  if (years < 10) return 6667;
  return 10_000;
}
export function awardFractionBp(reason: EosReason, years: number): { bp: number; articleAr: string } {
  if (EOS_NO_AWARD_REASONS.includes(reason)) return { bp: 0, articleAr: 'المادة 80: لا مكافأة' };
  if (EOS_RESIGNATION_FRACTION_REASONS.includes(reason)) return { bp: resignationFractionBp(years), articleAr: 'المادة 85' };
  if (reason === 'probation') return { bp: resignationFractionBp(years), articleAr: 'المادتان 53 و85 (الخدمة أقل من سنتين عادةً)' };
  // arts. 81, 87, force majeure, expiry, employer-initiated endings, death, retirement: the full award.
  return { bp: 10_000, articleAr: reason === 'leaving_art81' ? 'المادة 81: المكافأة كاملة' : reason === 'marriage_or_birth_art87' || reason === 'force_majeure' ? 'المادة 87: المكافأة كاملة' : 'المادة 84' };
}
/** Art. 87 time limits: resignation within 6 months of marriage or 3 months of childbirth. */
export function art87WithinLimit(event: 'marriage' | 'birth', eventDay: string, endDay: string): boolean {
  const d = daysDiff(eventDay, endDay);
  return d >= 0 && d <= (event === 'marriage' ? 180 : 90);
}
/** E11: the award wage per art. 2 — basic + all allowances; commissions in unless the contract excludes them (art. 86, E13). */
export function awardWageOf(
  basic: number,
  allowances: { type?: string | null; amountHalalas?: number | null }[],
  opts: { commissionTypes: readonly string[]; excludeCommissions: boolean; commissionAverageHalalas?: number | null },
): { basicHalalas: number; allowancesHalalas: number; commissionsHalalas: number; totalHalalas: number; basisAr: string } {
  const isCommission = (t?: string | null) => !!t && opts.commissionTypes.map(normalizeArabic).includes(normalizeArabic(t));
  const fixed = allowances.filter((a) => !isCommission(a.type)).reduce((s, a) => s + (a.amountHalalas ?? 0), 0);
  const commissionOnFile = allowances.filter((a) => isCommission(a.type)).reduce((s, a) => s + (a.amountHalalas ?? 0), 0);
  const commissions = opts.excludeCommissions ? 0 : opts.commissionAverageHalalas ?? commissionOnFile;
  return {
    basicHalalas: basic,
    allowancesHalalas: fixed,
    commissionsHalalas: commissions,
    totalHalalas: basic + fixed + commissions,
    basisAr: opts.excludeCommissions
      ? 'الأجر الفعلي الأخير (المادة 2): الأساسي + البدلات؛ العمولات مستثناة بنص العقد (المادة 86)'
      : 'الأجر الفعلي الأخير (المادة 2): الأساسي + جميع البدلات + العمولات (متوسط)',
  };
}

// ---------- E15: settlement deadline (art. 88) ----------
export function settlementDueDay(lastWorkingDay: string, party: EndingParty, policy: EosPolicy): string {
  return addDays(lastWorkingDay, party === 'employer' || party === 'law' || party === 'mutual' ? policy.settlementDueEmployerDays : policy.settlementDueEmployeeDays);
}

// ---------- E25: resignation (art. 79 bis) ----------
export function resignationDeadlines(submittedAt: Date, policy: EosPolicy): { withdrawDeadline: Date; deemedAcceptedAt: Date; maxPostponeDay: string } {
  const day = riyadhDate(submittedAt);
  return {
    withdrawDeadline: riyadhDayEndOf(addDays(day, policy.resignationWithdrawDays)),
    deemedAcceptedAt: riyadhDayEndOf(addDays(day, policy.resignationDeemedAcceptedDays)),
    maxPostponeDay: addDays(day, policy.resignationMaxPostponeDays),
  };
}
/** The contract ends at the earliest of: explicit acceptance, 30 days without a response, the end of the postponement. */
export function resignationEndDay(r: { acceptedAt?: Date | null; deemedAcceptedAt?: Date | null; postponedUntil?: string | null; requestedLastWorkingDay?: string | null }): { day: string; kind: 'explicit' | 'deemed' | 'postponement_end' } {
  const candidates: { day: string; kind: 'explicit' | 'deemed' | 'postponement_end' }[] = [];
  if (r.acceptedAt) candidates.push({ day: riyadhDate(r.acceptedAt), kind: 'explicit' });
  if (r.postponedUntil) candidates.push({ day: r.postponedUntil, kind: 'postponement_end' });
  else if (r.deemedAcceptedAt) candidates.push({ day: riyadhDate(r.deemedAcceptedAt), kind: 'deemed' });
  candidates.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const first = candidates[0];
  // A requested later day is honoured only when the employer accepted and the employee asked for it.
  if (first.kind === 'explicit' && r.requestedLastWorkingDay && r.requestedLastWorkingDay > first.day && (!r.postponedUntil || r.requestedLastWorkingDay <= r.postponedUntil)) return { day: r.requestedLastWorkingDay, kind: 'explicit' };
  return first;
}

// ---------- E1: retirement (art. 74 → Social Insurance Law) ----------
export function retirementAgeFor(e: { gender?: string | null; gosiJoinDate?: Date | null }, rules: RetirementRule[]): number | null {
  const join = e.gosiJoinDate ? riyadhDate(e.gosiJoinDate) : null;
  const matching = rules.filter((r) => (r.gender ? r.gender === e.gender : true) && (r.gosiJoinedFrom ? !!join && join >= r.gosiJoinedFrom : true));
  if (!matching.length) return null;
  // The most specific row wins: a gender match over none, a later gosiJoinedFrom over an earlier or absent one.
  matching.sort((a, b) => (b.gender ? 1 : 0) - (a.gender ? 1 : 0) || (b.gosiJoinedFrom ?? '').localeCompare(a.gosiJoinedFrom ?? ''));
  return matching[0].ageYears;
}
export function retirementDay(birthDay: string, ageYears: number): string {
  const [y, m, d] = birthDay.split('-');
  return `${Number(y) + ageYears}-${m}-${d}`;
}

// ---------- T3: Saudization ----------
export function saudizationRatePct(saudiCount: number, total: number): number | null {
  return total ? Math.round((saudiCount / total) * 1000) / 10 : null;
}

// ---------- E6: art. 80(7) absence, from H2 attendance and the H3a written warning ----------
export interface AbsenceCheck {
  contractYearFrom: string;
  contractYearTo: string;
  intermittentDays: number;
  longestConsecutiveDays: number;
  qualifies: 'intermittent' | 'consecutive' | null;
  warningRequiredAfterDay: string | null;
  warningFound: boolean;
  ok: boolean;
  messageAr: string;
}
/** The contract year that contains `onDay`, counted from the anniversary of the (original) start. */
export function contractYearWindow(startDay: string, onDay: string): { from: string; to: string } {
  const [sy, sm, sd] = startDay.split('-');
  let year = Number(onDay.slice(0, 4));
  let from = `${year}-${sm}-${sd}`;
  if (from > onDay) {
    year--;
    from = `${year}-${sm}-${sd}`;
  }
  if (from < startDay) from = startDay;
  void sy;
  return { from, to: addDays(`${year + 1}-${sm}-${sd}`, -1) };
}
export async function art80AbsenceCheck(employee: EmployeeDoc, contractStart: Date, onDay: string): Promise<AbsenceCheck> {
  const win = contractYearWindow(riyadhDate(contractStart), onDay);
  const to = win.to < onDay ? win.to : onDay;
  const days = await AttendanceDay.find({ employeeId: employee._id, day: { $gte: win.from, $lte: to }, status: 'absent' }).select('day').sort({ day: 1 }).lean();
  const absentDays = days.map((d) => d.day);
  // Consecutive absence counts calendar-adjacent scheduled absences; a weekend between two absent days does not break the run (the article says «متتالية» of the worker's absence).
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  let warningAfterDayConsecutive: string | null = null;
  for (const d of absentDays) {
    run = prev && daysDiff(prev, d) <= 3 ? run + 1 : 1;
    if (run === ART80_ABSENCE.warningAfterConsecutive && !warningAfterDayConsecutive) warningAfterDayConsecutive = d;
    longest = Math.max(longest, run);
    prev = d;
  }
  const intermittent = absentDays.length;
  const qualifies = intermittent > ART80_ABSENCE.intermittentDays ? 'intermittent' : longest > ART80_ABSENCE.consecutiveDays ? 'consecutive' : null;
  const warningAfterDay = qualifies === 'intermittent' ? absentDays[ART80_ABSENCE.warningAfterIntermittent - 1] ?? null : qualifies === 'consecutive' ? warningAfterDayConsecutive : null;
  let warningFound = false;
  if (warningAfterDay) {
    warningFound = !!(await DisciplinaryAction.exists({
      employeeId: employee._id,
      kind: { $in: ['written_notice', 'warning_1', 'warning_2', 'final_warning'] },
      state: { $in: ['approved', 'delivered', 'appealed', 'objection_window', 'court_objection', 'upheld'] },
      deliveredAt: { $gte: riyadhDayStartOf(warningAfterDay), $lte: riyadhDayEndOf(onDay) },
    }));
  }
  const ok = !!qualifies && warningFound;
  const messageAr = !qualifies
    ? `الغياب في السنة العقدية (${win.from} – ${to}): ${intermittent} يوماً متفرقاً، أطول انقطاع ${longest} يوماً — لا يبلغ حد المادة 80(7) (أكثر من 30 متفرقة أو 15 متصلة)`
    : !warningFound
      ? `الغياب يبلغ الحد (${qualifies === 'intermittent' ? `${intermittent} يوماً متفرقاً` : `${longest} يوماً متصلاً`}) لكن لا إنذار كتابي مسجَّل بعد ${warningAfterDay} (بعد ${qualifies === 'intermittent' ? ART80_ABSENCE.warningAfterIntermittent : ART80_ABSENCE.warningAfterConsecutive} يوماً) — المادة 80(7)`
      : `تحققت شروط المادة 80(7): ${qualifies === 'intermittent' ? `${intermittent} يوماً متفرقاً` : `${longest} يوماً متصلاً`} مع إنذار كتابي بعد ${warningAfterDay}`;
  return { contractYearFrom: win.from, contractYearTo: win.to, intermittentDays: intermittent, longestConsecutiveDays: longest, qualifies, warningRequiredAfterDay: warningAfterDay, warningFound, ok, messageAr };
}

// ---------- E8 / E26: leave-based protections (arts. 82, 155) ----------
const APPROVED = { $or: [{ state: 'approved' }, { state: 'closed', 'decision.outcome': 'approved' }] };
async function approvedLeaveCovering(employeeId: unknown, leaveType: string, day: string) {
  const r = await HrRequest.findOne({ employeeId, type: 'leave', deletedAt: null, 'details.leaveType': leaveType, ...APPROVED, 'details.startDate': { $lte: riyadhDayEndOf(day) }, 'details.endDate': { $gte: riyadhDayStartOf(day) } })
    .select('number details')
    .lean();
  return r ? { number: r.number, details: r.details as { startDate: Date; endDate: Date } } : null;
}
/** Art. 155: pregnant (declared, not ended) or on maternity leave (approved, covering the day), or on sick leave while pregnant. */
export async function pregnancyProtection(employee: EmployeeDoc, day: string): Promise<{ protected: boolean; reasonAr?: string }> {
  if (employee.gender !== 'female') return { protected: false };
  const p = employee.pregnancy;
  if (p?.declaredAt && !p.endedAt) return { protected: true, reasonAr: `حمل مُبلَّغ (${riyadhDate(p.declaredAt)}، الوضع المتوقع ${p.expectedDeliveryDate ? riyadhDate(p.expectedDeliveryDate) : '—'})` };
  const maternity = await approvedLeaveCovering(employee._id, 'maternity', day);
  if (maternity) return { protected: true, reasonAr: `إجازة وضع معتمدة (${maternity.number})` };
  // A maternity leave approved for a later day means the pregnancy is known to the employer.
  const upcoming = await HrRequest.exists({ employeeId: employee._id, type: 'leave', deletedAt: null, 'details.leaveType': 'maternity', ...APPROVED, 'details.startDate': { $gte: riyadhDayStartOf(day) } });
  if (upcoming) return { protected: true, reasonAr: 'إجازة وضع معتمدة لاحقاً (الحمل معلوم لصاحب العمل)' };
  return { protected: false };
}
export const ART155_MESSAGE = 'لا يجوز فصل العاملة أو إنذارها بالفصل أثناء الحمل أو إجازة الوضع (المادة 155)';
/** Art. 82: an approved sick leave covering the end date while the sick balance is not exhausted. */
export async function sickLeaveProtection(employee: EmployeeDoc, day: string, sickBalanceDays: number): Promise<{ protected: boolean; reasonAr?: string }> {
  const sick = await approvedLeaveCovering(employee._id, 'sick', day);
  if (!sick) return { protected: false };
  if (sickBalanceDays <= 0) return { protected: false, reasonAr: 'إجازة مرضية جارية لكن الرصيد مستنفد (المادة 82 لا تمنع)' };
  return { protected: true, reasonAr: `إجازة مرضية معتمدة (${sick.number}) قبل استنفاد الرصيد (${sickBalanceDays} يوماً متبقياً) — المادة 82` };
}
/** E4 / O1: a notice dated inside any approved leave — a warning only. */
export async function noticeInsideApprovedLeave(employeeId: unknown, noticeDay: string): Promise<string | null> {
  const r = await HrRequest.findOne({ employeeId, type: 'leave', deletedAt: null, ...APPROVED, 'details.startDate': { $lte: riyadhDayEndOf(noticeDay) }, 'details.endDate': { $gte: riyadhDayStartOf(noticeDay) } }).select('number').lean();
  return r ? r.number : null;
}
