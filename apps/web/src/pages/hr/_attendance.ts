import { useQuery } from '@tanstack/react-query';
import type { AttendanceDayStatus, LeaveType } from '@eayni/shared';
import { get } from '@/lib/api';
import i18n from '@/i18n';

/** Shared types and helpers of the attendance screens [HR §3.4]. */
export interface AttendanceDayRow {
  _id: string;
  employeeId: string;
  day: string;
  status: AttendanceDayStatus;
  scheduled: boolean;
  expectedStart?: string | null;
  expectedEnd?: string | null;
  firstInAt?: string | null;
  lastOutAt?: string | null;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  overtimeApprovedMinutes: number;
  permissionMinutes: number;
  punchCount: number;
  leaveType?: string | null;
  flags: string[];
  final: boolean;
  employee?: { _id: string; fullNameAr: string; employeeNumber: string; departmentId: string; positionId?: string };
}

export interface PunchRow {
  _id: string;
  type: 'in' | 'out';
  at: string;
  day: string;
  location?: { lat: number; lng: number; accuracyM?: number };
  siteId?: string | null;
  distanceM?: number | null;
  radiusM?: number | null;
  withinGeofence?: boolean | null;
  exceptionId?: string | null;
  source: string;
  flags: string[];
  reason?: string;
}

export interface DaysSummary {
  scheduledDays: number;
  presentDays: number;
  lateDays: number;
  absentDays: number;
  leaveDays: number;
  remoteDays: number;
  missingPunchDays: number;
  earlyLeaveDays: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  overtimeApprovedMinutes: number;
}

export interface AttendancePolicy {
  defaultShift: { code: string; nameAr: string; periods: { start: string; end: string }[]; ramadanPeriods: { start: string; end: string }[]; workDays: number[] } | null;
  geofenceDefaultRadiusM: number;
  locationPolicy: { requireLocation: boolean; maxAccuracyFactor: number; onUnavailable: string };
  rules: { graceMinutes: number; earlyLeaveGraceMinutes: number; missedCheckInAlertMinutes: number; missedCheckOutAlertMinutes: number };
  overtime: { requiresPreApproval: boolean; compensation: 'pay' | 'leave' | 'employee_choice'; rateBp: number };
  correction: { deadlineDays: number; perMonth: number | null };
  exceptionMaxDays: number;
  leavePolicies: Record<LeaveType, { entitlementDays: number | null; requiresAttachment: boolean; provisional: boolean; articleAr?: string }>;
  provisional: { shift: boolean; geofence: boolean; leave: boolean };
}

export const useAttendancePolicy = () =>
  useQuery({ queryKey: ['attendance', 'policy'], queryFn: () => get<AttendancePolicy>('/hr/attendance/policy'), staleTime: 5 * 60_000 });

export const dayStatusTone: Record<AttendanceDayStatus, 'slate' | 'green' | 'red' | 'amber' | 'blue' | 'brand'> = {
  present: 'green',
  late: 'amber',
  absent: 'red',
  on_leave: 'blue',
  remote: 'blue',
  weekend: 'slate',
  holiday: 'slate',
  missing_in: 'red',
  missing_out: 'amber',
  not_scheduled: 'slate',
};

/** Minutes as «ساعات:دقائق» with Latin digits (tabular columns). */
export function hm(minutes: number | undefined | null): string {
  if (!minutes) return '0:00';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Hours with one decimal for the cards. */
export const hours = (minutes: number | undefined | null) => Math.round(((minutes ?? 0) / 60) * 10) / 10;

/** Riyadh clock of an instant, HH:MM. */
export function clock(d: string | Date | undefined | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
}

export const statusLabel = (s: string) => i18n.t(`attendance.statuses.${s}`, s);
