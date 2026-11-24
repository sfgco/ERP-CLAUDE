# HR module [HR] — completion plan, data model, workflows, hand-offs and open questions

Written 2026-11-24 from the whole `# HR — الموارد البشرية` chapter of `docs/SPECS.md` (§1–§9), `CLAUDE.md`, `docs/DECISIONS.md` (§3, §5, §6, §7, §11–§13, §18, §19) and `docs/PHASE1.md`, and from the HR code on `main` as merged on 2026-11-24 (`7617a3e`, Sales S1–S5 included). Owner decision 2026-11-24: HR is completed right after Sales, in the four HR §8 phases (DECISIONS §7). **No HR code is written until the owner approves this plan and answers (or defers with the proposed default) the questions in §11.** Prompt: `docs/prompts/hr.md`.

**Approved by the owner on 2026-11-24**, including §10 and the H3a/H3b split, with the defaults of §11 and the corrections recorded in **DECISIONS §21** (Q5 overtime compensation mode, Q7 2025 leave amendments, Q8 GOSI effective-dated rates by join date, Q16–Q18 answered, provisional values marked «مؤقت حتى اعتماد الموارد البشرية»). H1 started the same day with the sample sites.

Conventions: Arabic labels in «…» are verbatim from the spec and go into the `ar` locale unchanged. Money is integer halalas, durations are integer minutes, leave is counted in days (half days only if Q7 says so). Times and day boundaries are Asia/Riyadh. Everything the spec leaves to «السياسات المعتمدة», «الصلاحيات» or «وفق الإجراءات المعتمدة» is a setting, a workflow definition or an admin-managed list, never a constant. Labor-law figures below are **proposals with the article number**, used only after the owner confirms them (prompt §0).

---

## 1. Scope

**Built here (slices H1–H4, HR §8 order)**
- H1 — audit of what phase 1 built (§3.1, §3.3, §3.5, §3.9, §4, §5, §6) against the spec, `docs/HR_COVERAGE.md` filled from the code, the gaps fixed. Branches and sites seeded once Q2 is answered.
- H2 — work schedules and shifts, GPS check-in/out with geofences, the employee attendance screen (375 px first), violations and alerts as jobs, leave balances (ledger), attendance reports on the core export builder, the two new request types (attendance correction, geofence exception).
- H3 — payroll runs with the thin Finance stage, performance (goals ↔ department KPIs, appraisals, improvement plans, disciplinary actions), training (plan, needs, courses, participation, certificates), recruitment (requisition → offer → employee file without retyping), end of service (request → settlement → custody → IT task → exit interview → certificate → «منتهي الخدمة» → retention). Split into **H3a** (payroll, performance, training) and **H3b** (recruitment, end of service) — see §9.
- H4 — the full HR dashboard (§5, every card drills down), the export scope of §4, every HR route in `/api/v1/docs` with its permission, integration tests with Finance / IT / KPI / tasks / calendar / notifications, 375 px check of attendance, requests, payslips and tasks, and `docs/HR_GOV_INTEGRATIONS.md` (study only).
- Thin stages on the **same HR record and number** for **المالية** (payroll run review / approval / return / payment recorded) and **التقنية** (close accounts and collect assets, confirmed by IT), as Sales did for Procurement / Finance / Operations. Each emits an outbox event so the real modules take the stage over later (golden rule 6).

**Not built here (and why)**
- The Finance module (FIN) and the IT assets module (IT §7.3): their thin stages only. The payroll bank file (WPS / Mudad) is a later integration (Q8); Finance records what it did outside the system.
- Qiwa / GOSI / Mudad integration: §7 item 12 asks for a study; `docs/HR_GOV_INTEGRATIONS.md` plus adapter seams (a `GovRegistration` record per employee filled by hand). No API calls.
- A phone app: the API is designed for it (HR §3.4 intro, §7 items 2 and 10); the web screens are built phone-first. Offline support is an open CLAUDE.md decision.
- PDF rendering: payslips, settlements and certificates render as RTL HTML until the headless-Chromium function exists (DECISIONS §1 item 11), like the current certificates.
- Employee import from ERPNext and opening leave balances as a bulk load: the ledger accepts an `opening` entry per employee from a screen and from a CSV import endpoint, but the ERPNext extraction itself is not built (DECISIONS §3, Q7).
- Biometric devices: the spec says GPS from the ERP site; a device adapter can post punches to the same append-only endpoint later (`source: 'device'`), nothing more now.

---

## 2. What phase 1 built, and the gaps found so far (H1 input)

Read from the code on 2026-11-24, not from memory. The full table is H1's deliverable; this is what the plan already knows.

| HR § | Exists (phase 1) | Gap or question for H1 |
|---|---|---|
| §3.1 items 1–10 | departments / units / branches / sites (GeoJSON point + `geofenceRadiusM`) / positions; `directManagerId`; `employmentType`; status list (DECISIONS §6); transfer, promotion, manager change with append-only `employeeEvents`; the employee notified | Branches and sites are sample data only (Q2). Item 4 «الوصف الوظيفي»: positions carry `descriptionAr` and the file holds a `job_description` document — confirm both count. |
| §3.3 | all fifteen basic fields; the seven document types with versions and sensitivity; custody register; field-level rules; history; expiry alerts | **«نوع الدوام» (§3.3, §4 example) and «نوع التوظيف» (§3.1.6) are one field today, `employmentType` (دوام كامل / جزئي / متعاقد / متدرب / أخرى).** Proposal: keep one field labelled «نوع التوظيف» in the file and «نوع الدوام» in the export (the spec's own words in each place), and add in H2 the separate **work schedule** («جدول الدوام», the shift assignment) which is what «نوع الدوام» would otherwise mean. Owner to confirm (Q1 note). |
| §3.5 | the eight types with their exact fields, `HRQ-` numbers, routes as a setting, stage SLA, certificates, action log, Finance hand-off of the advance | No draft step («حفظ كمسودة» §7.5): the core drafts store exists since Sales; H1 wires the request form to it. Official letters have no template (DECISIONS §13) — stays ⏸. Leave requests do not check a balance (H2). |
| §3.6 items 1, 9 | salary, allowances, bank data on the file, encrypted / field-ruled; audited views | items 2–8 are H3a. H1 adds `gosiJoinDate` to the file (DECISIONS §21 Q8). |
| §3.7 promotions + notice | `promotion` events, EP §15 notification | the rest is H3a. |
| §3.9 | contracts with renewal chain, documents with versions, alerts 90/30/7, `/hr/expiring`, contract status job | «استخراج تقارير بالوثائق التي قاربت على الانتهاء» exists as a screen; H1 adds an export resource `hr.documents_expiring` so it is also an Excel report. |
| §3.10 item 6 | daily job disables the account after the last working day | items 1–5, 7–10 are H3b. |
| §4 | field-picker export: resources `employees`, `employee_reports`, `users`; permission-filtered fields; sensitive flags audited; preview + Excel | §4 steps 1–2 «اختيار القسم أو الفرع» and «تحديد الموظفين المستهدفين»: the filters cover department / branch / status / nationality; **an explicit employee multi-select is missing** → H1. «وجود تأمين طبي» is a field on the file (`medicalInsurance`) — check it is exported. |
| §5 | headcount by department / branch / nationality / contract type / status; expiries 30/60/90; open requests by type / pending party / age; probation; changes last 30 days | **Request cards show open / by type / by age, not «الجديدة، المعلقة، المعتمدة، المرفوضة، التي تحتاج إلى استكمال»** → H1 adds the five counts (period filter, default this month) with drill-down. «عدد الموظفين في إجازة» comes from status today; H2 switches it to approved leave covering today. Attendance and performance cards: H2 / H3 / H4. |
| §6 | six roles as in the spec, team scope derived from the org chart, department manager scoped, admin without financial rights, roles editable | Nothing missing in the matrix itself; new resources per slice (§6 below). |
| §7 | audit log, in-app notifications, drafts store (core), API document (core/openapi since S5), multi-branch fields | §7.12 study is H4. Backups are configuration (`docs/DEPLOY.md`). |

---

## 3. Data model

Owner of every collection below: **`modules/hr`** (only HR writes them; Finance and IT act through HR service functions on the HR record — golden rule 2, DECISIONS §20 pattern). Append-only collections are inserted, never updated or deleted; business records use soft delete (`deletedAt`) only. Every write is audited; views of salary, deduction, advance, IBAN, identity and settlement figures are audited as sensitive (DECISIONS §19).

### 3.1 Attendance [HR §3.4]
| Collection | Purpose and key fields | Indexes | Append-only |
|---|---|---|---|
| `shifts` | «فترات الدوام»: `code`, `nameAr`, `kind` (fixed / rotating / field / flexible — Q1), `periods[]` {`start` "HH:MM", `end` "HH:MM", `crossesMidnight`}, `workDays[]` (0–6), `weeklyRestDays[]` (default Fri–Sat), `ramadanPeriods[]` (Q1), `graceMinutes`, `active`, `notes` | `{code}` unique | no (versioned: a change writes `shiftVersions` row) |
| `shiftAssignments` | «إسناد الموظفين إلى فترات العمل» and «ربط الموظفين بفروعهم ومواقع تشغيلهم»: `employeeId`, `shiftId`, `siteIds[]` (several for field staff, §3.4 ثانياً 8), `branchId`, `from`, `to` (null = current), `reason`, `createdBy`. A change closes the current row (`to`) and inserts the next — the history is the collection itself | `{employeeId, from: -1}`, `{shiftId, to}` | yes (closing `to` is the only update) |
| `attendancePunches` | «تسجيل الوقت والتاريخ تلقائياً» and «تسجيل الموقع المرتبط بكل عملية»: `employeeId`, `type` (in / out), `at` (**server time**), `day` (Riyadh `YYYY-MM-DD`), `location` {`lat`, `lng`, `accuracyM`} or `null` with `locationError` (denied / unavailable / timeout), `siteId` matched, `distanceM`, `withinGeofence`, `exceptionId` (when outside but allowed), `source` (web / mobile / correction / device / manual_hr), `correctionRequestId`, `idempotencyKey`, `ip`, `userAgent` | `{employeeId, at: -1}`, `{employeeId, day}`, `{employeeId, idempotencyKey}` unique sparse | **yes** |
| `attendanceDays` | the computed day per employee (a **recomputable cache** of the punches, schedule, leave and holidays — the punches stay the truth): `employeeId`, `day`, `shiftId`, `expectedStart`, `expectedEnd`, `firstInAt`, `lastOutAt`, `status` (present / late / absent / on_leave / remote / weekend / holiday / missing_in / missing_out / not_scheduled), `lateMinutes`, `earlyLeaveMinutes`, `workedMinutes`, `overtimeMinutes`, `overtimeApprovedMinutes`, `leaveRequestId`, `computedAt`, `version`, `lockedByPayrollRunId` | `{employeeId, day}` unique, `{day, status}` | no (recomputed until a payroll run locks the day; locked days are never recomputed) |
| `attendanceExceptions` | an approved «استثناء معتمد» (§3.4 ثانياً 6) written when the geofence-exception request is approved: `employeeId`, `from`, `to`, `scope` (any_location / site / remote), `siteId`, `requestId`, `approvedBy`, `reason` | `{employeeId, from, to}` | yes |

**Attendance corrections and geofence exceptions are HR request types**, not a separate collection (prompt §2 "reuse the HR request machinery where they fit"): `hrRequests` gains `attendance_correction` («طلب تعديل بصمة أو معالجة تسجيل مفقود») and `geofence_exception` («طلب استثناء من النطاق الجغرافي»), with their own detail schemas, in the same `HRQ-` series, the same inbox and the same DECISIONS §5 routing setting. Approval of a correction **inserts** a punch (`source: 'correction'`) and recomputes the day; the original punch is never edited. See §10 point 1.

### 3.2 Leave [HR §3.5.1, Q7]
| Collection | Purpose and key fields | Indexes | Append-only |
|---|---|---|---|
| `leaveBalances` | the **ledger**: `employeeId`, `leaveType`, `entryType` (opening / accrual / taken / returned / adjustment / carryover / expiry / encashment), `days` (signed), `year`, `effectiveAt`, `refType` + `refId` (hr request, payroll run, offboarding), `note`, `actorUserId`. Balance = sum; the service exposes `balance(employeeId, type, at)` and a cached view | `{employeeId, leaveType, effectiveAt}`, `{refType, refId}` | **yes** |
| `leavePolicies` (settings-backed, admin screen; includes the overtime-compensation leave type of DECISIONS §21 Q5) | per leave type: entitlement rule, accrual (monthly / yearly / none), carry-over cap, paid %, requires attachment, max days, who may take it — all **unset until Q7** | — | versioned setting |

### 3.3 Payroll [HR §3.6]
| Collection | Purpose and key fields | Indexes | Append-only |
|---|---|---|---|
| `payrollRuns` | «مسير الرواتب الشهري»: `number` `PAY-YYYY-#####`, `period` `YYYY-MM`, `cutoff` {`attendanceFrom`, `attendanceTo`}, `state` (workflow §4.5), `preparedBy`, `reviewedBy`, `approvedBy`, `finance` {`decision`, `by`, `at`, `note`, `paidAt`, `paymentRef`, `proofAttachmentId`}, totals {`gross`, `deductions`, `net`, `employerGosi`, `employeeCount`} (computed), `frozenAt`, `notes`, workflow fields | `{period}` unique partial (`state ∉ {cancelled}`), `{state}` | no (frozen after approval: the service refuses every write except the Finance stage fields and `closed`) |
| `payslips` | one per employee per run, a **snapshot**: `runId`, `employeeId`, `employeeNumber`, `departmentId`, `basicHalalas`, `allowances[]`, `earnings[]` (overtime, adjustments), `deductions[]` (absence, lateness, advance_instalment, gosi_employee, adjustment, other — each with `code`, `label`, `minutes`/`days`, `amountHalalas`, `sourceRef`), `gosiEmployerHalalas`, `grossHalalas`, `netHalalas`, `attendance` {days present / absent / late minutes / overtime minutes / leave days}, `bankLast4`, `visibleToEmployeeAt` | `{runId, employeeId}` unique, `{employeeId, runId}` | **yes** once the run is approved (editable only while the run is draft / under review, by recompute) |
| `payrollAdjustments` | «التعديل يدخل في المسير التالي»: `employeeId`, `kind` (earning / deduction), `amountHalalas`, `reason`, `sourceRunId`, `sourcePayslipId`, `consumedByRunId`, `createdBy` | `{employeeId, consumedByRunId}` | **yes** (consumption sets one field once) |
| `advanceSchedules` | instalments of an approved advance (`hrRequests` type advance): `requestId`, `employeeId`, `totalHalalas`, `instalments[]` {`period`, `amountHalalas`, `payslipId`} | `{employeeId}`, `{requestId}` unique | plan rows are inserted on approval; `payslipId` set once per instalment |
| `payrollPolicies` (settings) | allowance and deduction catalogues, GOSI rates by nationality group, absence / lateness formulas, overtime rate, deduction cap, cut-off and pay dates — **all unset until Q8** | — | versioned setting |

### 3.4 Performance [HR §3.7]
| Collection | Purpose and key fields | Indexes | Append-only |
|---|---|---|---|
| `goals` | «الأهداف الوظيفية لكل موظف»: `employeeId`, `cycleId`, `title`, `description`, `weightBp`, `kpiCode` (a code from the core KPI registry, e.g. `sales.revenue`, so a goal **links to a department KPI**), `targetValue`, `unit`, `dueDate`, `state` (draft / active / achieved / not_achieved / cancelled), `setBy`, `agreedByEmployeeAt`; `progress[]` append-only entries {`at`, `percent`, `note`, `by`} | `{employeeId, cycleId}`, `{kpiCode}` | progress entries yes; the goal row is versioned by `goalEvents` |
| `appraisalCycles` | «نصف سنوي وسنوي»: `year`, `kind` (semi_annual_1 / semi_annual_2 / annual), `from`, `to`, `opensAt`, `dueAt`, `templateId`, `state` (planned / open / closed) — dates from Q11 | `{year, kind}` unique | no |
| `appraisalTemplates` | the configurable form (golden rule 10): `nameAr`, `version`, `sections[]` → `criteria[]` {`labelAr`, `weightBp`, `scaleId`}, `scales[]` {`labelAr`, `points[]` {`value`, `labelAr`}}, `includeGoals`, `includeTasksCompletion`, `active` | `{nameAr, version}` unique | versioned (a change is a new version; cycles pin a version) |
| `appraisals` | one per employee per cycle: `employeeId`, `cycleId`, `templateVersionId`, `managerUserId` (direct manager at opening), `state` (workflow §4.6), `goalsSnapshot[]`, `tasksCompletion` {assigned, done, late} (from core tasks), `scores[]` {criterionId, value, note}, `overallScore`, `overallRatingLabel`, `managerNotes` («ملاحظات المدير المباشر»), `employeeComment`, `hrNotes`, `approvedBy`, `acknowledgedAt`, `improvementPlanId` | `{employeeId, cycleId}` unique, `{cycleId, state}` | no (frozen at approval; `appraisalEvents` append-only) |
| `improvementPlans` | «خطط تحسين الأداء»: `employeeId`, `appraisalId`, `from`, `to` (duration per Q11), `objectives[]` {text, measure, dueDate, status}, `reviews[]` append-only {`at`, `by`, `note`, `rating`}, `state` (active / completed / not_completed / cancelled), `ownerUserId` (direct manager), `hrFollowerUserId` | `{employeeId, state}` | reviews yes |
| `disciplinaryActions` | «الإنذارات والإجراءات الإدارية»: `employeeId`, `number` `DIS-YYYY-#####`, `kind` (from the configurable ladder, Q11), `violationDate`, `description`, `evidenceAttachmentIds`, `issuedBy`, `state` (workflow §4.7), `approvedBy`, `deliveredAt`, `employeeAck` {at, note}, `appeal` {at, note, outcome}, `payrollEffect` (none / fine → `payrollAdjustments`) | `{employeeId, violationDate}`, `{number}` unique | no (`disciplinaryEvents` append-only) |

### 3.5 Training [HR §3.8]
| Collection | Purpose and key fields | Indexes | Append-only |
|---|---|---|---|
| `trainingPlans` | «خطة تدريب سنوية»: `year`, `state` (draft / submitted / approved / closed), `items[]` {`title`, `departmentIds`, `quarter`, `estimatedCostHalalas`, `needIds`}, `submittedBy`, `approvedBy` (Q12), `budgetHalalas` (read-only from Finance later) | `{year}` unique | no (versioned) |
| `trainingNeeds` | «الاحتياجات التدريبية لكل قسم»: `departmentId`, `year`, `title`, `justification`, `source` (department / appraisal / plan), `appraisalId` (the §3.8.3 link), `employeeIds[]`, `priority`, `state` (new / accepted / planned / done / rejected), `requestedBy` | `{departmentId, year}` | no |
| `trainings` | «الدورة»: `number` `TRN-YYYY-#####`, `title`, `provider` {`partyId` or `nameAr`} (Q12), `kind` (internal / external / online), `startAt`, `endAt`, `location`, `planItemId`, `departmentIds`, `costHalalas`, `calendarEventId`, `state` (planned / open / running / completed / cancelled) | `{startAt}`, `{number}` unique | no |
| `trainingParticipants` | «حالة المشاركة والإكمال» per employee: `trainingId`, `employeeId`, `status` (nominated / registered / attended / completed / not_completed / withdrawn), `result`, `certificateAttachmentId`, `taskId` (the course appears in «مهامي»), `nominatedBy` | `{trainingId, employeeId}` unique, `{employeeId}` | no |

### 3.6 Recruitment [HR §3.2]
| Collection | Purpose and key fields | Indexes | Append-only |
|---|---|---|---|
| `jobRequisitions` | «طلب احتياج وظيفي»: `number` `REQ-YYYY-#####`, `departmentId`, `positionId` / `titleAr`, `headcount`, `justification`, `employmentType`, `contractType`, `salaryRange` (sensitive), `requestedBy`, `state` (workflow §4.3; **draft** supported), `approvals` via stage log, `posting` {`channels[]`, `postedAt`, `closesAt`, `externalRefs[]`} (Q10), `hiredCount`, `closedAt` | `{number}` unique, `{departmentId, state}` | no |
| `applicants` | «المرشحون»: `requisitionId`, `fullNameAr`, `phone`, `email`, `nationality`, `identityLast4` (encrypted full number optional), `cvAttachmentId`, `source`, `stage` (new / screened / shortlisted / interviewing / offered / hired / rejected / withdrawn), `rejectionReason`, `notes`, `retainUntil` (PDPL, Q10), `linkedEmployeeId` | `{requisitionId, stage}`, `{email}`, `{phone}` | no (`applicantEvents` append-only) |
| `interviews` | «جدولة المقابلات وتسجيل نتائجها»: `applicantId`, `round`, `scheduledAt`, `mode`, `panelUserIds[]`, `calendarEventId`, `state` (scheduled / done / no_show / cancelled), `scores[]` {criterion, value} (Q10), `recommendation` (proceed / reject / hold), `notes` | `{applicantId, round}` | no |
| `offers` | «العرض الوظيفي»: `number` `OFR-YYYY-#####`, `applicantId`, `positionId`, `departmentId`, `directManagerId`, `employmentType`, `contractType`, `durationMonths`, `probationMonths`, `basicSalaryHalalas`, `allowances[]` (sensitive), `startDate`, `validUntil`, `state` (workflow §4.4), `approvedBy`, `sentAt`, `response` {at, accepted, note, signedAttachmentId}, `createdEmployeeId`, `createdContractId`, `govRegistration` {`qiwaRef`, `gosiRef`, `recordedBy`, `at`} (§3.2 item 10, by hand) | `{number}` unique, `{applicantId}` | no |

### 3.7 End of service [HR §3.10]
| Collection | Purpose and key fields | Indexes | Append-only |
|---|---|---|---|
| `offboardings` | `number` `EOS-YYYY-#####`, `employeeId`, `kind` (resignation / termination / contract_end / death / other — Q9 reasons list), `reason`, `requestedBy`, `noticeDate`, `lastWorkingDay`, `state` (workflow §4.8), `settlement` {`components[]` (eos_award, unused_leave, pending_salary, allowances, deductions, advances_outstanding, other), `totalHalalas`, `computedAt`, `approvedBy`, `paidAt`, `proofAttachmentId`} (sensitive), `custodyChecklist[]` {custodyId, returnedAt, condition}, `it` {`taskId`, `requestedAt`, `confirmedAt`, `confirmedBy`, `note`}, `exitInterview` {`templateVersion`, `answers[]`, `interviewerUserId`, `at`}, `experienceCertificate` {requestId, certificateId}, `retention` {`keepUntil`} (Q14), `completedAt` | `{number}` unique, `{employeeId}`, `{state}` | no (`offboardingEvents` append-only; every step logged) |
| `exitInterviewTemplates` | the questions (Q13), versioned | — | versioned |

### 3.8 Core additions
- `core/kpi`: a **registry** of KPI definitions (code, nameAr, unit, direction, module) so a goal's `kpiCode` is validated and labelled; Sales registers its five, HR registers its own (§7). No new computation here.
- `core/calendar`: event kinds `training` (exists) and `interview`; `core/tasks`: source types `training`, `offboarding_it`.
- `core/numbering`: prefixes `PAY`, `DIS`, `TRN`, `REQ`, `OFR`, `EOS` (HRQ, CRT exist).
- `core/settings`: group «الموارد البشرية» gains the keys in §8.
- `core/export`: resources in §7.5.

---

## 4. Workflows (core workflow engine, editable in `/admin/workflows`)

Every transition is a conditional update on the current state inside one transaction with the stage log, the action log, the audit row and the outbox event (DECISIONS §14.B). Nobody decides their own request (DECISIONS §14.A). SLAs are in business days (Fri–Sat + `holidays`). Labels in «…» are the spec's words; labels marked *(proposed)* are not in the spec and the owner may rename them.

### 4.1 Attendance correction — `hr_request` type `attendance_correction` [HR §3.4 ثالثاً 10, رابعاً 6]
Same nine states as §3.5 («جديد … مغلق»). Route default (Q6): **via the direct manager, then HR** (`hr.requestRoutes.attendance_correction = {viaManager: true, finalApprover: 'hr'}`). Fields: `day`, `kind` (missing_in / missing_out / wrong_time), `requestedAt` (HH:MM), `reason`, attachments. Validations: the day is within `hr.attendance.correctionDeadlineDays` (Q6), not locked by payroll, the count this month is under `hr.attendance.correctionsPerMonth` (Q6, unset = no limit, flagged). On «معتمد»: insert the punch, recompute the day, notify the employee. SLA 2 business days per stage (existing setting).

### 4.2 Geofence exception — `hr_request` type `geofence_exception` [HR §3.4 ثانياً 6]
Same states. Route default (Q3): **direct manager, then HR**. Fields: `from`, `to` (max `hr.attendance.exceptionMaxDays`, Q3), `scope` (any_location / site / remote), `siteId`, `reason`, attachments. On «معتمد»: insert an `attendanceExceptions` row; punches in the window outside the geofence are accepted and marked `exceptionId`. An approved **remote work** request (§3.5.3) creates the same exception row for its days (so remote days punch from anywhere and count as `remote`) — owner to confirm in Q3.

### 4.3 Job requisition — `hr_requisition` [HR §3.2 items 1–4, additional requirements]
| State | Label | Category | Owner |
|---|---|---|---|
| draft | مسودة *(spec: «حفظ طلب التوظيف كمسودة»)* | open | requester |
| submitted | بانتظار الاعتماد *(proposed)* | open | approver (Q10) — SLA 3 |
| needs_completion | يحتاج استكمال | waiting | requester |
| approved | معتمد | open | HR officer — SLA 2 to post |
| posted | معلن عنها *(proposed)* | open | HR officer |
| closed | مغلق | done | — |
| rejected | مرفوض | done | — |
| cancelled | ملغي | done | — |
Transitions: `submit` (requester), `return` (approver, reason), `approve` / `reject` (approver, reason on reject), `post` (HR, channels), `close` (HR, when hired count reached or by decision), `cancel` (requester before approval, HR manager after). Notifications: approver on submit; requester on each decision; HR on approval; department manager when posted and when closed.

### 4.4 Offer — `hr_offer` [HR §3.2 items 7–9]
| State | Label | Owner |
|---|---|---|
| draft | مسودة | HR officer |
| pending_approval | بانتظار الاعتماد *(proposed)* | approver (Q10) — SLA 2 |
| approved | معتمد | HR officer |
| sent | أُرسل للمرشح *(proposed)* | applicant (outside the system) |
| accepted | قبل المرشح العرض *(spec: «موافقة المرشح على العرض الوظيفي»)* | HR officer — contracting |
| declined | رفض المرشح *(proposed)* | — |
| expired | منتهي الصلاحية *(proposed)* | — |
| withdrawn | مسحوب *(proposed)* | — |
| contracted | تم التعاقد *(spec: «استكمال إجراءات التعاقد»)* | HR officer — gov registration |
| onboarded | تمت المباشرة *(proposed)* | done |
`accept` records the applicant's acceptance (date, signed file); `contract` **creates the employee file, the contract, the user account (temporary password) and the custody-free file in one transaction from the offer and applicant data — no retyping** (golden rule 2); the applicant becomes `hired` and the requisition's `hiredCount` increments; `record_gov_registration` stores the Qiwa / GOSI references by hand (§3.2 item 10); `onboard` on the start date (job) sets `onboarded` and notifies the direct manager. Salary fields on the offer are sensitive (default deny).

### 4.5 Payroll run — `hr_payroll_run` [HR §3.6 items 2–8, FIN §12]
| State | Label | Owner | SLA |
|---|---|---|---|
| draft | مسودة | preparer (HR officer) | — |
| under_hr_review | قيد مراجعة الموارد البشرية *(spec: «مراجعة مسير الرواتب قبل اعتماده»)* | HR manager | 2 |
| returned | أُعيد للتعديل *(proposed)* | preparer | — |
| hr_approved | معتمد من الموارد البشرية *(proposed)* | HR manager → auto `send_to_finance` | — |
| at_finance | بانتظار اعتماد المالية (PRC §4 / FIN §5 «بانتظار الاعتماد» — the thin Finance stage) | finance_manager | 3 |
| finance_returned | يحتاج استكمال (FIN §5) | HR manager | — |
| finance_approved | معتمد (FIN §5) | finance (payment) | per Q8 pay date |
| paid | مدفوع (FIN §5) | — | — |
| closed | مغلق | — | — |
| cancelled | ملغي | — | — |
Rules: `prepare` computes the payslips from the salary master, the locked `attendanceDays` of the cut-off window, approved overtime, approved leave, advance instalments and unconsumed `payrollAdjustments`; `recompute` is allowed only in draft / returned; **`submit_for_review` locks the attendance days**; `hr_approve` **freezes** the run and its payslips (`frozenAt`) and publishes `hr.payroll.sent_to_finance`; the preparer cannot approve (`preparedBy ≠ approvedBy`), the HR approver cannot record payment, and the Finance approver cannot be the one who records payment (`finance.decision.by ≠ finance.paidBy`) — FIN §12; `finance_return` reopens only the Finance fields with a reason and goes back to the HR manager, who may `cancel` the run (a cancelled run unlocks its days and a new run is prepared — a correction is never an edit); `record_payment` stores date, reference and proof; payslips become visible to employees at `paid` (Q8 may say at `finance_approved`); `close` by HR. Notifications: HR manager on submit; preparer on return; Finance manager and staff on `at_finance`; HR manager on Finance decision; every employee «صدرت قسيمة راتبك» *(proposed)* when visible.

### 4.6 Appraisal — `hr_appraisal` [HR §3.7 «تقييم الأداء نصف سنوي وسنوي»]
| State | Label | Owner | SLA |
|---|---|---|---|
| open | مفتوح *(proposed)* | direct manager | cycle `dueAt` |
| manager_submitted | بانتظار مراجعة الموارد البشرية *(proposed)* | HR manager | 3 |
| returned | أُعيد للمدير *(proposed)* | direct manager | — |
| approved | معتمد | employee (acknowledge) | 5 |
| acknowledged | تم إشعار الموظف *(proposed)* | — | — |
| cancelled | ملغي | — | — |
Opening a cycle creates one appraisal per on-duty employee hired before the cycle's cut-off (setting `hr.appraisal.minServiceDays`, Q11), pinned to the direct manager at that moment (a transfer moves it — the DECISIONS §11.4 handler). The manager scores the criteria, records «نتائج التقييم وملاحظات المدير المباشر», sees the goals snapshot and the tasks completion rate; HR reviews and approves; the employee acknowledges and may add a comment; a result under the template's threshold **offers** an improvement plan (not automatic — Q11). No self-assessment step unless Q11 asks for one.

### 4.7 Disciplinary action — `hr_disciplinary` [HR §3.7 «الإنذارات والإجراءات الإدارية وفق الصلاحيات», Labor Law arts. 66–73 (proposal)]
| State | Label | Owner |
|---|---|---|
| draft | مسودة | issuer (direct manager or HR — Q11) |
| pending_approval | بانتظار الاعتماد *(proposed)* | HR manager (Q11) — SLA 2 |
| approved | معتمد | HR officer (deliver) |
| delivered | تم إبلاغ الموظف *(proposed, art. 72 written notice)* | employee (acknowledge / appeal within `hr.discipline.appealDays`) |
| appealed | قيد الاعتراض *(proposed)* | HR manager |
| upheld / withdrawn | مثبت / مسحوب *(proposed)* | — |
The ladder (kinds, order, when a kind may repeat, payroll effect) is the setting `hr.discipline.ladder` — empty until Q11. A fine kind writes a `payrollAdjustments` row on `upheld` / acknowledged. The spec's «وفق الصلاحيات» → resource `hr.discipline` (create: issuer roles; approve: HR manager by default).

### 4.8 End of service — `hr_offboarding` [HR §3.10 items 1–10]
| # | State | Label *(all proposed unless marked)* | Owner | What happens |
|---|---|---|---|---|
| 1–2 | requested | طلب إنهاء خدمة | requester (HR officer; or the employee's resignation via «رفع طلب» — Q9) | reason and `lastWorkingDay` (§3.10 items 1–2) |
| 3 | under_review | قيد المراجعة | HR manager — SLA 3 | «مراجعة واعتماد الإجراء» → `approve` sets the employee status to مستقيل / منتهي الخدمة with the last working day (existing DECISIONS §11.3 behaviour) and starts the parallel steps below; `reject` with reason |
| 4 | settlement | إعداد المخالصة النهائية | HR officer → HR manager approves (Q9) | computed per Q9 (arts. 84–85, 111), editable lines with reason, sensitive, frozen at approval |
| 5 | custody_return | استرداد العهد | HR officer | each open custody row returned with condition (existing custody return); IT assets later |
| 6 | it_closure | إغلاق الصلاحيات والحسابات | **IT (thin stage)**: a core task in the IT department queue + the record's IT panel; IT confirms | `hr.offboarding.it_requested` on entering; `hr.offboarding.it_confirmed` on IT's confirmation; the account deactivation job (exists) still runs after the last day |
| 7 | exit_interview | مقابلة الخروج | HR officer | answers to the Q13 template, interviewer, date (§3.10 item 7) |
| 8 | — | شهادة الخبرة عند الطلب | employee / HR | an `experience_certificate` request (exists) linked to the offboarding; also available to HR after the last day |
| 9 | completed | منتهي الخدمة (spec status) | — | all steps done and last working day passed → employee status «منتهي الخدمة», `completedAt`, retention `keepUntil` (Q14); file kept read-only (§3.10 item 10) |
| — | cancelled | ملغي | HR manager | reverts the status (existing behaviour re-enables the account) |
Steps 4–7 run in parallel after approval (each has its own `done` flag and actor); `complete` requires all four and a passed last working day. Every step is a stage-log row and notifies the next owner (HR, IT managers, the employee, the direct manager).

---

## 5. Hand-offs and events (outbox, delivered by the worker; unhandled events parked and replayed when the module subscribes — DECISIONS §14.B)

| Hand-off | Event(s) | Payload | Consumer now | Consumer later |
|---|---|---|---|---|
| Payroll to Finance [HR §3.6.7, FIN §11] | `hr.payroll.sent_to_finance`, `hr.payroll.finance_decided`, `hr.payroll.paid` | run number, period, totals, employee count (no per-employee figures in the event) | notifications to `finance_manager` / `finance_staff`; Finance thin queue «مسيرات الرواتب الواردة» *(proposed)* | the Finance module (expense of type رواتب, payment, FIN §6) |
| Advances to Finance (exists) [HR §3.5.6] | `hr.request.handoff.finance` | — | exists | Finance disbursement; H3a adds the instalment schedule on approval |
| End of service to IT [HR §3.10.6] | `hr.offboarding.it_requested`, `hr.offboarding.it_confirmed` | offboarding number, employee, last working day, custody summary | a core task in the IT department queue + notification to IT managers; IT confirms on the record | the IT module (assets IT §7.3, accounts) |
| Accepted offer to a new employee file [HR §3.2.8–9] | `hr.employee.hired` | employee id, offer, requisition | same transaction creates employee + contract + user; the event notifies the direct manager and HR | onboarding checklists; IT asset provisioning |
| Approved leave to attendance and balance [HR §3.5.1, §3.4] | `hr.leave.approved`, `hr.leave.cancelled` | request, type, days | **same transaction**: `leaveBalances` `taken` row and `attendanceDays` marked `on_leave`; the event feeds the manager-dashboard «في إجازة» and «away until» (DECISIONS §15) | payroll (unpaid leave deduction) reads the ledger directly |
| Approved permission / remote work [HR §3.5.2–3] | `hr.request.approved` (exists) | — | H2: a permission excuses lateness / early leave inside its window; remote work creates the exception row (§4.2) | — |
| Approved overtime (Q5) | `hr.overtime.approved` | employee, day, minutes | `attendanceDays.overtimeApprovedMinutes` | payroll line |
| Appraisal approved [HR §3.7] | `hr.appraisal.approved` | employee, cycle, score | notification; training needs may link to it (§3.8.3) | — |
| Training scheduled / completed [HR §3.8] | `hr.training.scheduled`, `hr.training.completed` | training, participants | calendar event (EP §13.6 «إضافة دورة تدريبية», exists) + a task per participant in «مهامي» (EP §10) | — |
| Disciplinary fine upheld | `hr.discipline.payroll_effect` | adjustment | `payrollAdjustments` | — |
| Payroll locks attendance | (internal) | — | `attendanceDays.lockedByPayrollRunId` | — |

Notification types added (all in-app now, email behind the adapter — DECISIONS §9): missed check-in / check-out, punch refused outside the geofence, correction decided, exception decided, leave balance low *(optional, Q7)*, payroll run submitted / returned / at Finance / decided / paid, payslip available, appraisal cycle opened / due / submitted / approved / acknowledgement requested, improvement plan review due, disciplinary action for approval / delivered / appeal, requisition submitted / decided / posted / closed, interview scheduled (participants), offer for approval / accepted / declined, employee hired (manager), offboarding requested / approved / IT task / IT confirmed / settlement approved / completed, training nominated / reminder / certificate due. Each one gets an Arabic title and a locale label, checked by a hygiene test as in Sales (`sal14-notifications.test.ts` pattern).

---

## 6. Permissions (resource × action × scope, field rules — no new engine)

New resources in `packages/shared/permissions.ts` and the grants per system role (DECISIONS §19: sensitive fields default deny; code-defined field rules):

| Resource | employee | direct manager (derived, team) | department_manager (department) | hr_officer | hr_manager | finance_staff / finance_manager | IT staff / manager (department `it`) | executive | system_admin |
|---|---|---|---|---|---|---|---|---|---|
| `hr.shifts` (schedules, assignments) | view own assignment | view team | view department | view/create/edit all | all | — | — | view | view |
| `hr.attendance` (punches, days) | view own, **create own punch** | view team | view department | view/edit (manual punch with reason, audited)/export all | all | — | — | view all | — |
| `hr.attendance.reports` | — | view team | view department | view/export all | all | — | — | view/export | — |
| `hr.leave` (balances) | view own | view team | view department | view/edit (opening, adjustment with reason) all | all | — | — | view | — |
| `hr.payroll` (runs) | — | — | — | view/create/edit (prepare) all | view/approve/export all | **`finance.payroll`**: staff view + return; manager view/approve/record payment | — | view totals | — |
| `hr.payslips` | **view own** | — | — | view all | view/export all | view all | — | — | — |
| `hr.goals` | view own, update progress | view/create/edit team | view department | view all | all | — | — | view | — |
| `hr.appraisals` | view own (approved), acknowledge | view/edit team (score) | view department (read) | view/approve all | all | — | — | view | — |
| `hr.improvement_plans` | view own | view/create/edit team | view department | view all | all | — | — | view | — |
| `hr.discipline` | view own (delivered), appeal | create team (Q11) | view department | view/create/edit all | approve all | — | — | view | — |
| `hr.training` (plans, needs, courses) | view own participation, upload certificate | view team, nominate | view department, **create needs** | all | approve plan (Q12) | — | — | view | — |
| `hr.recruitment` (requisitions, applicants, interviews) | — | — | **create requisition** (Q10), view department | all | approve (Q10) | — | — | view, approve above limits (Q10) | — |
| `hr.offers` | — | — | view department (no salary) | view/create/edit all | approve all | — | — | approve (Q10) | — |
| `hr.offboarding` | view own, request resignation (Q9) | view team | view department | view/create/edit all | approve all | view settlement (Q9) | **`it.offboarding`**: view/confirm | view | — |
| `hr.settings` (policies, templates, ladder) | — | — | — | view | edit | — | — | — | edit (technical) |

Sensitive fields (default deny, audited views and exports): payslip and run amounts, settlement amounts, offer and requisition salary data, disciplinary content, appraisal scores (visible to the employee only when approved), punch locations (coordinates visible to HR and the employee only; managers see «داخل النطاق / خارج النطاق» and the site name), applicant identity numbers. The system admin keeps no financial approval right (FIN §12) and cannot see payslips.

---

## 7. Screens (HR §9 — fourteen outputs) and menu placement

Phone-first (375 px) for everything an employee or field worker uses: attendance, requests, payslip, tasks (golden rule 9). Desktop tables for HR, collapsing to cards at 375 px as Sales does.

| HR §9 | Screen (route) | Slice | Who sees it (menu) |
|---|---|---|---|
| 1 واجهة رئيسية للموارد البشرية | `/hr` landing: queues (requests, corrections, exceptions, payroll, appraisals, requisitions, offboardings), today's attendance summary, alerts | H1 (queues of what exists), grows per slice | HR officer / manager → menu «الموارد البشرية» |
| 2 الهيكل التنظيمي | exists: `/admin/departments`, `/admin/units`, `/admin/branches` (+ sites with map pin and radius), `/admin/positions`; H1 adds an org-chart view `/hr/org-chart` (tree by department → unit → manager chain) | H1 | HR, admin; read-only tree for everyone with `org.departments:view` |
| 3 ملف الموظف الإلكتروني | exists: `/hr/employees/:id` (tabs: البيانات، العقود، المستندات، العهد، التقارير، السجل) + new tabs: الحضور (H2), الإجازات (H2), الرواتب (H3a, HR/Finance only), الأداء والتدريب (H3a), الإجراءات الإدارية (H3a), إنهاء الخدمة (H3b) | H1–H3 | HR; the employee sees their own through `/me/*` |
| 4 التوظيف وإجراءات مباشرة الموظف | `/hr/recruitment` (requisitions list + Kanban of applicants per requisition), `/hr/recruitment/requisitions/:id`, `/hr/recruitment/applicants/:id`, `/hr/recruitment/offers/:id`; `/manager/requisitions` (department manager raises and tracks) | H3b | HR; department managers see their own |
| 5 الحضور والانصراف | **`/me/attendance`** (phone: the two buttons «تسجيل الحضور» / «تسجيل الانصراف», live time/date, location check, punch status, today's hours, history, hours / lateness / absence / overtime cards, button «طلب تعديل بصمة أو معالجة تسجيل مفقود»); `/manager/attendance` (team today, late, missing, approve corrections); `/hr/attendance` (all, filters, manual punch with reason); `/hr/shifts` (shifts, assignments, sites) | H2 | every employee (menu item «الحضور والانصراف»); managers; HR |
| 6 طلبات الموظفين والخدمات الذاتية | exists: `/me/requests`, `/manager/requests`, `/hr/requests` + the two new types and the draft button | H1 (drafts), H2 (types) | all |
| 7 العقود والوثائق | exists: employee tabs, `/hr/expiring`; H1 adds the Excel export of expiring documents | H1 | HR |
| 8 الرواتب والمزايا | `/hr/payroll` (runs), `/hr/payroll/:id` (payslip table, review, submit, approve), `/finance/payroll` (thin queue: review, return, approve, record payment), **`/me/payslips`** (phone-first, own payslips, HTML print) | H3a | HR officer / manager; Finance; every employee |
| 9 تقييم الأداء والتدريب | `/hr/performance` (cycles, templates, completion), `/manager/appraisals` (my team's appraisals, score form), `/me/performance` (my goals, progress, approved appraisals, improvement plan), `/hr/discipline`, `/hr/training` (plan, needs, courses, participants), `/manager/training-needs`, `/me/training` | H3a | per §6 |
| 10 إنهاء الخدمة | `/hr/offboarding`, `/hr/offboarding/:id` (the eight steps as a checklist with owners), `/it/offboarding` (thin IT queue), the employee's own view in `/me/profile` | H3b | HR; IT; the employee |
| 11 لوحة تحكم الموارد البشرية | exists `/hr/dashboard`; H1 fixes the request cards; H2 adds «الحضور والانصراف» cards; H3 adds «مؤشرات الأداء»; H4 completes every drill-down | H1–H4 | HR, executive, admin |
| 12 نظام التقارير والتصدير إلى Excel | exists `/hr/export`; H1 adds employee multi-select; H2 adds attendance / lateness / absence / hours / overtime / corrections / monthly per employee / totals per department or branch; H3 adds leave, payroll, appraisals, training; H4 verifies the §4 seven steps | H1–H4 | per permission |
| 13 نظام الصلاحيات والإشعارات | exists `/admin/roles`, notification center; new resources and notification types per slice | all | admin; everyone |
| 14 توثيق واجهات الربط البرمجية | exists `/api/v1/docs` (core/openapi since S5); H4 checks every HR route appears with its permission and adds `docs/HR_GOV_INTEGRATIONS.md` | H4 | admin, IT |

Menu placement: **employee** — الحضور والانصراف, قسيمة الراتب, أدائي وتدريبي under the personal group; **direct manager** — حضور فريقي, تقييم فريقي, احتياجات التدريب, طلب احتياج وظيفي (department managers) under «فريقي»; **HR officer / manager** — the «الموارد البشرية» group (الموظفون, الحضور, الجداول والورديات, الإجازات, الرواتب, الأداء, الإجراءات الإدارية, التدريب, التوظيف, إنهاء الخدمة, لوحة التحكم, التصدير); **Finance** — «مسيرات الرواتب» next to «الطلبات الواردة من المبيعات»; **IT** — «إنهاء خدمة — إغلاق الحسابات» next to its tickets; **executive** — read-only dashboard and reports; **admin** — settings group «الموارد البشرية» (policies, templates, ladder, lists), workflows.

### 7.5 Export resources (core/export, permission-filtered fields, sensitive flags audited)
`employees` (exists; + medical insurance, work schedule, site), `hr.documents_expiring` (H1), `hr.attendance_log`, `hr.lateness_log`, `hr.absence_log`, `hr.hours_overtime`, `hr.corrections`, `hr.attendance_monthly_employee`, `hr.attendance_totals` (department / branch) (H2), `hr.leave_balances`, `hr.leave_taken` (H2), `hr.payroll_register` (run lines, sensitive), `hr.appraisals`, `hr.goals`, `hr.trainings`, `hr.training_participants`, `hr.discipline` (H3), `hr.requisitions`, `hr.applicants`, `hr.offboardings` (H3b). Filters on every one: department, branch, employee(s), period; «تحديد الموظفين المستهدفين» as a multi-select (§4 step 2).

---

## 8. Settings (group «الموارد البشرية», admin screen; **all unset or provisional until the matching question is answered**)

| Key | Meaning | Question |
|---|---|---|
| `hr.attendance.defaultShift` | the standard schedule (hours, Ramadan variant) | Q1 |
| `hr.attendance.geofenceDefaultRadiusM` (fallback when a site has none) | | Q2 |
| `hr.attendance.locationPolicy` {`requireLocation`, `maxAccuracyM`, `onUnavailable`: refuse / allow_flagged} | «آلية التعامل مع تعذر تحديد الموقع» | Q3 |
| `hr.attendance.exceptionMaxDays`, `hr.requestRoutes.geofence_exception` | | Q3 |
| `hr.attendance.graceMinutes`, `absentAfterMinutes` / `absentWhenNoCheckIn`, `earlyLeaveGraceMinutes`, `missingCheckoutPolicy` (auto_close_at_shift_end_flagged / count_absent / wait_correction) | | Q4 |
| `hr.overtime` {`requiresPreApproval`, `approverRelation`, `rateBp` (proposal 15000 = 150 % per art. 107), `roundingMinutes`, `monthlyCapMinutes`} | | Q5 |
| `hr.attendance.correctionDeadlineDays`, `correctionsPerMonth`, `hr.requestRoutes.attendance_correction` | | Q6 |
| `hr.leave.policies` (per type) | | Q7 |
| `hr.payroll` {`allowanceTypes[]`, `deductionTypes[]`, `gosi` {saudi: {employeeBp, employerBp}, nonSaudi: {employeeBp, employerBp}}, `absenceDayFormula` (monthly_over_30 / monthly_over_working_days), `latenessDeduction` (none / per_minute / brackets), `deductionCapBp` (proposal 5000 per art. 92), `cutoffDay`, `payDay`, `hrReviewerRole`, `financeApproverRole`, `payslipVisibleAt`} | | Q8 |
| `hr.eos` {`awardFormula` (arts. 84–85 proposal), `resignationFractions`, `unusedLeaveEncashment`, `reasons[]`, `settlementApproverRole`} | | Q9 |
| `hr.recruitment` {`requisitionRaisers`, `requisitionApprover`, `postingChannels[]`, `interviewCriteria[]`, `offerApprover`, `cvRetentionMonths`} | | Q10 |
| `hr.appraisal` {`cycles` dates, `minServiceDays`, default template, `improvementPlanDays`}, `hr.discipline.ladder`, `hr.discipline.appealDays` | | Q11 |
| `hr.training` {`needsSubmitters`, `planApprover`, `providersFromParties`} | | Q12 |
| `hr.exitInterview.template` | | Q13 |
| `hr.retention` {`employeeFileYears`, `attendanceYears`, `payrollYears`} | | Q14 |

---

## 9. Slices (HR §8 order) — each ends with commits citing `[HR §x.y]`, tests for every validation, transition and role (allowed and forbidden), seed data for every state, `docs/HR_COVERAGE.md` rows, a demo script in `docs/HR.md`, a green CI run, then a stop for approval

| Slice | Branch | Content | Depends on |
|---|---|---|---|
| **H1 التأسيس** | `hr-h1` | this plan, `docs/prompts/hr.md`, CI `hr-*`, DECISIONS §7 / CLAUDE.md; **`HR_COVERAGE.md` for §3.1, §3.3, §3.5, §3.9, §4, §5, §6 from the code**; gaps: the five request cards, request drafts, employee multi-select in export, expiring-documents export, org-chart view, «نوع الدوام» decision, `/hr` landing with the existing queues; the **seed-on-empty-database CI test** and the no-swallow seed rule; branches and sites seeded when Q2 arrives | plan approval; Q2 optional |
| **H2 التشغيل اليومي** | `hr-h2` | §3.1 and §3.2 collections; shifts and assignments screens; punch endpoint (server time, geofence check, idempotency, append-only); `/me/attendance` phone-first; `attendanceDays` computation and the jobs (missed punch alerts, lateness / absence / hours / overtime per settings, business days only); the two request types; leave ledger with approved-leave effects; the eight §3.4 خامساً reports; dashboard attendance cards; notifications | Q1–Q7 (defaults in §11 if deferred) |
| **H3a الإدارة والمتابعة (1)** | `hr-h3a` | payroll runs + payslips + adjustments + advance schedules + the thin Finance stage + `/me/payslips`; performance (cycles, templates, goals ↔ KPI registry, appraisals, improvement plans, disciplinary actions); training (plan, needs, courses, participants, calendar + tasks, certificates); dashboard performance cards | H2; Q8, Q11, Q12 |
| **H3b الإدارة والمتابعة (2)** | `hr-h3b` | recruitment (requisition with draft, posting, applicants, interviews on the calendar, offers, hire without retyping, gov registration by hand, CV retention job); end of service (eight steps, settlement, custody, thin IT task, exit interview, certificate, status, retention) | H3a (settlement reads payroll data); Q9, Q10, Q13, Q14 |
| **H4 التقارير والتكامل** | `hr-h4` | every §5 card with drill-down; §4 export scope and the seven steps; every HR route in `/api/v1/docs` with its permission; integration tests (payroll + advances → Finance, offboarding → IT, goals ↔ KPIs, tasks / calendar / notifications); 375 px pass; `docs/HR_GOV_INTEGRATIONS.md`; the §9 acceptance walk in `HR_COVERAGE.md` | H3b; Q15 |

Tests per slice follow the Sales pattern: `hr-h2.test.ts` … with one `describe` per spec section, a role matrix test (allowed and forbidden), a notification hygiene test, a seed test on an empty database (CI), and the jobs tested with injected `now`.

---

## 10. Things I will do differently from the prompt, or that need your eye (for your decision)

1. **Corrections and exceptions as HR request types, not a separate `attendanceCorrections` collection.** The prompt lists `attendanceCorrections` as a collection and also says to reuse the HR request machinery and that "the existing request workflows gain two types". One record per real thing: the request *is* the correction; approval inserts the punch. HR_COVERAGE will cite the request type. Say if you want a separate collection anyway.
2. **`attendanceDays` is a recomputable cache, not a source of truth.** The punches, schedule, leave and holidays are the truth; the day row is recomputed by the job and on every relevant change until a payroll run locks it. This keeps the punches append-only (golden rule 3) while reports stay fast.
3. **Two collections added beyond the prompt's list:** `trainingParticipants` (the spec wants «حالة المشاركة والإكمال» per employee per course) and `payrollAdjustments` + `advanceSchedules` (needed for "a correction goes into the next run" and for advance instalments). `appraisalCycles`, `appraisalTemplates` and `exitInterviewTemplates` are configuration records (golden rule 10).
4. **H3 split into H3a and H3b from the start** (the prompt allows it): payroll + performance + training, then recruitment + end of service. Each is still one review.
5. **Remote-work approval creates a geofence exception for its days** so a remote employee can punch (§3.5.3 + §3.4). If you prefer remote days to need no punch at all, say so (Q3).
6. **Payslips become visible to the employee when the run is paid**, not when approved, so nobody sees a figure Finance may still return. Q8 can move it earlier.
7. **No self-assessment step** in the appraisal: the spec names the manager's results and notes only. Q11 can add it.
8. **The system admin cannot see payslips or settlements** (FIN §12 spirit, DECISIONS §4). HR manager and Finance can.
9. **Labor-law figures are proposals** (art. numbers in §11) and sit in settings; the code ships with them **unset** and the screens show «السياسة غير محددة — تُضاف من الإعدادات» until you confirm, exactly like the Sales discount limits.
10. **Punch coordinates are visible only to HR and the employee**; managers see inside / outside and the site. The spec's privacy note asks for this restraint; say if managers should see the map pin.

---

## 11. Questions for the owner (golden rule 11) — proposed default and what is blocked

| # | Question | Proposed default (used if you say "go with defaults") | Blocked until answered |
|---|---|---|---|
| 1 | **Work schedules:** standard daily hours and times, Ramadan hours, the shifts that exist today, which employees work shifts or in the field | Proposal per Labor Law **art. 98** (8 h/day, 48 h/week; Ramadan 6 h/day, 36 h/week for Muslim employees) and **art. 101** (a rest of ≥ 30 min after 5 consecutive hours): one default shift «الدوام الأساسي» 08:00–16:00 Sun–Thu, Ramadan 10:00–16:00; field staff on a `field` shift with the same hours and several sites; no rotating shifts until you list them. Also confirm plan §2: «نوع الدوام» = `employmentType`, and the shift assignment is «جدول الدوام» | H2 seed and the computation defaults; code works with any list |
| 2 | **Branches and operating sites** (DECISIONS §3): list, coordinates, geofence radius per site | Keep the sample branch and sites; default radius **150 m** per site when none is set (`hr.attendance.geofenceDefaultRadiusM`), accuracy must be ≤ the radius | real sites in the seed (H1 or H2); nothing in code |
| 3 | **Geofence exceptions and failures:** who approves, for how long, what happens when location is unavailable or inaccurate | Exception = request via **direct manager then HR**, max **5 days** per request; a punch with no location or accuracy > 2× radius is **refused** with the reason shown («تعذر تحديد الموقع — حاول مرة أخرى أو اطلب استثناءً»); HR may enter a manual punch with reason (audited). Remote-work approval creates the exception for its days (plan §10.5) | H2 defaults; code works with any choice |
| 4 | **Lateness and absence:** grace minutes; what counts as absent; early leave; missed check-out | grace **10 min**; late = check-in after start + grace; **absent = no check-in by shift end** on a scheduled day with no approved leave / permission / remote; early leave = check-out before end − 10 min; missed check-out = day flagged `missing_out`, worked hours **not counted** until a correction is approved (no auto-close) | H2 computation; settings exist either way |
| 5 | **Overtime:** pre-approval and approver, rate, rounding, cap | **Pre-approval required** (a request type «طلب عمل إضافي» *(proposed)* via direct manager, or the manager records it for the team); rate per **art. 107**: hourly wage + 50 % of the basic hourly wage, i.e. 150 % of basic/hour (`hr.overtime.rateBp = 15000`); rounding to 15 min; no cap until you give one; counted only from approved minutes actually worked beyond shift end. **Owner correction (DECISIONS §21):** compensation mode setting `hr.overtime.compensation` pay / leave / employee_choice, default pay; leave compensation = 1.5 h leave per overtime hour, taken within 60 days unless agreed otherwise, max 30 days/year, unused balance paid on leaving | H2 overtime column shows «بانتظار السياسة»; payroll line in H3a |
| 6 | **Attendance corrections:** approver, deadline, monthly limit | direct manager then HR; within **7 days** of the day; limit **3 per month** (beyond → flagged, HR decides); none after payroll lock | H2 validations; settings |
| 7 | **Leave types and balances:** entitlements, accrual, carry-over, half days, opening balances | Types (all **unset entitlement until confirmed**, proposals with articles): سنوية **21 days / 30 after 5 years** (art. 109), مرضية tiers **30 full / 60 at ¾ / 30 unpaid per year** (art. 117), زواج 5, مولود 3, وفاة 5 (art. 113), وضع **12 weeks** (art. 151 as amended 2025 — confirm), عدة 4 months 10 days (art. 160), حج 10–15 days once after 2 years (art. 114), اختبارات exam days (art. 115), بدون راتب by agreement (art. 116), اضطرارية — the cooperative's own (no article), عيدا الفطر والأضحى from the holidays calendar (art. 112). Accrual monthly 1/12; carry-over unlimited until you cap it; **whole days only**; opening balances entered by HR per employee (CSV import endpoint, ERPNext extraction not built); request over balance → **refused** for annual, **flagged** for sick/other. **Owner corrections (2025 amendments, DECISIONS §21):** وفاة أخ أو أخت 3 days; the father's 3-day مولود leave within 7 days of the birth; وضع 12 weeks confirmed with at least 6 weeks right after the birth. The cooperative's own types (اضطرارية) are provisional | H2 balance checks; the request form shows «الرصيد غير محدد» until then |
| 8 | **Payroll:** allowance / deduction lists; GOSI shares; absence, lateness and advance deductions; cut-off and pay dates; HR reviewer and Finance approver; what Finance records without WPS | allowances {سكن، نقل، أخرى}, deductions {غياب، تأخير، سلفة، التأمينات الاجتماعية، جزاء، أخرى}; GOSI as an **effective-dated table by group** (owner correction, DECISIONS §21): Saudi joined GOSI before 3 Jul 2024 → employee 9.75 % / employer 11.75 %; Saudi joined on or after 3 Jul 2024 → annuity share +0.5 points every July until 11 % in Jul 2028 (since Jul 2026: 10.75 % / 12.75 %); non-Saudi → employer 2 %; the employee file gains `gosiJoinDate` (H1); allowance list and cut-off / pay dates are provisional; absence day = **monthly wage / 30**; lateness: **none** until you choose; advance instalments equal monthly, count per the request; total deductions ≤ **50 %** of the wage (art. 92); cut-off **25th**, pay **27th**; HR manager reviews/approves, `finance_manager` approves, Finance records payment date, bank reference and proof; payslips visible at `paid` | H3a computation; the run can be prepared with unset policies only as «تجريبي» |
| 9 | **Final settlement:** award, unused leave, deductions, approver, reasons list | award per **art. 84**: ½ month wage per year for the first five years, 1 month per year after, pro-rata on fractions; resignation per **art. 85**: ⅓ for 2–5 years, ⅔ for 5–10, full after 10; unused annual leave paid (art. 111); deductions: outstanding advances, custody not returned (by decision), other; HR manager approves, Finance records payment; reasons {استقالة، انتهاء العقد، إنهاء من الجمعية، تقاعد، وفاة، أخرى}; resignation may start from the employee via «رفع طلب» (goes to direct manager then HR) | H3b settlement computation |
| 10 | **Recruitment:** who raises, who approves, posting channels, interview stages and scoring, offer approver, CV retention | department managers raise; **HR manager approves** (executive above a headcount or salary you set); channels {داخلي، جدارات، لينكدإن، أخرى} typed by hand with a reference; one or two interview rounds with criteria {المؤهل، الخبرة، المهارات، الملاءمة} scored 1–5 (configurable); offers approved by **HR manager**, executive when above the position's salary range; CVs of rejected applicants kept **12 months** then purged by a job (PDPL) | H3b; defaults are settings |
| 11 | **Performance:** who sets goals and weights, rating scale, form fields, cycle dates, improvement plan length, warnings ladder, issuer and approver | direct manager sets goals with the employee (weights sum 100 %), HR may edit; scale **1–5** {ضعيف، يحتاج تحسين، جيد، جيد جداً، ممتاز}; template v1: الأهداف 40 %, الكفاءات 40 %, المهام والالتزام 20 %; cycles: semi-annual **Jan–Jun** (opens 1 Jul, due 31 Jul) and annual **Jan–Dec** (opens 1 Jan, due 31 Jan); improvement plan **90 days**; ladder per **arts. 66–73**: {تنبيه كتابي، إنذار أول، إنذار ثانٍ، إنذار نهائي، خصم ≤ 5 أيام/شهر، إيقاف ≤ 5 أيام، فصل} — the direct manager or HR drafts, **HR manager approves**, employee notified in writing (art. 72), objection within 15 days; a penalty for a violation discovered more than 30 days ago is refused (art. 71 proposal) | H3a; the ladder list is empty until confirmed |
| 12 | **Training:** who submits needs, who approves the plan, providers, budget | department managers submit needs; **HR manager** approves the annual plan (executive if a budget threshold is set); providers are **parties** with a `training_provider` role or free text; budget read-only from Finance when the Finance module exists | H3a defaults |
| 13 | **Exit interview:** the questions | v1 template (editable): سبب ترك العمل، تقييم بيئة العمل، تقييم المدير المباشر، تقييم فرص التطوير، ما الذي يمكن تحسينه، هل توصي بالجمعية كمكان عمل، ملاحظات | H3b; the template is data |
| 14 | **Retention** of a terminated employee's file | keep the file, history, attendance and payroll **10 years** after the last working day, read-only, then review for deletion (no automatic purge); CVs 12 months (Q10); nothing is deleted by code without a decision | H3b `keepUntil` value only |
| 15 | **Government integrations** (§7.12): which accounts exist on Qiwa, GOSI, Mudad | the study assumes the cooperative has an establishment account on each and no API access yet; it lists what each platform offers (Qiwa contracts and Nitaqat, GOSI registration and wage updates, Mudad WPS) and what access each needs | H4 document only |

**New since the prompt**

| # | Question | Proposed default | Blocked |
|---|---|---|---|
| 16 | **Overtime request type**: is «طلب عمل إضافي» a ninth self-service request (employee asks, manager approves) or recorded by the manager only? | request type via the direct manager (HR not needed) + manager may record for the team — **answered 2026-11-24: yes, approved by the direct manager** | — |
| 17 | **Who may punch for whom**: HR manual punch with reason only, or also the direct manager for field staff without a phone? | HR only, audited — **answered 2026-11-24: only HR** | — |
| 18 | **Payroll scope**: all on-duty employees in one run, or one run per branch / employment type? | one run per period for everyone; a `contractor` employment type is excluded by default — **answered 2026-11-24: confirmed** | — |

---

## 12. Acceptance (what "HR complete" means)
- `docs/HR_COVERAGE.md` lists every bullet of HR §1–§9 with its implementation, test and status, and the fourteen §9 outputs each with a screen, an API and a test; the only ⏸ rows are those waiting on a named question or module.
- API tests cover each validation, each workflow transition and each role's allowed and forbidden actions; a CI test seeds an empty database; every seed block fails loudly.
- All Arabic labels verbatim in the `ar` locale; attendance, requests, payslips and tasks checked at 375 px.
- Every write audited; punches, ledgers, logs append-only; payroll runs and payslips frozen after approval.
- Every hand-off in §5 has its outbox event and notification, and a test that the receiving queue shows the record.
- CI green on each `hr-*` branch; nothing deployed; nothing merged by me.
