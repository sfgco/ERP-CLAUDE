import type { ApplicantStage, EosReason, InterviewState, OffboardingState, OfferState, RequisitionState, SettlementState } from '@eayni/shared';

/** Shared types and helpers of the H3b screens [HR §3.2, §3.10]. Money is halalas on the wire, riyals on screen. */
type Tone = 'slate' | 'blue' | 'amber' | 'green' | 'red' | 'brand';
export const riyals = (h?: number | null) => (typeof h === 'number' ? (h / 100).toLocaleString('ar-SA-u-nu-latn', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');

export const requisitionTone: Record<RequisitionState, Tone> = { draft: 'slate', submitted: 'amber', needs_completion: 'amber', approved: 'blue', posted: 'brand', closed: 'green', rejected: 'red', cancelled: 'slate' };
export const applicantTone: Record<ApplicantStage, Tone> = { new: 'slate', screened: 'blue', shortlisted: 'brand', interviewing: 'amber', offered: 'amber', hired: 'green', rejected: 'red', withdrawn: 'slate' };
export const interviewTone: Record<InterviewState, Tone> = { scheduled: 'blue', done: 'green', no_show: 'red', cancelled: 'slate' };
export const offerTone: Record<OfferState, Tone> = { draft: 'slate', pending_approval: 'amber', approved: 'blue', sent: 'brand', accepted: 'green', declined: 'red', expired: 'slate', withdrawn: 'slate', contracted: 'green', onboarded: 'green' };
export const offboardingTone: Record<OffboardingState, Tone> = { resignation_submitted: 'amber', resignation_postponed: 'amber', resignation_withdrawn: 'slate', requested: 'slate', under_review: 'amber', approved: 'blue', completed: 'green', rejected: 'red', cancelled: 'slate' };
export const settlementTone: Record<SettlementState, Tone> = { pending: 'slate', computed: 'amber', approved: 'blue', at_finance: 'brand', paid: 'green' };

export interface RequisitionRow {
  _id: string;
  number: string;
  titleAr: string;
  departmentId: string;
  departmentName?: string;
  positionTitle?: string;
  headcount: number;
  hiredCount: number;
  justification: string;
  requirements?: string;
  employmentType: string;
  contractType: string;
  durationMonths?: number;
  salaryRange?: { minHalalas: number; maxHalalas: number };
  neededBy?: string;
  recruitmentCosts: { labelAr: string; amountHalalas: number }[];
  requestedBy: string;
  needsExecutive: boolean;
  posting?: { channels: string[]; postedAt?: string; closesAt?: string; externalRefs: { channel: string; reference: string }[] };
  saudizationWarning?: string;
  state: RequisitionState;
  stateEnteredAt: string;
  dueAt?: string | null;
  createdAt: string;
}
export interface ApplicantRow {
  _id: string;
  requisitionId: string;
  fullNameAr: string;
  phone: string;
  email?: string;
  nationality: string;
  identityLast4?: string;
  birthDate?: string;
  source?: string;
  cvAttachmentId?: string;
  qualificationAr?: string;
  experienceYears?: number;
  expectedSalaryHalalas?: number;
  stage: ApplicantStage;
  rejectionReason?: string;
  notes?: string;
  retainUntil?: string;
  linkedEmployeeId?: string;
  previousEmployeeId?: string;
  createdAt: string;
}
export interface InterviewRow {
  _id: string;
  applicantId: string;
  round: number;
  scheduledAt: string;
  durationMinutes: number;
  mode: string;
  location?: string;
  panelUserIds: string[];
  state: InterviewState;
  scores: { criterion: string; value: number }[];
  totalScore?: number;
  recommendation?: string;
  notes?: string;
}
export interface OfferRow {
  _id: string;
  number: string;
  applicantId: string;
  applicantName?: string;
  requisitionId: string;
  departmentId: string;
  departmentName?: string;
  positionTitle?: string;
  employmentType: string;
  contractType: string;
  durationMonths?: number;
  workDescription?: string;
  probationDays: number;
  wagePeriod: string;
  basicSalaryHalalas?: number;
  allowances?: { type: string; amountHalalas: number }[];
  renewalClause?: { enabled: boolean; periodMonths?: number };
  awardExcludesVariableWage: boolean;
  awardExclusionClauseRef?: string;
  nonCompete?: { months: number; scopeAr: string };
  workPermit?: { number?: string; professionAr?: string; expiryDate?: string };
  startDate: string;
  validUntil: string;
  needsExecutive: boolean;
  flags: string[];
  response?: { at?: string; accepted?: boolean; note?: string; signedAttachmentId?: string };
  createdEmployeeId?: string;
  createdContractId?: string;
  govRegistration?: { qiwaRef?: string; qiwaAt?: string; gosiRef?: string; gosiAt?: string; at?: string };
  state: OfferState;
  createdAt: string;
}
export interface StageRow {
  _id: string;
  fromState?: string;
  toState: string;
  transition: string;
  at: string;
  actorEmail?: string;
  reason?: string;
}
export interface RequisitionDetail extends RequisitionRow {
  actions: string[];
  applicants: ApplicantRow[];
  interviews: InterviewRow[];
  offers: OfferRow[];
  stages: StageRow[];
}
export interface OfferDetail extends OfferRow {
  actions: string[];
  applicant: ApplicantRow | null;
  stages: StageRow[];
  temporaryPassword?: string;
}
export interface RecruitmentPolicy {
  postingChannels: { code: string; labelAr: string }[];
  interviewCriteria: { code: string; labelAr: string }[];
  scoreMin: number;
  scoreMax: number;
  rejectionReasons: { code: string; labelAr: string }[];
  cvRetentionMonths: number;
  maxProbationDays: number;
  minimumHireAge: number;
  provisional: boolean;
  saudization: { ratePct: number | null; below: boolean; warningAr: string | null; setting: { requiredRatePct: number | null; nitaqatBandAr: string | null } };
}

export interface SettlementLine {
  code: string;
  labelAr: string;
  kind: 'earning' | 'deduction';
  amountHalalas: number;
  basisAr?: string;
  articleAr?: string;
  computed: boolean;
  editReason?: string;
}
export interface OffboardingRow {
  _id: string;
  number: string;
  employeeId: string;
  employee?: { fullNameAr: string; employeeNumber: string; status?: string; gender?: string; nationality?: string; hireDate?: string; userId?: string };
  departmentName?: string;
  reason: EosReason;
  reasonLabel: string;
  initiatedBy: 'employer' | 'employee' | 'law' | 'mutual';
  art80Case?: string;
  art81Case?: string;
  hearing?: { heldAt: string; summary: string; employeeDeclined?: boolean };
  art87?: { event: string; eventDate: string; source: string; withinLimit: boolean };
  noticeDate?: string;
  lastWorkingDay: string;
  details?: string;
  notice?: { requiredDays: number; givenDays: number; shortfallDays: number; basisAr: string };
  legalWarnings: string[];
  resignation?: { submittedAt?: string; reason?: string; requestedLastWorkingDay?: string; withdrawDeadline?: string; deemedAcceptedAt?: string; postponedUntil?: string; postponeReason?: string; acceptedAt?: string; acceptanceKind?: string; withdrawnAt?: string };
  steps?: Record<string, { done?: boolean; at?: string }>;
  settlement?: {
    state: SettlementState;
    lines: SettlementLine[];
    earningsHalalas?: number;
    deductionsHalalas?: number;
    netHalalas?: number;
    awardWage?: { basicHalalas: number; allowancesHalalas: number; commissionsHalalas: number; totalHalalas: number; commissionsExcluded: boolean; clauseRef?: string; basisAr?: string };
    serviceDays?: number;
    serviceYears?: number;
    awardFraction?: number;
    dueAt?: string;
    computedAt?: string;
    approvedAt?: string;
    finance?: { paidAt?: string; paymentRef?: string; note?: string };
    provisional?: boolean;
    flags: string[];
  };
  custodyChecklist: { custodyId: string; itemName: string; returnedAt?: string; condition?: string; notReturned?: boolean; chargeHalalas?: number }[];
  it?: { taskId?: string; requestedAt?: string; confirmedAt?: string; note?: string; assetsReturned?: boolean };
  exitInterview?: { templateVersion?: number; answers: { key: string; value: unknown }[]; at?: string; declined?: boolean };
  experienceCertificate?: { number?: string; attachmentId?: string; issuedAt?: string };
  gov?: { gosiExitRef?: string; gosiExitAt?: string; qiwaExitRef?: string; qiwaExitAt?: string; finalExitRef?: string };
  retention?: { keepUntil?: string };
  completedAt?: string;
  state: OffboardingState;
  stateEnteredAt: string;
  dueAt?: string | null;
  createdAt: string;
}
export interface OffboardingDetail extends OffboardingRow {
  actions: string[];
  contract?: { number: string; type: string; startDate: string; endDate?: string; probationEndDate?: string; wagePeriod?: string; nonCompete?: { months: number; scopeAr: string }; awardExcludesVariableWage?: boolean; awardExclusionClauseRef?: string; originalStartDate?: string } | null;
  custody: { _id: string; itemName: string; assetTag?: string; returnedAt?: string; condition?: string }[];
  events: { _id: string; type: string; fromState?: string; toState?: string; step?: string; note?: string; data?: Record<string, unknown>; actorEmail?: string; at: string }[];
  stages: StageRow[];
}
export interface EosPolicyView {
  policy: { approverRole: string; settlementApproverRole: string; resignationDeemedAcceptedDays: number; resignationMaxPostponeDays: number; resignationWithdrawDays: number; retentionYears: number; commissionAverageMonths: number };
  provisional: boolean;
  reasons: { code: EosReason; labelAr: string }[];
  art80Cases: { code: string; n: number; labelAr: string }[];
  art81Cases: { code: string; n: number; labelAr: string }[];
  exitInterviewTemplate: { version: number; questions: { key: string; labelAr: string; kind: 'text' | 'rating' | 'yes_no' }[] };
  warnNoticeDuringLeave: boolean;
  legalSettings: { complete: boolean; missing: { key: string; labelAr: string }[] };
}
