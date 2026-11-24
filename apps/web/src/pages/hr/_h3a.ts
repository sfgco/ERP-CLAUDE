import type { AppraisalState, DisciplinaryState, GoalState, ParticipantStatus, PayrollRunState, TrainingState } from '@eayni/shared';
import i18n from '@/i18n';

/** Shared types and helpers of the H3a screens [HR §3.6–3.8]. Money is halalas on the wire, riyals on screen. */
export interface PayslipLine {
  code: string;
  labelAr: string;
  amountHalalas: number;
  days?: number;
  minutes?: number;
  note?: string;
}
export interface PayslipRow {
  _id: string;
  runId: string;
  period: string;
  employeeId: string;
  employeeNumber: string;
  fullNameAr: string;
  departmentId?: string;
  gosiGroup?: string;
  basicHalalas: number;
  earnings?: PayslipLine[];
  deductions?: PayslipLine[];
  grossHalalas: number;
  deductionsHalalas: number;
  netHalalas: number;
  gosiEmployeeHalalas: number;
  gosiEmployerHalalas: number;
  attendance?: { scheduledDays?: number; presentDays?: number; absentDays?: number; lateMinutes?: number; overtimeApprovedMinutes?: number; leaveDays?: number; unpaidLeaveDays?: number; missingPunchDays?: number };
  bankName?: string;
  bankLast4?: string;
  flags: string[];
  visibleToEmployeeAt?: string | null;
  run?: { number: string; period: string; state: PayrollRunState; cutoff?: { attendanceFrom?: string; attendanceTo?: string } };
}
export interface PayrollRunRow {
  _id: string;
  number: string;
  period: string;
  state: PayrollRunState;
  cutoff?: { attendanceFrom?: string; attendanceTo?: string };
  totals: { employeeCount: number; grossHalalas: number; deductionsHalalas: number; netHalalas: number; gosiEmployeeHalalas: number; gosiEmployerHalalas: number; overtimeHalalas: number };
  flags: string[];
  preparedBy?: string;
  preparedAt?: string;
  approvedAt?: string;
  frozenAt?: string;
  finance?: { decision?: string; at?: string; note?: string; paidAt?: string; paymentRef?: string };
  notes?: string;
  createdAt: string;
}
export interface PayrollRunDetail extends PayrollRunRow {
  actions: string[];
  provisional: boolean;
  payslips: PayslipRow[];
  stages: { _id: string; fromState?: string; toState: string; transition: string; at: string; actorEmail?: string; reason?: string }[];
}

export const runTone: Record<PayrollRunState, 'slate' | 'blue' | 'amber' | 'green' | 'red' | 'brand'> = {
  draft: 'slate',
  under_hr_review: 'blue',
  returned: 'amber',
  hr_approved: 'blue',
  at_finance: 'brand',
  finance_returned: 'amber',
  finance_approved: 'green',
  paid: 'green',
  closed: 'slate',
  cancelled: 'red',
};
export const appraisalTone: Record<AppraisalState, 'slate' | 'blue' | 'amber' | 'green' | 'red' | 'brand'> = {
  open: 'blue',
  manager_submitted: 'brand',
  returned: 'amber',
  approved: 'green',
  acknowledged: 'green',
  cancelled: 'red',
};
export const disciplineTone: Record<DisciplinaryState, 'slate' | 'blue' | 'amber' | 'green' | 'red' | 'brand'> = {
  draft: 'slate',
  pending_approval: 'blue',
  approved: 'brand',
  delivered: 'amber',
  appealed: 'amber',
  upheld: 'red',
  withdrawn: 'slate',
};
export const goalTone: Record<GoalState, 'slate' | 'blue' | 'amber' | 'green' | 'red' | 'brand'> = { draft: 'slate', active: 'blue', achieved: 'green', not_achieved: 'red', cancelled: 'slate' };
export const trainingTone: Record<TrainingState, 'slate' | 'blue' | 'amber' | 'green' | 'red' | 'brand'> = { planned: 'slate', open: 'blue', running: 'brand', completed: 'green', cancelled: 'red' };
export const participantTone: Record<ParticipantStatus, 'slate' | 'blue' | 'amber' | 'green' | 'red' | 'brand'> = { nominated: 'slate', registered: 'blue', attended: 'brand', completed: 'green', not_completed: 'red', withdrawn: 'slate' };

export const riyals = (halalas?: number | null) =>
  typeof halalas === 'number' ? `${(halalas / 100).toLocaleString('ar-SA-u-nu-latn', { minimumFractionDigits: 2 })} ${i18n.t('common.currency')}` : '—';
export const pct = (bp?: number | null) => (typeof bp === 'number' ? `${Math.round(bp) / 100}%` : '—');

export interface GoalRow {
  _id: string;
  employeeId: string;
  title: string;
  description?: string;
  weightBp: number;
  kpiCode?: string;
  kpiNameAr?: string;
  targetValue?: number;
  unit?: string;
  dueDate?: string;
  state: GoalState;
  percent: number;
  progress: { at: string; percent: number; note?: string; byEmail?: string }[];
  employee?: { fullNameAr: string; employeeNumber: string };
}
export interface AppraisalRow {
  _id: string;
  employeeId: string;
  cycleId: string;
  cycleName?: string;
  managerUserId?: string | null;
  state: AppraisalState;
  dueAt?: string;
  overallScoreBp?: number;
  overallRatingLabel?: string;
  managerNotes?: string;
  employeeComment?: string;
  hrNotes?: string;
  scores: { key: string; value: number; note?: string }[];
  goalsSnapshot?: { _id: string; title: string; weightBp: number; percent: number; kpiCode?: string }[];
  tasksCompletion?: { assigned: number; done: number; late: number; percentBp: number | null };
  improvementPlanId?: string | null;
  employee?: { fullNameAr: string; employeeNumber: string; departmentId?: string };
}
export interface Criterion {
  key: string;
  labelAr: string;
  weightBp: number;
  source: 'manual' | 'goals' | 'tasks';
}
export interface TemplateShape {
  _id?: string;
  nameAr: string;
  version?: number;
  sections: { titleAr: string; weightBp: number; criteria: Criterion[] }[];
  scale: { value: number; labelAr: string }[];
  improvementThresholdBp: number;
  active?: boolean;
}
export interface CycleRow {
  _id: string;
  year: number;
  kind: string;
  nameAr: string;
  from: string;
  to: string;
  opensAt: string;
  dueAt: string;
  templateId: string;
  state: 'planned' | 'open' | 'closed';
  counts?: Record<string, number>;
}
export interface PlanRow {
  _id: string;
  employeeId: string;
  appraisalId?: string;
  from: string;
  to: string;
  objectives: { text: string; measure?: string; dueDate?: string; done: boolean }[];
  reviews: { at: string; byEmail?: string; note: string; rating?: number }[];
  state: 'active' | 'completed' | 'not_completed' | 'cancelled';
  closingNote?: string;
  employee?: { fullNameAr: string; employeeNumber: string };
}
export interface DisciplinaryRow {
  _id: string;
  number: string;
  employeeId: string;
  kind: string;
  kindLabelAr: string;
  payrollEffect: string;
  fineDays?: number;
  fineHalalas?: number;
  suspensionDays?: number;
  violationDate: string;
  discoveryDate?: string;
  investigationEndDate?: string;
  separateViolation?: boolean;
  description: string;
  state: DisciplinaryState;
  deliveredAt?: string;
  appealDeadline?: string;
  appealDecisionDueAt?: string;
  appeal?: { at?: string; note?: string; outcome?: string; decisionNote?: string };
  employeeAck?: { at?: string; note?: string };
  employee?: { fullNameAr: string; employeeNumber: string };
  actions?: string[];
}
export interface TrainingRow {
  _id: string;
  number: string;
  title: string;
  providerName?: string;
  kind: 'internal' | 'external' | 'online';
  startAt: string;
  endAt: string;
  location?: string;
  description?: string;
  state: TrainingState;
  departmentIds: string[];
  costHalalas?: number;
  participants?: number;
  completed?: number;
}
export interface ParticipantRow {
  _id: string;
  trainingId: string;
  employeeId: string;
  status: ParticipantStatus;
  result?: string;
  certificateAttachmentId?: string;
  certificateName?: string;
  certificateUploadedAt?: string;
  employee?: { fullNameAr: string; employeeNumber: string; departmentId?: string };
  training?: TrainingRow;
}
export interface NeedRow {
  _id: string;
  departmentId: string;
  year: number;
  title: string;
  justification?: string;
  source: string;
  employeeIds: string[];
  priority: string;
  state: 'new' | 'accepted' | 'planned' | 'done' | 'rejected';
}
export interface TrainingPlanRow {
  _id: string;
  year: number;
  state: 'draft' | 'submitted' | 'approved' | 'closed';
  items: { title: string; departmentIds: string[]; quarter: number; estimatedCostHalalas: number; needIds: string[] }[];
  notes?: string;
  version: number;
  returnReason?: string;
}
