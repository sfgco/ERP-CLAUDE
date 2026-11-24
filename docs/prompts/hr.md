# Complete the HR module [HR], exactly as the spec — same method as Sales

Talk to me in Arabic. Code, identifiers and commit messages in English.

## 0. Context and ground rules
- **Source of truth:** the chapter `# HR — الموارد البشرية` in `docs/SPECS.md`. The owner sent the HR PDF again on 2026-11-24; its text is identical to `docs/specs/originals/hr.pdf`, so the chapter is current. Read the WHOLE chapter (§1–§9) before planning. Then read `CLAUDE.md`, `docs/DECISIONS.md` (especially §3, §5, §6, §7, §11–§13, §18, §19) and `docs/PHASE1.md`.
- **Owner decision (2026-11-24): HR is completed now, after Sales, in the four HR §8 phases.** This replaces "Phase 2: attendance" and the HR part of "Phase 6" in the CLAUDE.md build order. Record it in DECISIONS §7 and in CLAUDE.md.
- **Save this prompt** as `docs/prompts/hr.md` in the first commit.
- **Start point.** HR needs the shared pieces built with Sales: core/kpi, core/discussions, the export changes and the API document. Check `git log origin/main`. If `sales-s4` and `sales-s5` are not merged into main yet, stop and ask me whether to wait for the merge or to branch from `sales-s5`. Never rebase or force-push a pushed branch.
- **Branches:** one per slice (`hr-h1` … `hr-h4`). Add `'hr-*'` to the push branches in `.github/workflows/ci.yml`, so CI runs before any PR exists.
- **Coverage rule.** Every bullet in HR §1–§9 ends up as a screen, field, rule, notification, report or test.
  - Keep `docs/HR_COVERAGE.md` as a table: `HR §x.y | the bullet (Arabic, verbatim) | where it is implemented | test | status`.
  - Status values: ✅ built · 🔜 planned slice · ⏸ waits for an owner answer or another module (say which). Nothing is dropped silently.
  - Phase 1 already built part of HR (see §1 below). Fill the table for that part from the code, not from memory, and list every gap you find.
- **Labels are verbatim.** Every Arabic status, list value and button label the spec names is copied exactly into the `ar` locale (e.g. «تسجيل الحضور», «تسجيل الانصراف», the request states in §3.5). Don't paraphrase.
- **Golden rule 11 applies.** Where the spec gives no number, list or formula, ask (§2 below). Don't invent hours, tolerances, rates, balances, scales or formulas. Labor-law figures are not exempt: propose them with the article number and wait for my confirmation.
- **Privacy** (HR §3.4 ملاحظة تنظيمية):
  - Location is captured only at check-in and check-out, never tracked otherwise.
  - Salary, allowances, deductions, advances, IBAN and identity stay sensitive: default-deny field rules (DECISIONS §19).
  - Every view or export of these fields is audited.
- **Lessons from Sales (apply them):**
  - Add a CI test that runs the full seed on an empty database. On Sales, two seed bugs only showed up on a fresh database.
  - The seed never swallows errors. A failing sample block fails the seed.
  - `test/setup.ts` clears outbox subscribers before every test. A test that needs a subscriber registers it itself.
  - Push every slice and confirm CI is green before you report it as done.

## 1. What already exists (phase 1): don't rebuild it, verify it
Phase 1 built these (`docs/PHASE1.md`):
- Org structure (§3.1).
- The employee file, with documents and custody (§3.3).
- The eight self-service requests, with routing, SLAs and certificates (§3.5).
- Contracts, documents and expiry alerts (§3.9).
- Salary data entry with restricted access (§3.6 items 1 and 9).
- Promotions, transfers and status history, with the employee notified (§3.1 items 8–10, §3.7).
- Account disabling (§3.10 item 6).
- The field-picker export (§4).
- The HR dashboard, without its attendance and performance cards (§5).
- The role matrix (§6).

Check each of these against the spec in HR_COVERAGE.md and fix what's missing. For example:
- Is «نوع الدوام» in §3.3 the same field as «نوع التوظيف» in §3.1 item 6?
- Do the §5 request cards show new, pending, approved, rejected and needs-completion?

Not built yet:
- §3.2 recruitment, all of it.
- §3.4 attendance, all of it: shifts, GPS check-in/out, violations and alerts, corrections, reports. Leave balances are missing too (PHASE1 known limitations).
- §3.6 payroll runs (items 2–8).
- §3.7 everything except promotions and the employee notice:
  - goals, and their link to department KPIs
  - appraisals (semi-annual and annual), with results and the manager's notes
  - improvement plans
  - training records
  - warnings and administrative actions
- §3.8 training, all of it.
- §3.10 the end-of-service workflow: request, reason and date, approval, final settlement, custody return, closing accounts, exit interview.
- §5 the attendance and performance cards.
- §4 export scope for attendance, absence, leave, payroll, appraisals and training.
- §7 item 12, the study of government integrations.

## 2. Step 0: plan and questions (stop and wait for the owner)
Write `docs/HR_PLAN.md`, then stop and wait for my approval. It contains:
- **Data model.** List every new collection with its owner and indexes, and mark which ones are append-only. The new collections:
  - attendance: shifts, shiftAssignments, attendance (append-only punches), attendanceCorrections
  - leave: leaveBalances (a ledger)
  - payroll: payrollRuns, payslips
  - performance: goals, appraisals, improvementPlans, disciplinaryActions
  - training: trainingPlans, trainingNeeds, trainings
  - recruitment: jobRequisitions, applicants, interviews, offers
  - end of service: offboardings
- **Workflows.** For each new request type (attendance correction, geofence exception, requisition, offer, payroll run, appraisal, warning, end of service): states, who acts at each step, SLAs and notifications. Reuse the core workflow engine and the HR request machinery where they fit.
- **Hand-offs**, each with an outbox event:
  - Payroll to Finance: `hr.payroll.sent_to_finance`.
  - End of service to IT: `hr.offboarding.it_requested`.
  - Accepted offer to a new employee file: one record, no retyping.
  - Approved leave to attendance and to the leave balance.
- **Thin stages for Finance and IT.** Those modules don't exist yet, so build thin stages on the same HR record and number, as Sales did for Procurement, Finance and Operations:
  - Finance gets a queue to review, approve or return a payroll run, and to record its payment.
  - IT gets a task to close accounts and collect assets, which IT confirms.
  - The full modules take these stages over later (golden rule 6).
  - Segregation of duties: whoever prepares a payroll run can't approve it, and the approver can't record its payment (FIN §12).
- **Screens.** Map every screen to the 14 outputs in HR §9. Give menu placement for the employee, direct manager, HR officer, HR manager, Finance, IT, executive and admin. Attendance screens are designed for 375px first (golden rule 9; HR §3.4: web now, a phone app later).
- **Slices** H1–H4, as in §3 below.
- **The questions below.** For each one, give your proposed default and what is blocked until it's answered.
  1. **Work schedules:** standard daily hours and times, Ramadan hours, the shifts that exist today, and which employees work shifts or in the field.
  2. **Branches and operating sites** (DECISIONS §3, still pending): the list, coordinates, and geofence radius per site.
  3. **Geofence exceptions and failures:** who approves an exception (direct manager, HR?), for how long, and what happens when the location can't be read or its accuracy is poor. The spec's ملاحظة تنظيمية asks for exactly this policy.
  4. **Lateness and absence:** grace minutes; what counts as absent (no check-in at all? late beyond N minutes?); early leave; a missed check-out.
  5. **Overtime:** is pre-approval required, and who approves? The rate (Labor Law art. 107: hourly wage plus 50% of the basic wage — confirm), rounding, and any monthly cap.
  6. **Attendance corrections:** who approves (direct manager, then HR?), the deadline after the day, and a monthly limit.
  7. **Leave types and balances:** types and entitlements (annual 21/30 days per art. 109, sick leave tiers per art. 117, marriage, bereavement, maternity, Hajj, exam, unpaid), accrual, carry-over, and opening balances (imported from ERPNext?).
  8. **Payroll:**
     - The allowance and deduction lists.
     - GOSI employee and employer shares (the rates come from settings).
     - How absence, lateness and advance instalments are deducted.
     - Cut-off and pay dates.
     - Who reviews in HR (the HR manager?) and who approves in Finance.
     - The bank payment file (WPS/Mudad) is a later integration. What does Finance record now?
  9. **Final settlement:** the end-of-service award per arts. 84–85 (with the resignation fractions), unused leave pay, deductions; who approves; the reasons list for termination and resignation.
  10. **Recruitment:** who may raise a requisition (department managers?); who approves it; where jobs are posted (internal only, a public careers page, or Jadarat/LinkedIn entered by hand?); interview stages and scoring; who approves an offer; how long CVs of rejected applicants are kept (PDPL).
  11. **Performance:**
      - Who sets goals, and their weights.
      - The rating scale.
      - The appraisal form fields (configurable, golden rule 10).
      - Cycle dates for the semi-annual and annual appraisals.
      - How long an improvement plan runs.
      - The warnings ladder per the cooperative's work regulation (لائحة تنظيم العمل): who issues a warning and who approves it.
  12. **Training:** who submits department needs, who approves the annual plan, who the providers are (parties?), and the budget (read-only from Finance later).
  13. **Exit interview:** the questions.
  14. **Retention** of a terminated employee's file (§3.10 item 10: «وفق سياسات حفظ البيانات»).
  15. **Government integrations** (§7 item 12): which accounts the cooperative has on Qiwa, GOSI and Mudad. The deliverable now is a study, not an integration.

## 3. Slices: follow the HR §8 order
One slice at a time. Each slice delivers:
- commits citing `[HR §x.y]`
- tests for every validation, every workflow transition, and each role's allowed and forbidden actions
- sample data in the seed for every state
- an update to HR_COVERAGE.md
- a demo script in `docs/HR.md`
- a green CI run
Then wait for my approval before the next slice.

### H1: §8 المرحلة الأولى (التأسيس) — audit and gaps
Phase 1 built this stage. Fill HR_COVERAGE.md for §3.1, §3.3, §3.5, §3.9, §4, §5 and §6 from the code, and fix the gaps. Add the branches and sites once Q2 is answered. This is a small slice.

### H2: §8 المرحلة الثانية (التشغيل اليومي)
- **Work schedules** (§3.4 أولاً, items 1–7):
  - Shift periods with start and end times.
  - Work days and weekly rest (Fri–Sat by default).
  - Assign employees to shifts, and link employees to branches and sites.
  - Change a schedule to fit the nature of the work.
  - Shift work and field work.
- **GPS check-in/out** (§3.4 ثانياً, items 1–8):
  - The time comes from the server, never the device. The location and its accuracy are stored with each punch.
  - A geofence per HQ or site; several sites per branch; each employee linked to a site or branch.
  - A punch outside the geofence is refused, unless the employee has a permission or an approved exception (Q3).
  - Field staff punch at the sites assigned to them.
  - Punches are append-only. A double tap is idempotent.
- **Employee screen** (§3.4 ثالثاً, phone first):
  - The «تسجيل الحضور» and «تسجيل الانصراف» buttons.
  - The time and date, the location check, and the punch status.
  - The full punch history.
  - Actual hours, lateness and absence, and overtime.
  - «طلب تعديل بصمة أو معالجة تسجيل مفقود».
- **Violations and alerts** (§3.4 رابعاً):
  - Notify an employee who forgot to check in or out.
  - Record lateness and absence against the schedule.
  - Compute actual hours automatically.
  - Lateness and overtime follow the settings (Q4, Q5).
  - Correction requests go through approval (Q6).
  - These run as scheduled jobs, on business days only.
- **Leave balances** (Q7):
  - An append-only ledger.
  - An approved leave deducts from the balance and marks those days in attendance.
  - A request over the balance is refused or flagged, per Q7.
- **Reports** (§3.4 خامساً), daily and monthly, through the core export builder:
  - attendance log, lateness log, absence log
  - total hours and overtime
  - correction requests
  - a monthly report per employee
  - totals per department or branch
- **Requests and notifications** (§8 phase 2): the existing request workflows gain two types, the attendance correction and the geofence exception.

### H3: §8 المرحلة الثالثة (الإدارة والمتابعة)
Split it into H3a and H3b if it grows.
- **Payroll** (§3.6 items 1–9):
  - A monthly run built from the salary data.
  - Deductions per policy (Q8).
  - Attendance, lateness and absence from H2; approved overtime; advance instalments.
  - HR reviews the run before approval.
  - It goes to Finance under the same run number (the thin Finance stage, see §2).
  - Once approved, the run and its payslips are frozen. A correction goes into the next run, never as an edit.
  - History of past runs is kept, and access is restricted to authorized users.
  - The employee sees their own payslip in the portal.
- **Performance** (§3.7):
  - Goals per employee, linked to department KPIs (core/kpi from Sales S4).
  - Tasks assigned and their completion rate (core tasks).
  - Semi-annual and annual appraisals, with results and the direct manager's notes.
  - Improvement plans, with follow-up.
  - Warnings and administrative actions, per permissions (Q11).
  - Promotions and job changes already exist, with the employee notified.
- **Training** (§3.8 items 1–8):
  - The annual plan, and training needs per department.
  - A link to appraisal results.
  - Course name and provider, start and end dates.
  - Participation and completion status, and certificate upload.
  - Reports per employee and per department.
  - Courses also appear on the calendar and in "My Tasks" (EP §10).
- **Recruitment** (§3.2 items 1–10, plus the extra requirements):
  - The flow: requisition from the department (title, number and justification) → approval → posting and applications → screening and shortlist → interviews and results → offer → acceptance → contracting → Qiwa/GOSI registration recorded by hand.
  - A requisition can be saved as a draft.
  - Each candidate's status is tracked.
  - Every stage and approval is logged.
  - Past requisitions stay searchable.
  - An accepted offer creates the employee file, contract and user account from the applicant's data, without retyping (golden rule 2).
- **End of service** (§3.10 items 1–10). The flow:
  1. Request.
  2. Reason and date.
  3. Review and approval.
  4. Final settlement (Q9).
  5. Custody return: HR custody records now, IT assets later.
  6. Close permissions and accounts. Account disabling already exists; IT gets a thin task.
  7. Exit interview (Q13).
  8. Experience certificate on request. The template already exists.
  9. Status set to «منتهي الخدمة».
  10. The file is kept per the retention policy (Q14).
  Each step is logged, and the next owner is notified.
- **Contracts and documents** (§3.9): already built. Confirm the coverage.

### H4: §8 المرحلة الرابعة (التقارير والتكامل)
- **HR dashboard** (§5): all cards, including:
  - Attendance: absences, lateness, total hours, missed punches.
  - Performance: appraisal completion, employees with goals, trainings held, promotions and job changes.
  - Every card opens the filtered records (§5, last paragraph).
- **Reports and export** (§4):
  - The field-picker export covers employees, attendance, absence, leave, requests, payroll, appraisals, training, contracts and documents.
  - It follows the §4 steps: department or branch, employees, fields, filters, preview, Excel, permissions.
- **APIs** (§7 item 2, §9 item 14): every HR route appears in the generated API document (`/api/v1/docs`) with its permission.
- **Integration tests** with the other modules:
  - payroll and advances to Finance
  - end of service to IT
  - goals and department KPIs
  - tasks, calendar and notifications
- **Mobile readiness** (§7 items 2 and 10): attendance, requests, payslips and tasks work at 375px. The API needs nothing extra for a future phone app.
- **Government integrations study** (§7 item 12): write `docs/HR_GOV_INTEGRATIONS.md` on Qiwa, GOSI and Mudad: what each one offers, the access requirements, and the adapter seam. No integration code.
- **Acceptance walk:** HR_COVERAGE.md lists all 14 outputs of §9, each with its screen, API and test.

## 4. Report to me (in Arabic) after each step
- What was built, with screenshots at desktop width and 375px if you can take them.
- The CI result and the test counts.
- Branch and PR links. gh may not be installed; if not, give me the compare links.
- HR completion: ✅ rows against all rows in HR_COVERAGE.md. Separately, what runs on provisional settings until I answer.
- What is waiting for my decisions.

Rules: no deploys, no merges into main, no force-pushes, no deleting files.
