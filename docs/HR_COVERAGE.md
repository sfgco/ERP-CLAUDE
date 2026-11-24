# HR coverage — every bullet of `docs/SPECS.md` `# HR — الموارد البشرية` → where it lives → the test that proves it

Rule (prompt §0): nothing is dropped silently. A row that is not built yet names its slice or the decision it waits for. Spec text is verbatim. Slices (HR §8, `docs/HR_PLAN.md` §9): H1 التأسيس (audit of phase 1 + gaps), H2 التشغيل اليومي (schedules, GPS attendance, violations, leave ledger, attendance reports, two request types), H3a (payroll, performance, training), H3b (recruitment, end of service), H4 التقارير والتكامل (dashboard, export scope, API document, integration tests, government study). Phase-1 rows were filled **from the code on `hr-h1` (2026-11-24)**, not from memory. Tests are in `apps/api/src/**/*.test.ts` unless noted; "— (no test)" marks a built bullet without a dedicated test.

Status legend: ✅ built · 🔜 planned slice · ⏸ waits for an owner answer (HR_PLAN §11 / DECISIONS §21) or another module.

## §1–§2 المقدمة والهدف الرئيسي

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §1 | إدارة جميع العمليات المتعلقة بالموظفين من التخطيط والاستقطاب والتوظيف، مروراً بالحضور والانصراف والطلبات والإجازات وتقييم الأداء، وصولاً إلى إنهاء الخدمة | `apps/api/src/modules/hr/` (one module, owns every HR collection); phase 1 covers the file, requests, contracts; H2–H3b the rest | per section below | ✅ H1 (audit) · 🔜 H2–H4 |
| §1 | قابلاً للتوسع والتطوير والربط مع بقية أقسام النظام | modular monolith (CLAUDE.md), outbox events `hr.*` (`modules/hr/events.ts`), core/kpi, core/tasks, core/calendar reused | `core/outbox/outbox.test.ts` «B11b: events nobody handles stay "unhandled" and are replayed…» | ✅ |
| §2 | أتمتة إجراءات الموارد البشرية وتقليل المعاملات الورقية | self-service requests (§3.5), certificates generated from templates (`modules/hr/certificates.ts`) | `requests.test.ts` «salary and experience certificates are generated…» | ✅ (phase 1 scope) |
| §2 | قاعدة بيانات موحدة وشاملة لجميع الموظفين | `employees` collection, one record per employee, blind-index duplicate check | `hr.test.ts` «HR creates an employee…»; `core/golive-g.test.ts` «G12: the blind index…» | ✅ |
| §2 | تنظيم الهيكل الإداري والوظيفي | `core/org` (departments, units, branches, sites, positions) + org-chart view `/hr/org-chart` (`GET /hr/org-chart`, H1) | `core/org/org.test.ts`; `hr-h1.test.ts` «§9.2 org chart…» | ✅ |
| §2 | تسهيل متابعة الحضور والانصراف والرواتب والإجازات | attendance + leave ledger H2; payroll H3a | — | 🔜 H2 / H3a |
| §2 | توحيد إجراءات رفع الطلبات واعتمادها | one request form, one workflow `hr_request`, routes as setting `hr.requestRoutes` | `requests.test.ts` | ✅ |
| §2 | تحسين متابعة أداء الموظفين وقياس إنتاجيتهم | goals, appraisals, improvement plans | — | 🔜 H3a |
| §2 | توفير تقارير دقيقة تساعد الإدارة في اتخاذ القرارات | HR dashboard (§5) + field-picker export (§4); full scope H4 | `dashboard.test.ts`, `core/export/export.test.ts` | ✅ partial → 🔜 H4 |
| §2 | ربط بيانات الموظفين مع الأقسام الأخرى داخل نظام ERP | portal reads `/hr/me` (EP §20.1); Finance hand-off of advances; Sales reads employees for owners/assignees | `portal.test.ts`, `requests.test.ts` «advance: … hands off to Finance with the same number» | ✅ |

## §3.1 الهيكل التنظيمي وإدارة الموظفين

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.1 | ربط الموظفين بالإدارات والأقسام والفروع والمواقع التشغيلية | `employees.departmentId / unitId / branchId / siteId` (`modules/hr/model.ts`), set on create / update / transfer | `hr.test.ts` «HR creates an employee…», «transfer, promotion and manager change…» | ✅ |
| §3.1.1 | إنشاء الهيكل التنظيمي للمنشأة | `core/org` CRUD `GET/POST/PATCH/DELETE /org/departments|units|branches|sites|positions` (`core/org/routes.ts`), admin pages `/admin/departments`, `/admin/units`, `/admin/branches`, `/admin/positions`; org-chart tree `/hr/org-chart` (`GET /hr/org-chart`, scope-limited, H1) | `core/org/org.test.ts` «creates, updates and soft-deletes a department…»; `hr-h1.test.ts` «§9.2 org chart: every employee within the viewer’s scope…» | ✅ |
| §3.1.2 | إضافة الإدارات والأقسام والوحدات التابعة لها | `departments` (ten of DECISIONS §3 seeded by the baseline), `units` with `departmentId`, `/admin/units` | `core/org/org.test.ts` (departments); units — (no test) | ✅ |
| §3.1.3 | تحديد المدير المباشر لكل موظف | `employees.directManagerId`; `POST /hr/employees/:id/manager` (`changeManager`); team scope derived from it (`TEAM_LEAD_GRANTS`, DECISIONS §4) | `hr.test.ts` «transfer, promotion and manager change append history…»; `core/rbac/rbac.test.ts` | ✅ |
| §3.1.4 | تحديد المسمى الوظيفي والوصف الوظيفي | `positions.titleAr / descriptionAr` (`/admin/positions`), `employees.positionId`; the description is shown read-only on the employee file (job tab) and the portal profile (`labels.jobDescription`, H1); job-description document type `job_description` on the file | `hr-h1.test.ts` «§9.2 org chart… the profile shows the job description» | ✅ |
| §3.1.5 | تحديد الفرع أو موقع العمل | `branchId`, `siteId`; sites carry GeoJSON point + `geofenceRadiusM` (`core/org/model.ts`) | `core/org/org.test.ts` «stores sites as GeoJSON points with a geofence radius» | ✅ (real sites ⏸ Q2 — sample site seeded) |
| §3.1.6 | تحديد نوع التوظيف (دوام كامل، دوام جزئي، وغيرها) | `employmentType` enum `EMPLOYMENT_TYPES` دوام كامل / دوام جزئي / متعاقد / متدرب / أخرى (`packages/shared/src/schemas/hr.ts`); UI label «نوع الدوام» (`hr.employmentType`) | `hr.test.ts` first test | ✅ (one field for §3.1.6 and §3.3 «نوع الدوام» — HR_PLAN §2, Q1 note) |
| §3.1.7 | تحديد حالة الموظف (على رأس العمل، إجازة، موقوف، منتهي الخدمة) | `EMPLOYEE_STATUSES` merged list of DECISIONS §6 (على رأس العمل، إجازة، عمل ميداني، انتداب، موقوف، مستقيل، منتهي الخدمة), `POST /hr/employees/:id/status` | `hr.test.ts` «end of service keeps access until the last working day…» | ✅ |
| §3.1.8 | إمكانية نقل الموظف بين الأقسام والفروع | `POST /hr/employees/:id/transfer` (`transferEmployee`): names the new manager, moves pending items, notifies both managers (DECISIONS §11.4) | `hr.test.ts` «transfer names the new manager; pending items move…»; `requests.test.ts` «a transfer moves requests waiting for the old manager…» | ✅ |
| §3.1.9 | تسجيل الترقيات والتغييرات الوظيفية | `POST /hr/employees/:id/promote` (`promoteEmployee`), `employeeEvents.type` promotion / transfer / manager_change / status_change | `hr.test.ts` «transfer, promotion and manager change append history and notify the employee» | ✅ |
| §3.1.10 | الاحتفاظ بسجل تاريخي للتعديلات على بيانات الموظف | append-only `employeeEvents` (`created / updated / transfer / promotion / manager_change / status_change / secondment_report`), `GET /hr/employees/:id/history`, tab «الوظيفة والسجل» | same test | ✅ |

## §3.2 التوظيف واستقطاب الكفاءات

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.2 م1 | تقديم طلب احتياج وظيفي من القسم المعني | `jobRequisitions` `REQ-YYYY-#####`, workflow `hr_requisition`, `/manager/requisitions` | — | 🔜 H3b (raisers ⏸ Q10 default: department managers) |
| §3.2 م2 | تحديد المسمى الوظيفي والعدد المطلوب ومبررات الاحتياج | requisition fields `positionId / titleAr`, `headcount`, `justification` | — | 🔜 H3b |
| §3.2 م3 | اعتماد الطلب من صاحب الصلاحية | transition `approve` by `hr.recruitment.requisitionApprover` (default HR manager) | — | 🔜 H3b (⏸ Q10) |
| §3.2 م4 | الإعلان عن الوظيفة واستقبال طلبات التوظيف | `post` with channels + external refs; `applicants` entered by HR | — | 🔜 H3b (channels ⏸ Q10) |
| §3.2 م5 | فرز السير الذاتية وتحديد المرشحين | applicant stages new → screened → shortlisted | — | 🔜 H3b |
| §3.2 م6 | جدولة المقابلات وتسجيل نتائجها | `interviews` + calendar event kind `interview`, scores per criteria | — | 🔜 H3b (criteria ⏸ Q10) |
| §3.2 م7 | إصدار العرض الوظيفي | `offers` `OFR-YYYY-#####`, workflow `hr_offer` | — | 🔜 H3b |
| §3.2 م8 | موافقة المرشح على العرض الوظيفي | `accept` with date and signed file | — | 🔜 H3b |
| §3.2 م9 | استكمال إجراءات التعاقد | `contract`: creates employee file + contract + user account from the offer in one transaction (golden rule 2) | — | 🔜 H3b |
| §3.2 م10 | تسجيل الموظف في الأنظمة ذات العلاقة، مثل قوى والتأمينات الاجتماعية وفق الإجراءات المعتمدة | `offers.govRegistration` {qiwaRef, gosiRef} recorded by hand; integration = study (§7.12) | — | 🔜 H3b (integration ⏸ Q15, H4 study) |
| §3.2 إضافية | إمكانية حفظ طلب التوظيف كمسودة واستكماله لاحقاً | requisition state `draft` (مسودة) | — | 🔜 H3b |
| §3.2 إضافية | متابعة حالة كل مرشح | `applicants.stage` + `applicantEvents` | — | 🔜 H3b |
| §3.2 إضافية | توثيق مراحل التوظيف والموافقات | workflow stage log on requisition and offer | — | 🔜 H3b |
| §3.2 إضافية | إمكانية الرجوع إلى سجل طلبات التوظيف السابقة | `/hr/recruitment` list with closed requisitions searchable | — | 🔜 H3b |

## §3.3 ملف الموظف الإلكتروني

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.3 | ملف إلكتروني شامل ومستقل لكل موظف، مرجع لجميع بياناته ومستنداته وإجراءاته | `employees` + `GET /hr/employees/:id` (`serializeEmployee` with field rules), page `/hr/employees/:id` (tabs البيانات / الوظيفة والسجل / العقود / الوثائق / العهد / التقارير); the portal profile `/me/profile` reads `GET /hr/me` (EP §20.1) | `hr.test.ts` first test; `portal.test.ts` «serves the own file with labels and contract…» | ✅ |
| §3.3 أساسية | الاسم الكامل | `firstNameAr`, `lastNameAr`, `fullNameAr`, `fullNameEn` | `hr.test.ts` | ✅ |
| §3.3 أساسية | الرقم الوظيفي | `employeeNumber` generated `EMP-YYYY-#####` or kept on import (DECISIONS §10) | «HR creates an employee with a generated number…» | ✅ |
| §3.3 أساسية | رقم الهوية أو الإقامة | `identity.type / numberEnc / hash / last4 / expiryDate` — AES-256-GCM + HMAC blind index, sensitive field rule | same; `golive-access.test.ts` «E1: sensitive fields are default-deny…»; `golive-g.test.ts` «G12…» | ✅ |
| §3.3 أساسية | الجنسية | `nationality` | `hr.test.ts` | ✅ |
| §3.3 أساسية | تاريخ الميلاد | `birthDate` (sensitive) | `golive-access.test.ts` E1 | ✅ |
| §3.3 أساسية | رقم التواصل | `mobile`, `extension`; employee edits via `PATCH /hr/me/contact` (DECISIONS §10) | `portal.test.ts` «…contact info saves directly, is logged and HR is notified» | ✅ |
| §3.3 أساسية | البريد الإلكتروني | `workEmail` (= login, DECISIONS §2) | `hr.test.ts` | ✅ |
| §3.3 أساسية | الإدارة والقسم | `departmentId`, `unitId` | `hr.test.ts` | ✅ |
| §3.3 أساسية | المسمى الوظيفي | `positionId` (+ `grade`) | `hr.test.ts` | ✅ |
| §3.3 أساسية | المدير المباشر | `directManagerId` | `hr.test.ts` | ✅ |
| §3.3 أساسية | الفرع وموقع العمل | `branchId`, `siteId` shown as «الفرع» / «موقع العمل» rows in the file and the profile (label fixed in H1); export column «موقع العمل» | `hr-h1.test.ts` «§4 step 2…» (export field label) | ✅ |
| §3.3 أساسية | تاريخ المباشرة | `hireDate` | `hr.test.ts` | ✅ |
| §3.3 أساسية | نوع العقد | `contracts.type` محدد المدة / غير محدد المدة / موسمي / أخرى (`CONTRACT_TYPES`), shown with the current contract | `hr.test.ts` «contracts: renewal supersedes…» | ✅ |
| §3.3 أساسية | نوع الدوام | `employmentType` (same field as §3.1.6; export column «نوع الدوام») | `dashboard.test.ts` (export) | ✅ (HR_PLAN §2 decision; H2 adds «جدول الدوام») |
| §3.3 أساسية | الحالة الوظيفية | `status` (§3.1.7) | `hr.test.ts` | ✅ |
| §3.3 مستندات | عقد العمل | `contracts` with `attachmentId` claimed as a sensitive employee document (`routes.ts` «Contract files are sensitive employee documents») | `hr.test.ts` contracts test; `golive-access.test.ts` «E2: sensitive documents list as type + expiry only…» | ✅ |
| §3.3 مستندات | الهوية الوطنية أو الإقامة | document type `identity` (`EMPLOYEE_DOCUMENT_TYPES`), always sensitive | `golive-access.test.ts` E2 | ✅ |
| §3.3 مستندات | المؤهلات العلمية | document type `qualification` | — (no dedicated test; generic documents path covered by `hr.test.ts` «…documents of an employee are reachable only within scope») | ✅ |
| §3.3 مستندات | الشهادات المهنية | document type `professional_certificate` | same | ✅ |
| §3.3 مستندات | الوصف الوظيفي | document type `job_description` | same | ✅ |
| §3.3 مستندات | المستندات الرسمية الأخرى | document type `other` (sensitive by default, HR may untick — DECISIONS §19 follow-up 3) | `golive-followup.test.ts` | ✅ |
| §3.3 مستندات | سجل العهد المسلمة للموظف | `custody` collection, `GET/POST /hr/employees/:id/custody`, `POST …/custody/:cid/return` (condition سليمة / تالفة / مفقودة), tab «العهد» | `hr.test.ts` «custody items are issued and returned…» | ✅ |
| §3.3 نظام | إمكانية رفع الملفات وتنزيلها | S3 presigned upload (`core/files`), `POST /documents`, `GET /files/:id/url`; documents tab | `core/files/files.test.ts`, `core/files/access.test.ts` | ✅ |
| §3.3 نظام | إمكانية تحديث البيانات والمستندات | `PATCH /hr/employees/:id` (HR), `PATCH /hr/me/contact` (employee), new document version = new row (`documents.version / previousId`) | `hr.test.ts`; `portal.test.ts`; `golive-g.test.ts` «G5: … only the latest document version» | ✅ |
| §3.3 نظام | تحديد صلاحيات الاطلاع والتعديل | resource `hr.employees` × scope (own / team / department / all) + field rules `SENSITIVE_FIELDS_BY_RESOURCE` default-deny (DECISIONS §11.2, §19) | `golive-access.test.ts` E1, E2; `core/rbac/rbac.test.ts` «applies field-level rules…» | ✅ |
| §3.3 نظام | الاحتفاظ بسجل التعديلات | `employeeEvents` + audit log with before/after (`core/audit`) | `hr.test.ts`; `core/org/org.test.ts` (audit shape) | ✅ |
| §3.3 نظام | إرسال تنبيهات عند قرب انتهاء الوثائق أو العقود | jobs `hr.contracts.alerts`, `hr.identity.alerts`, core `runDocumentExpiryAlerts` (offsets `documents.expiryAlertOffsetsDays` 90/30/7) → notifications `contract.expiring`, `document.expiring` | `hr.test.ts` «contracts: … expiry and probation alerts fire once per offset»; `golive-g.test.ts` G5 | ✅ |

## §3.4 إدارة الحضور والانصراف

Built in **H2** (2026-11-24, branch `hr-h2`): `apps/api/src/modules/hr/attendance.{model,service,routes,exports}.ts`, `leave.service.ts`, tests `hr-h2.test.ts`; screens `pages/me/AttendancePage.tsx`, `pages/manager/TeamAttendancePage.tsx`, `pages/hr/{AttendancePage,ShiftsPage,LeaveBalancesPage,EmployeeAttendanceTabs}.tsx`. Values marked provisional carry «مؤقت حتى اعتماد الموارد البشرية» on the screens until an admin confirms the setting (DECISIONS §21).

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.4 | استخدامه من خلال موقع ERP حالياً، مع إمكانية تحويله مستقبلاً إلى تطبيق للهواتف الذكية | `/me/attendance` phone-first (`pages/me/AttendancePage.tsx`); the same JSON API a native client would call: `POST /hr/attendance/me/punch` {type, location, locationError, idempotencyKey, source web/mobile} with the server stamping the time | `hr-h2.test.ts` «records server time inside the fence…»; «API document» assertion | ✅ |
| §3.4 أولاً 1 | تعريف فترات الدوام المختلفة | `shifts` (`attendance.model.ts`), `GET/POST/PATCH /hr/shifts`, screen `/hr/shifts`; every change writes a `shiftVersions` row | `hr-h2.test.ts` «shifts are created, versioned on change and assigned with sites…» | ✅ (hours ⏸ Q1 provisional — flag on the setting) |
| §3.4 أولاً 2 | تحديد وقت بداية ونهاية كل فترة | `shifts.periods[] {start, end, crossesMidnight}` + `ramadanPeriods[]` (applied in the Hijri month 9) | same | ✅ |
| §3.4 أولاً 3 | تحديد أيام العمل والإجازات الأسبوعية | `shifts.workDays[]` (default Sun–Thu; the rest is the weekly rest) + the `holidays` collection → statuses «إجازة أسبوعية» / «عطلة رسمية» | `hr-h2.test.ts` «derives every status…» (Friday → weekend, holiday) | ✅ |
| §3.4 أولاً 4 | إسناد الموظفين إلى فترات العمل | `shiftAssignments` (`POST /hr/shifts/assignments`; no assignment = the default shift `hr.attendance.defaultShiftCode`) | same | ✅ |
| §3.4 أولاً 5 | ربط الموظفين بفروعهم ومواقع تشغيلهم | `shiftAssignments.siteIds[] / branchId`; empty = the site on the file | same | ✅ |
| §3.4 أولاً 6 | إمكانية تعديل جدول الدوام حسب طبيعة العمل | a new assignment row closes the previous one (`toDay`), the history is the collection; shift edits are versioned; days from the new start are recomputed | same («the assignment history closes the previous row») | ✅ |
| §3.4 أولاً 7 | دعم الموظفين العاملين بنظام الورديات والعمل الميداني | `shifts.kind` fixed / rotating / field / flexible; periods may cross midnight (a post-midnight punch belongs to the shift's day); several sites per field employee (seed: field staff on two sites) | same; `seed.test.ts` | ✅ |
| §3.4 ثانياً 1 | تسجيل الوقت والتاريخ تلقائياً عند تنفيذ العملية | `attendancePunches.at` = server time, `day` = the Riyadh day of the shift | `hr-h2.test.ts` «records server time inside the fence…» | ✅ |
| §3.4 ثانياً 2 | التحقق من الموقع الجغرافي للموظف عند التسجيل | browser fix `{lat, lng, accuracyM}` → `evaluateLocation` (haversine to the nearest allowed site, accuracy ≤ factor × radius) → `distanceM`, `withinGeofence`; pre-check `POST /hr/attendance/me/check` | same («inaccurate fix counts as unavailable») | ✅ |
| §3.4 ثانياً 3 | تحديد نطاق جغرافي مسموح للتسجيل حول مقر العمل أو موقع التشغيل (Geofencing) | `sites.geofenceRadiusM` or `hr.attendance.geofenceDefaultRadiusM` (150, provisional) | `core/org/org.test.ts`; `hr-h2.test.ts` (inside 23 m accepted, 7 km refused) | ✅ (⏸ Q2 real sites) |
| §3.4 ثانياً 4 | ربط كل موظف بموقع العمل أو الفرع المحدد له | `employees.siteId / branchId` + `shiftAssignments.siteIds` decide the allowed sites of a punch | `hr.test.ts`; `hr-h2.test.ts` | ✅ |
| §3.4 ثانياً 5 | إمكانية تحديد مواقع مختلفة حسب الفروع ومواقع التشغيل | `sites` per branch (`/admin/branches`) | `core/org/org.test.ts` | ✅ |
| §3.4 ثانياً 6 | منع التسجيل خارج النطاق الجغرافي المعتمد، إلا وفق صلاحية أو استثناء معتمد | 400 `outside_geofence` with the distance (refusal audited `hr.attendance.refused`) unless an `attendanceExceptions` row covers the day (approved «طلب استثناء من النطاق الجغرافي», max `hr.attendance.exceptionMaxDays` = 5, or approved remote work); the punch then carries `exceptionId` | same («honours an approved exception»; «too long an exception is refused») | ✅ (Q3 defaults) |
| §3.4 ثانياً 7 | تسجيل الموقع المرتبط بكل عملية حضور وانصراف | stored on every punch (`location`, `siteId`, `distanceM`, `withinGeofence`, `ip`, `userAgent`); coordinates returned to the employee and HR only, HR views audited as sensitive; managers see inside / outside and the site (HR_PLAN §10.10) | `hr-h2.test.ts` «coordinates are visible to the employee and HR only…» | ✅ |
| §3.4 ثانياً 8 | دعم تسجيل الحضور للموظفين العاملين ميدانياً وفق المواقع المخصصة لهم | the nearest of the assigned sites is matched; «لا يوجد موقع بإحداثيات» is accepted flagged `no_site` | same (assignment with a site) | ✅ |
| §3.4 ثالثاً | زر تسجيل الحضور | «تسجيل الحضور» on `/me/attendance` (reads the location on press only) | `hr-h2.test.ts` (`/me/punch` in) | ✅ |
| §3.4 ثالثاً | زر تسجيل الانصراف | «تسجيل الانصراف»; in / out must alternate (`already_punched`, `no_check_in`) | same | ✅ |
| §3.4 ثالثاً | عرض الوقت والتاريخ تلقائياً | live Riyadh clock and the full date (Gregorian / Hijri per the toggle) | — (UI) | ✅ |
| §3.4 ثالثاً | التحقق من الموقع الجغرافي | browser geolocation → `/me/check` → «داخل النطاق: تبعد n م عن …» / «خارج النطاق…» / «تعذر تحديد الموقع» | `hr-h2.test.ts` (verdicts) | ✅ |
| §3.4 ثالثاً | عرض حالة التسجيل | «حالة اليوم» badge (حاضر / متأخر / لم يُسجَّل الحضور / …) + today's punches | `GET /hr/attendance/me` in `hr-h2.test.ts` | ✅ |
| §3.4 ثالثاً | عرض جميع سجلات الحضور والانصراف السابقة | «سجل الحضور والانصراف» (this month / last 30 days) from `GET /hr/attendance/me/days` + `/me/punches` | same | ✅ |
| §3.4 ثالثاً | عرض ساعات العمل الفعلية | `attendanceDays.workedMinutes` (paired in → out), month total card | `hr-h2.test.ts` «derives every status…» (490 min) | ✅ |
| §3.4 ثالثاً | عرض التأخير والغياب | `lateMinutes` beyond the grace, statuses «متأخر» / «غائب», month cards | same (late 25 min, 08:08 within grace, absent) | ✅ (Q4 defaults) |
| §3.4 ثالثاً | عرض ساعات العمل الإضافية | `overtimeMinutes` (beyond the end, rounded to 15 min) and `overtimeApprovedMinutes` (only what an approved «طلب عمل إضافي» covers) | same (120 / 0 then 120 / 120) | ✅ (Q5 defaults; payroll line H3a) |
| §3.4 ثالثاً | إمكانية رفع طلب تعديل بصمة أو معالجة تسجيل مفقود | request type `attendance_correction` {day, kind missing_in / missing_out / wrong_time, requestedTime, punchId, reason} from the screen's button; same HRQ- series, manager → HR | `hr-h2.test.ts` «a correction request inserts the punch on approval…» | ✅ (Q6 defaults) |
| §3.4 رابعاً | إشعار الموظف عند نسيان تسجيل الحضور أو الانصراف | frequent job `hr.attendance.compute`: notification `attendance.missed_punch` once per day and punch, after `missedCheckInAlertMinutes` / `missedCheckOutAlertMinutes`, scheduled days only | `hr-h2.test.ts` «the frequent job computes the days and reminds the employee once…» | ✅ |
| §3.4 رابعاً | رصد التأخير وفق جدول الدوام المعتمد | `computeDay`: first check-in vs the shift start (+ grace); counted per the provisional setting `hr.attendance.rules.latenessCounting` (whole lateness from the start, or only beyond the grace — owner request 2026-11-24); an approved permission inside the window excuses the lateness | `hr-h2.test.ts` (permission 08:00–10:00 excuses a 09:50 arrival) | ✅ |
| §3.4 رابعاً | رصد الغياب وفق جدول العمل | a scheduled day with no check-in by the shift end and no leave / remote / holiday → «غائب» (Q4) | same | ✅ |
| §3.4 رابعاً | احتساب ساعات العمل الفعلية تلقائياً | in → out pairs; a missing check-out leaves the hours uncounted until a correction (`missingCheckoutPolicy` wait_correction) | same («missing_out, workedMinutes 0»; after the correction 490) | ✅ |
| §3.4 رابعاً | احتساب ساعات التأخير والعمل الإضافي وفق السياسات المعتمدة | settings `hr.attendance.rules` (grace 10, early-leave grace 10, absent rule, missed-checkout policy, alert offsets), `hr.overtime` (pre-approval, 150 %, rounding 15, cap, compensation pay / leave / employee_choice), per-shift grace | same; `settings.test.ts` | ✅ (values accepted 2026-11-24; Q1/Q2/Q7 marked provisional) |
| §3.4 رابعاً | تسجيل طلبات تعديل البصمة ومتابعة اعتمادها | the request travels the normal route (manager inbox → HR queue, stage log, notifications); approval inserts a `source: correction` punch (a `wrong_time` punch supersedes the old one, which stays) and recomputes the day; deadline 7 days, 3 per month then flagged | `hr-h2.test.ts` | ✅ |
| §3.4 خامساً | سجل الحضور والانصراف | export resource `hr.attendance_log` (punches with site, inside / outside, source) | `hr-h2.test.ts` «the eight reports are export resources…» | ✅ |
| §3.4 خامساً | سجل التأخير | `hr.lateness_log` (days with lateness: expected start, first in, minutes, permission minutes) | same | ✅ |
| §3.4 خامساً | سجل الغياب | `hr.absence_log` | same | ✅ |
| §3.4 خامساً | إجمالي ساعات العمل | `hr.hours_overtime` (worked hours per day) | same | ✅ |
| §3.4 خامساً | ساعات العمل الإضافية | `hr.hours_overtime` (recorded and approved overtime columns) | same | ✅ |
| §3.4 خامساً | طلبات تعديل البصمة | `hr.corrections` | `hr-h2.test.ts` (3 rows after the correction flow) | ✅ |
| §3.4 خامساً | تقرير الحضور الشهري لكل موظف | `hr.attendance_monthly_employee` (filters month or from / to, department, branch, employees) | same (row «عمر العنزي» 1 / 1 / 1 / 7.5 h) | ✅ |
| §3.4 خامساً | تقرير إجمالي الحضور لكل قسم أو فرع | `hr.attendance_totals` (`groupBy` department / branch, attendance rate) | same | ✅ |
| §3.4 ملاحظة | سياسة واضحة لاستخدام الموقع الجغرافي: نطاق التحقق، أوقات التسجيل، الاستثناءات، الصلاحيات، آلية التعامل مع تعذر تحديد الموقع، مع مراعاة خصوصية الموظفين وعدم تتبع مواقعهم خارج عملية التسجيل | settings `hr.attendance.locationPolicy` {requireLocation, maxAccuracyFactor, onUnavailable refuse / allow_flagged}, geofence radius, exception max days; the browser reads the location only when a button is pressed and the API stores it only on the punch; coordinates visible to HR and the employee; `GET /hr/attendance/policy` shows the policy and the provisional markers | `hr-h2.test.ts` (refuse vs allow_flagged) | ✅ (Q3 defaults) |

## §3.5 إدارة طلبات الموظفين والخدمات الذاتية

| § | Bullet | Implementation | Test (`modules/hr/requests.test.ts` unless noted) | Status |
|---|---|---|---|---|
| §3.5 | واجهة خدمة ذاتية تتيح للموظف تقديم الطلبات ومتابعة حالتها إلكترونياً | «رفع طلب» → `NewRequestDialog` / `_form.tsx`, `POST /hr/requests`, `/me/requests` (view=mine), `/me/requests/:id` | «validates per-type fields and routes leave via the direct manager…» | ✅ |
| §3.5.1 | طلب إجازة: نوع الإجازة، تاريخ بداية الإجازة، تاريخ نهاية الإجازة، السبب، المرفقات عند الحاجة | `leave` {leaveType (14 types: the Labor Law list + 2025 amendments, DECISIONS §21 Q7), startDate, endDate, reason, eventDate for مولود / وضع} + `attachmentIds`; H2 checks the **ledger balance** (annual over balance → refused; others flagged; no ledger yet → flagged «الرصيد غير محمّل»), the longest request, the 7-day birth rule, the 6-weeks-after-birth maternity rule, and flags a missing attachment; approval writes the `taken` ledger row and marks the days «في إجازة» | `requests.test.ts`; `hr-h2.test.ts` «opening balances, over-balance refusal…», «approved leave marks the days on_leave and writes the ledger» | ✅ (entitlements of اضطرارية / أخرى ⏸ provisional) |
| §3.5.2 | طلب استئذان: التاريخ، وقت بداية الاستئذان، وقت نهاية الاستئذان، السبب، المرفقات | `permission` {date, startTime, endTime, reason} | same | ✅ |
| §3.5.3 | طلب عمل عن بُعد: التاريخ، المدة، السبب، المرفقات | `remote_work` {startDate, days, reason}; approval writes an `attendanceExceptions` row (scope remote) so the days compute as «عمل عن بُعد» and punches are accepted from anywhere (HR_PLAN §10.5) | `requests.test.ts`; `hr-h2.test.ts` («approved remote work marks them remote») | ✅ |
| §3.5.4 | طلب تعريف بالراتب: جهة التوجيه، الغرض من الخطاب، نوع التعريف (تفصيلي أو غير تفصيلي)، تحديد الحاجة إلى التصديق من الغرفة التجارية | `salary_certificate` {addressedTo, purpose, detailed, chamberAttestation}; certificate `CRT-YYYY-#####` from template on HR approval | «salary and experience certificates are generated from the employee file on approval…» | ✅ (PDF renderer ⏸ DECISIONS §1.11 — HTML now) |
| §3.5.5 | طلب شهادة خبرة: تاريخ الطلب، الغرض من الشهادة، إنشاء الشهادة من قالب موحد مع تعبئة البيانات الوظيفية والتواريخ تلقائياً | `experience_certificate` {purpose}; `createdAt` = request date; `certificates.ts` fills name, position, department, hire date, contract type | same | ✅ |
| §3.5.6 | طلب سلفة: المبلغ المطلوب، سبب الطلب، ملاحظات إضافية؛ يوجّه إلى الموارد البشرية مع تطبيق صلاحيات الاعتماد | `advance` {amountHalalas, reason, notes}; route `hr_then_finance`; flag `advance_limit_unset` until `hr.advanceLimitHalalas`; Finance decides the final step on the same number | «advance: flagged while the limit is unset, HR approval hands off to Finance with the same number, Finance decides»; «A7: only a finance manager or the executive decides the final step» | ✅ (limit ⏸ DECISIONS §1.9; disbursement ⏸ Finance module; instalments 🔜 H3a) |
| §3.5.7 | طلب تحديث بيانات: تحديد البيانات المطلوب تعديلها، إدخال البيانات الجديدة، إرفاق المستندات المؤيدة | `data_update` {changes[] {field, currentValue, newValue}, reason} | «validates per-type fields…» | ✅ |
| §3.5.8 | طلب خطاب رسمي: نوع الخطاب، الجهة الموجه إليها، الغرض من الخطاب، المرفقات | `official_letter` {letterType, addressedTo, purpose} | same | ✅ (letter template ⏸ DECISIONS §13 — written by HR outside the system) |
| §3.5 بيانات 1 | رقم الطلب (يُنشأ تلقائياً) | `hrRequests.number` `HRQ-YYYY-#####` (`core/numbering`) | «validates…»; `core/numbering/numbering.test.ts` | ✅ |
| §3.5 بيانات 2 | اسم مقدم الطلب | `employeeId` → name in list and detail | same | ✅ |
| §3.5 بيانات 3 | الرقم الوظيفي | shown from the employee file in the detail page | — (no test) | ✅ |
| §3.5 بيانات 4 | تاريخ تقديم الطلب | `createdAt` | same | ✅ |
| §3.5 بيانات 5 | نوع الطلب | `type` (`HR_REQUEST_TYPE_AR` verbatim: طلب إجازة … طلب خطاب رسمي) | same | ✅ |
| §3.5 بيانات 6 | تفاصيل الطلب | `details` (validated per type) | same | ✅ |
| §3.5 بيانات 7 | المرفقات | `attachmentIds` claimed on creation / resubmission (DECISIONS §14.A) | `core/golive-g.test.ts` «G9: an HR request is created atomically…» | ✅ |
| §3.5 بيانات 8 | المسؤول عن الموافقة | `pendingWith` (requester / direct_manager / hr / finance) + `directManagerUserId`; label «بانتظار …» | «manager approves → HR approves…» | ✅ |
| §3.5 بيانات 9 | حالة الطلب | `state` (nine codes, labels verbatim in `HR_REQUEST_STATE_AR` and `requests.states.*`) | same | ✅ |
| §3.5 بيانات 10 | الملاحظات | `notes` | — (no test) | ✅ |
| §3.5 بيانات 11 | سجل الإجراءات والتعديلات | `hrRequestActions` (append-only: action, from/to, actor, note, changes) + core stage log, `GET /hr/requests/:id` history | «manager approves → HR approves → requester notified; HR return → requester fixes and resubmits…»; `integrity.test.ts` «B9: two concurrent approvals → one 200 and one 409; one stage log» | ✅ |
| §3.5 م1 الموظف | تقديم الطلب إلكترونياً؛ إرفاق المستندات المطلوبة؛ إرسال الطلب للمدير المباشر | `createRequest` → `submit_to_manager` / `submit_to_hr` per `hr.requestRoutes` (DECISIONS §5) | «validates per-type fields and routes leave via the direct manager, certificates directly to HR» | ✅ |
| §3.5 م2 المدير | مراجعة الطلب؛ الموافقة أو الرفض؛ إضافة الملاحظات؛ تحويل الطلب إلى الموارد البشرية في حال الموافقة | transitions `manager_approve` → awaiting_hr, `manager_reject` (reason required), note on every action; inbox `/manager/requests` | «manager approves → HR approves…»; «A6: nobody decides their own request» | ✅ |
| §3.5 م3 الموارد البشرية | مراجعة البيانات والمستندات؛ التأكد من استيفاء الشروط؛ اعتماد الطلب أو إعادته لاستكمال البيانات؛ تحويله للاعتماد النهائي حسب نوع الطلب والصلاحيات | `hr_approve`, `hr_return` (reason) → needs_completion → resubmit, `hr_forward_final` (advance → Finance), queue `/hr/requests` | same tests; «advance: …» | ✅ |
| §3.5 م4 الإغلاق | تحديث حالة الطلب؛ إشعار الموظف بالنتيجة؛ حفظ جميع الإجراءات في سجل الطلب؛ أرشفة الطلب إلكترونياً | approved / rejected + notification `request.decided` to the requester; action log + stage log; **archive** = the `close` transition to «مغلق», run by the daily job `hr.requests.autoclose` after `hr.requestAutoCloseBusinessDays` (default 5) business days, through the workflow (stage log, action log `close` by `system`, audit); HR may still close by hand (H1, DECISIONS §21 note) | `requests.test.ts`; `hr-h1.test.ts` «§3.5 المرحلة الرابعة «أرشفة الطلب»: decided requests close automatically…» | ✅ |
| §3.5 حالات | جديد – قيد المراجعة – بانتظار موافقة المدير – بانتظار الموارد البشرية – بانتظار الاعتماد النهائي – يحتاج استكمال – معتمد – مرفوض – مغلق | workflow `hr_request` v3 (`core/workflow/defaults.ts`; v3 adds `manager_final_approve` for routes whose final approver is the direct manager — overtime, Q16), labels verbatim | `core/workflow/workflow.test.ts`; `requests.test.ts`; `hr-h2.test.ts` (overtime approved by the manager alone, absent from the HR queue) | ✅ |
| §3.5 (SLA) | — stage SLA | `hr.requestStageSlaBusinessDays` (2), job `hr.requests.overdue` | «overdue stages notify the pending party once per stage» | ✅ |
| §7.5 ↔ §3.5 | حفظ الطلبات كمسودات واستكمالها لاحقاً | «حفظ كمسودة» in `NewRequestDialog` on the core drafts store (`PUT/GET/DELETE /drafts`, formKey `hr_request`); the draft is offered on the next «رفع طلب» and removed on submission (H1) | `hr-h1.test.ts` «§7.5 drafts: a request form can be saved as a draft…» | ✅ |
| H2 types | طلب تعديل بصمة أو معالجة تسجيل مفقود / طلب استثناء من النطاق الجغرافي / طلب عمل إضافي (Q16) | `HR_REQUEST_TYPES` + detail schemas (`hrRequests.ts`), routes in `hr.requestRoutes` (manager → HR; overtime: manager final), validations in `attendance.service.validateAttendanceRequest`, effects on approval in `applyApprovedRequest`; form fields in `_form.tsx`, labels verbatim | `hr-h2.test.ts` (all three flows) | ✅ |

## §3.6 إدارة الرواتب والمزايا

Built in **H3a** (2026-11-24, branch `hr-h3a`) together with §3.7 and §3.8: `modules/hr/payroll.{model,service,routes}.ts`, `performance.{model,service,routes}.ts`, `training.{model,service,routes}.ts`, `workflows.ts`, `h3a.exports.ts`, `core/kpi/registry.ts`; tests `hr-h3a.test.ts`. Provisional (Q8 / Q11): payroll policy, appraisal dates and template, the warnings ladder.

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.6 | ربطها ببيانات الحضور والانصراف والإجازات | `computePayslip` reads the window's `attendanceDays` (absence, lateness, approved overtime, leave days with the leave policy's paid share) and locks them at submission | `hr-h3a.test.ts` «prepares a run from the salary master and the locked attendance window…» | ✅ |
| §3.6.1 | تسجيل الراتب الأساسي والبدلات والاستحقاقات | `employees.basicSalaryHalalas`, `allowances[] {type, amountHalalas}`, `bank` (IBAN encrypted); HR edits, Finance reads (DECISIONS §7); portal «التفاصيل المالية» read-only | `hr.test.ts` first test (own sensitive data visible, colleagues not); `golive-access.test.ts` E1 (Finance sees pay and bank only) | ✅ (allowance list ⏸ Q8 provisional) |
| §3.6.2 | إعداد مسير الرواتب الشهري | `payrollRuns` `PAY-YYYY-#####` (one per period, Q18: everyone, contractors excluded), workflow `hr_payroll_run`, `POST /hr/payroll` prepares, `/recompute` while draft / returned, screen `/hr/payroll`; daily cut-off reminder `hr.payroll.cutoff` | same | ✅ (cut-off / pay day ⏸ provisional Q8) |
| §3.6.3 | احتساب الاستقطاعات وفق السياسات والأنظمة المعتمدة | `hr.payroll.policy` (absence day = wage ÷ 30, lateness none, cap 50 % per art. 92 with the excess rolled into the next run, unpaid leave share) and `hr.payroll.gosiRates` (effective-dated by group: Saudi before / from 3 Jul 2024 by `gosiJoinDate`, non-Saudi 2 % employer); advance instalments from `advanceSchedules`; fines from upheld disciplinary actions; adjustments consumed once | `hr-h3a.test.ts` (a: 9.75 %, b: 10.75 %, c: non-Saudi, capped) | ✅ (Q8 values provisional) |
| §3.6.4 | ربط بيانات الحضور والتأخير والغياب بالمسير | absence line = `status === 'absent'` days only (**a missing check-out is never an absence**, DECISIONS §21), lateness minutes as stored by the provisional rule, `submit_for_review` locks the days (`lockedByPayrollRunId`), `cancel` unlocks | same (2 absences, 1 missing check-out, locked days, correction refused) | ✅ |
| §3.6.5 | تسجيل العمل الإضافي وفق الاعتمادات | `overtimeApprovedMinutes` of the window × basic ÷ 30 ÷ daily hours × 150 % (art. 107), only when the request's compensation is pay | same (2 h → 6 250 halalas on 500 000) | ✅ |
| §3.6.6 | مراجعة مسير الرواتب قبل اعتماده | `submit_for_review` → «قيد مراجعة الموارد البشرية»; the HR manager returns or approves; **the preparer can never approve** (403, FIN §12); approval freezes the run and its payslips | same | ✅ |
| §3.6.7 | رفع مسير الرواتب إلى الإدارة المالية | HR approval sends the run to Finance at once on the same record (`send_to_finance` by the system, event `hr.payroll.sent_to_finance`, notification to Finance); thin queue `/finance/payroll`: staff return, the manager approves, someone else records the payment (date, reference, proof) → `hr.payroll.paid` | same | ✅ (the Finance module takes the stage over later) |
| §3.6.8 | حفظ سجل مسيرات الرواتب السابقة | runs frozen at approval (`frozenAt`), payslip snapshots, stage log; register `/hr/payroll`, export `hr.payroll_register` | same | ✅ |
| §3.6.9 | توفير صلاحيات محددة للاطلاع على بيانات الرواتب | field rules on the file (phase 1) + resources `hr.payroll` (HR; executive read), `hr.payslips` (employee own once visible, HR / Finance all, admin none), `finance.payroll` (Finance roles); HR / Finance views of payslips and runs audited as sensitive; the register's amounts are sensitive export columns | `hr-h3a.test.ts` (b 404 on a's payslip, admin 403 on runs, fm reads audited) | ✅ |

## §3.7 متابعة وتقييم أداء الموظفين

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.7 | تحديد الأهداف الوظيفية لكل موظف | `goals` (direct manager / HR create; weight, target, due date), `/hr/performance/goals`, screens `/manager/appraisals`, `/hr/performance`, `/me/performance`; the employee is notified (`goal.assigned`) | `hr-h3a.test.ts` «goals validate the KPI code…» | ✅ |
| §3.7 | ربط الأهداف بمؤشرات أداء القسم | `goals.kpiCode` must exist in the KPI registry (`core/kpi/registry.ts`: Sales' five + HR's four), `GET /hr/performance/kpis` | same (unknown code → 400) | ✅ |
| §3.7 | تسجيل المهام المسندة للموظف | core tasks (EP §10); the appraisal snapshots `tasksCompletion` {assigned, done, late} of the cycle window and the `tasks` criterion is scored from it | `core/tasks/*.test.ts`; `hr-h3a.test.ts` | ✅ |
| §3.7 | متابعة نسبة الإنجاز | `goals.progress[]` (append-only, the employee / manager / HR update it), `goals.percent`, `appraisals.tasksCompletion` | same | ✅ |
| §3.7 | تقييم الأداء نصف سنوي وسنوي | `appraisalCycles` (semi_annual_1 / semi_annual_2 / annual, template snapshot at opening), one `appraisal` per eligible employee pinned to the direct manager, workflow `hr_appraisal` (manager → HR → employee acknowledgement), daily job opens due cycles and reminds managers | same (open → 5 appraisals, job opens the planned cycle) | ✅ (Q11 dates provisional) |
| §3.7 | تسجيل نتائج التقييم وملاحظات المدير المباشر | `POST /appraisals/:id/score` (manager only; goals / tasks criteria pre-filled), `overallScoreBp` + rating label from the template, `managerNotes`, HR `hrNotes`, employee `employeeComment` | same (70 % → «جيد جداً») | ✅ |
| §3.7 | متابعة خطط تحسين الأداء | `improvementPlans` offered when the score is under the template threshold, objectives, append-only reviews, 30-day review reminders, close with outcome | same (offer → create → review → complete) | ✅ |
| §3.7 | تسجيل الدورات التدريبية والشهادات | `trainingParticipants` with `certificateAttachmentId` (§3.8); employee tab «الأداء والتدريب» | `hr-h3a.test.ts` §3.8 test | ✅ |
| §3.7 | تسجيل الإنذارات والإجراءات الإدارية وفق الصلاحيات | `disciplinaryActions` `DIS-YYYY-#####` on the `hr.discipline` ladder (arts. 66–73, provisional), workflow `hr_disciplinary` (issuer ≠ approver, written delivery, appeal within 15 days, auto-uphold after the window), a fine becomes a payroll adjustment once upheld; resource `hr.discipline` (employee sees delivered only) | `hr-h3a.test.ts` «disciplinary actions follow the ladder…» | ✅ (ladder ⏸ Q11) |
| §3.7 | تسجيل الترقيات والتغييرات الوظيفية | `POST /hr/employees/:id/promote`, `/transfer`, `/manager`, `/status` → `employeeEvents` | `hr.test.ts` «transfer, promotion and manager change append history and notify the employee» | ✅ |
| §3.7 | إرسال إشعار للموظف عند اعتماد ترقيته أو تغيير وضعه الوظيفي | `employee.promotion` on promote and on every status change (employee + direct manager, with the old and new status and the reason, H1); `employee.manager_or_department_changed` on transfer / manager change | `hr.test.ts` (promotion, transfer); `hr-h1.test.ts` «§3.7 … a status change notifies the employee and the direct manager» | ✅ |

## §3.8 إدارة التدريب والتطوير

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.8 | سجل إلكتروني لتطوير الموظفين ومتابعة احتياجاتهم التدريبية | `/hr/training` (courses, needs, plan), `/hr/training/:id`, `/me/training`, employee tab | `hr-h3a.test.ts` «department managers raise needs, HR plans and runs courses…» | ✅ |
| §3.8.1 | إعداد خطة تدريب سنوية | `trainingPlans` per year (items by quarter with estimated cost and linked needs), draft → submitted → approved by `hr.training.planApproverRole` (Q12: HR manager; never the submitter) → closed | same | ✅ |
| §3.8.2 | تحديد الاحتياجات التدريبية لكل قسم | `trainingNeeds` raised by department managers (`hr.training.needsSubmitters`) or HR; HR accepts / plans / rejects; a plan item or course marks them planned / done | same | ✅ |
| §3.8.3 | ربط التدريب بنتائج تقييم الأداء | `trainingNeeds.source = appraisal` + `appraisalId` | seed (`seedH3a.ts` need 2) | ✅ |
| §3.8.4 | تسجيل اسم الدورة والجهة المقدمة | `trainings` `TRN-YYYY-#####` with `providerName` or `providerPartyId`, kind داخلي / خارجي / عن بُعد | same | ✅ |
| §3.8.5 | تحديد تاريخ بداية ونهاية الدورة | `trainings.startAt / endAt`; a calendar event of type `training` is created with the course and gains each nominated participant; the daily job reminds participants the day before | same (event exists, participants added) | ✅ |
| §3.8.6 | تسجيل حالة المشاركة والإكمال | `trainingParticipants.status` مرشَّح / مسجَّل / حضر / أكمل / لم يُكمل / انسحب with history; nomination creates a task in «مهامي» and a notification; completion closes the task | same | ✅ |
| §3.8.7 | رفع الشهادات التدريبية | the employee uploads their own certificate (`PATCH /participants/:id` with the attachment, owned by the employee file); HR records the result | same | ✅ |
| §3.8.8 | استخراج تقارير التدريب لكل موظف وقسم | export resources `hr.trainings` and `hr.training_participants` (department managers export their department) | same | ✅ |

## §3.9 إدارة العقود والوثائق والتنبيهات

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.9 | حفظ عقود العمل | `contracts` (`GET/POST /hr/employees/:id/contracts`, addenda, status), file claimed as sensitive document | `hr.test.ts` «contracts: renewal supersedes the previous one…» | ✅ |
| §3.9 | حفظ الهويات الوطنية والإقامات | `identity.*` on the file + document type `identity` | `golive-access.test.ts` E2 | ✅ |
| §3.9 | حفظ المؤهلات العلمية | document type `qualification` | — (no dedicated test) | ✅ |
| §3.9 | حفظ الشهادات المهنية | document type `professional_certificate` | — (no dedicated test) | ✅ |
| §3.9 | حفظ الأوصاف الوظيفية | document type `job_description` + `positions.descriptionAr` | — (no dedicated test) | ✅ |
| §3.9 | تسجيل تواريخ إصدار وانتهاء الوثائق | `documents.issueDate / expiryDate`; `identity.expiryDate`; `contracts.startDate / endDate` | `golive-g.test.ts` G5 | ✅ |
| §3.9 | متابعة حالة العقود | `CONTRACT_STATUSES` ساري / منتهي / قيد التجديد / منتهٍ بإنهاء الخدمة; job flips expired contracts the day after the end (Riyadh) | `golive-g.test.ts` «G3: a contract expires the day after its end date…» | ✅ |
| §3.9 | إرسال تنبيهات قبل انتهاء العقود والوثائق | jobs `hr.contracts.alerts` (90/30/7 to HR + employee), `hr.identity.alerts`, core document alerts; probation alerts 30/7 | `hr.test.ts` contracts test; `golive-g.test.ts` G5 | ✅ |
| §3.9 | توفير سجل تاريخي للوثائق والتجديدات | contract `version / previousId` chain (renewal marks the old one منتهي «renewed»); document versions (`?includeOld`) | `hr.test.ts` contracts test; `golive-g.test.ts` G3 | ✅ |
| §3.9 | إمكانية استخراج تقارير بالوثائق التي قاربت على الانتهاء | screen `/hr/expiring?kind=…&within=N` (`GET /hr/dashboard/expiring`) and the Excel resource `hr.documents_expiring` (kind / within / department / employees filters) — both read `modules/hr/expiring.ts` (H1) | `golive-h.test.ts` «H5…»; `hr-h1.test.ts` «§4 step 2 … expiring-documents export» | ✅ |

## §3.10 إنهاء الخدمة

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §3.10.1 | تسجيل طلب إنهاء الخدمة | `offboardings` `EOS-YYYY-#####`, workflow `hr_offboarding` | — | 🔜 H3b |
| §3.10.2 | تحديد سبب وتاريخ إنهاء الخدمة | `kind / reason / lastWorkingDay` (reasons list ⏸ Q9) | — | 🔜 H3b |
| §3.10.3 | مراجعة واعتماد الإجراء | HR manager `approve` → status مستقيل / منتهي الخدمة with last working day (existing `changeStatus`, DECISIONS §11.3) | `hr.test.ts` «end of service keeps access until the last working day…» (status part) | ✅ status · 🔜 H3b flow |
| §3.10.4 | إعداد المخالصة النهائية | `offboardings.settlement` per arts. 84–85, 111 (⏸ Q9) | — | 🔜 H3b |
| §3.10.5 | استرداد العهد المسلمة للموظف | custody return exists (`POST …/custody/:cid/return`); checklist on the offboarding | `hr.test.ts` «custody items are issued and returned…» | ✅ return · 🔜 H3b checklist |
| §3.10.6 | إغلاق الصلاحيات والحسابات المرتبطة بالموظف | job `hr.accounts.deactivate` (frequent) disables the account and ends sessions after the last working day; revert re-enables | `hr.test.ts` «end of service…»; `golive-g.test.ts` «G4: account deactivation re-checks the employee at write time…»; `core/auth/users.test.ts` «disabling an account ends its sessions immediately» | ✅ (IT thin task 🔜 H3b) |
| §3.10.7 | إجراء مقابلة الخروج وتوثيق نتائجها | `offboardings.exitInterview` (template ⏸ Q13) | — | 🔜 H3b |
| §3.10.8 | إصدار شهادة الخبرة عند الطلب | request type `experience_certificate` + template exist | `requests.test.ts` «salary and experience certificates are generated…» | ✅ (link from the offboarding 🔜 H3b) |
| §3.10.9 | تحديث حالة الموظف إلى منتهي الخدمة | `changeStatus` → `terminated` («منتهي الخدمة») | `hr.test.ts` | ✅ |
| §3.10.10 | الاحتفاظ بملف الموظف وسجله الوظيفي وفق سياسات حفظ البيانات | soft delete only (`deletedAt`), history kept; retention `keepUntil` ⏸ Q14 | — | ✅ kept · 🔜 H3b retention |

## §4 التقارير والتصدير (Reports & Export)

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §4 | تحديد الحقول التي يرغب بإظهارها في ملف Excel ثم عرض البيانات وفق الاختيارات | `GET /export/resources`, `POST /export` {resource, fields, filters, format preview/xlsx} (`core/export`), page `/hr/export` | `core/export/export.test.ts` «previews chosen fields only, produces xlsx, refuses unknown fields and audits» | ✅ |
| §4 مثال | الاسم، الجنسية، نوع الدوام، وجود تأمين طبي، حالة الموظف | fields `fullNameAr` «الاسم», `nationality` «الجنسية», `employmentType` «نوع الدوام», `medicalInsurance` «وجود تأمين طبي» (label fixed in H1), `status` «حالة الموظف» on resource `employees` (`modules/hr/index.ts`) | `dashboard.test.ts` «…export is permission-filtered and audited as sensitive» | ✅ (label «وجود تأمين طبي» — see audit) |
| §4.1 | اختيار القسم أو الفرع المطلوب | filters `departmentId`, `branchId` | same | ✅ |
| §4.2 | تحديد الموظفين المستهدفين | employee picker on `/hr/export` (search by name / number, chips) → `filters.employeeIds`, intersected with the viewer's scope on `employees`, `hr.documents_expiring` and `hr.requests` (H1) | `hr-h1.test.ts` «§4 step 2 «تحديد الموظفين المستهدفين»…» | ✅ |
| §4.3 | اختيار الحقول المطلوب تصديرها | field picker (allow-list per resource) | `core/export/export.test.ts` | ✅ |
| §4.4 | تطبيق الفلاتر على البيانات | `status`, `nationality`, `departmentId`, `branchId` | `dashboard.test.ts` | ✅ |
| §4.5 | عرض معاينة للبيانات قبل التصدير | `format: 'preview'` (50 rows), columns typed for dates / money | `golive-h.test.ts` «H7: the export preview names the kind of each column…» | ✅ |
| §4.6 | تصدير النتائج إلى Excel | `toXlsx` (RTL sheet) | `core/export/export.test.ts` | ✅ |
| §4.7 | الالتزام بصلاحيات المستخدم عند استخراج البيانات | `exports:create` + resource `export` action + field rules; sensitive export audited with the field list | `dashboard.test.ts`; `core/export/export.test.ts` | ✅ |
| §4 نطاق | بيانات الموظفين | resource `employees` | `dashboard.test.ts` | ✅ |
| §4 نطاق | الحضور والغياب | `hr.attendance_log`, `hr.absence_log`, … | — | 🔜 H2 |
| §4 نطاق | الإجازات | `hr.leave_balances`, `hr.leave_taken` | — | 🔜 H2 |
| §4 نطاق | الطلبات | export resource `hr.requests` (number, type, employee, department, dates, state, pending party, decision, reason, notes; filters type / state / department / period / employees; permission `hr.requests:export`) (H1) | `hr-h1.test.ts` «§4 step 2 … §4 «الطلبات» export» | ✅ |
| §4 نطاق | الرواتب | `hr.payroll_register` | — | 🔜 H3a |
| §4 نطاق | التقييمات | `hr.appraisals`, `hr.goals` | — | 🔜 H3a |
| §4 نطاق | التدريب | `hr.trainings`, `hr.training_participants` | — | 🔜 H3a |
| §4 نطاق | العقود والوثائق | contract type / end on `employees`; `hr.documents_expiring` (contracts, identities, documents) (H1) | `hr-h1.test.ts` «§4 step 2…» | ✅ |

## §5 لوحة التحكم الرئيسية للموارد البشرية

| § | Bullet | Implementation (`GET /hr/dashboard/hr`, page `/hr/dashboard`) | Test (`modules/hr/dashboard.test.ts` «HR dashboard aggregates headcount, expiries, request queues, probation and recent changes…») | Status |
|---|---|---|---|---|
| §5 أولاً | إجمالي عدد الموظفين | `headcount.total` → `/hr/employees` | ✓ | ✅ |
| §5 أولاً | عدد الموظفين على رأس العمل | `headcount.byStatus` (active) → `/hr/employees?status=active` | ✓ | ✅ |
| §5 أولاً | عدد الموظفين في إجازة | `attendance.onLeaveToday` = approved leave covering today (card «عدد الموظفين في إجازة اليوم»); `byStatus` (on_leave) kept for the status bar | `hr-h2.test.ts` (`onLeaveToday`) | ✅ |
| §5 أولاً | عدد الموظفين حسب الإدارات والأقسام | `byDepartment` with drill-down `/hr/employees?departmentId=` | ✓ | ✅ |
| §5 أولاً | عدد الموظفين حسب الفروع | `byBranch` — **no drill-down link** | ✓ | ✅ (see audit) |
| §5 أولاً | توزيع الموظفين حسب الجنسية ونوع التوظيف | `headcount.byNationality` → `/hr/employees?nationality=`, `headcount.byEmploymentType` → `/hr/employees?employmentType=` (card «بحسب نوع التوظيف», H1); contract type kept as its own card | `hr-h1.test.ts` «§5 رابعاً: the dashboard counts…» (byEmploymentType) | ✅ |
| §5 ثانياً | عدد حالات الغياب | `attendance.absent` over the dashboard period → `/hr/attendance?from&to&status=absent` | `hr-h2.test.ts` «…the dashboard counts the period» | ✅ |
| §5 ثانياً | عدد حالات التأخير | `attendance.late` → `?status=late` | same | ✅ |
| §5 ثانياً | إجمالي ساعات العمل | `attendance.workedMinutes` (+ approved overtime) → `/hr/attendance?from&to` | same (960 min) | ✅ |
| §5 ثانياً | حالات عدم تسجيل الحضور أو الانصراف | `attendance.missingPunches` (final days with a missing in / out) → `?exceptionsOnly=1` | same | ✅ |
| §5 ثالثاً | العقود التي قاربت على الانتهاء | `expiring.contracts` 30/60/90 → `/hr/expiring?kind=contracts` | ✓; `golive-h.test.ts` H5 | ✅ |
| §5 ثالثاً | الوثائق والإقامات التي قاربت على الانتهاء | `expiring.identities`, `expiring.documents` → `/hr/expiring?kind=…` | ✓; `golive-g.test.ts` G5 | ✅ |
| §5 ثالثاً | المستندات التي تحتاج إلى تحديث | `expiring.needsUpdate` = documents and identities already past their expiry (latest version), card «مستندات تحتاج إلى تحديث» → `/hr/expiring?kind=documents&within=30` (expired rows show a negative «المتبقي») (H1) | `hr-h1.test.ts` «§5 رابعاً…» (`needsUpdate`) | ✅ |
| §5 رابعاً | الطلبات الجديدة | `requestsByState.new` = submitted in the period (`?from&to`, default this month) → `/hr/requests?view=all&from&to` (H1) | `hr-h1.test.ts` «§5 رابعاً: the dashboard counts new / pending / approved / rejected / needs-completion…» | ✅ |
| §5 رابعاً | الطلبات المعلقة | `requestsByState.pending` = open and awaiting a decision now (`PENDING_STATES`) → `/hr/requests?view=all&pending=1` | same | ✅ |
| §5 رابعاً | الطلبات المعتمدة | `requestsByState.approved` = decided approved in the period (`decision.at`, survives archiving) → `/hr/requests?view=all&outcome=approved&from&to` | same | ✅ |
| §5 رابعاً | الطلبات المرفوضة | `requestsByState.rejected` → `?outcome=rejected` | same | ✅ |
| §5 رابعاً | الطلبات التي تحتاج إلى استكمال | `requestsByState.needsCompletion` = in «يحتاج استكمال» now → `?state=needs_completion` | same | ✅ |
| §5 خامساً | نسبة اكتمال تقييمات الموظفين | `performance.appraisalCompletionBp` of the open cycles (approved + acknowledged ÷ total) → `/hr/performance` | `hr-h3a.test.ts` (dashboard 2 of 10 = 20 %) | ✅ |
| §5 خامساً | عدد الموظفين الذين لديهم أهداف وظيفية | `performance.employeesWithGoals` (active or achieved goals) | same | ✅ |
| §5 خامساً | الدورات التدريبية المنفذة | `performance.trainingsCompleted` in the dashboard period → `/hr/training` | same | ✅ |
| §5 خامساً | الترقيات والتغييرات الوظيفية | `recentChanges` (transfer / promotion, last 30 days) | ✓ | ✅ |
| §5 | الانتقال من المؤشر الإجمالي إلى التفاصيل، مثل عرض الموظفين المتأخرين أو الطلبات المعلقة أو العقود المنتهية | every KPI tile and every bar links to a filtered list (department / branch / nationality / employment type / status / request state and period / expiring kind); the late employees open `/hr/attendance?status=late` for the period (H2) | `golive-h.test.ts` H5; `hr-h1.test.ts`; `hr-h2.test.ts` (`/days?status=late`) | ✅ |

## §6 الصلاحيات وإدارة المستخدمين (Access Control)

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §6 | صلاحيات مختلفة حسب الدور الوظيفي | RBAC resource × action × scope + field rules (`packages/shared/permissions.ts`, `core/rbac`), system roles in `core/rbac/defaults.ts` | `core/rbac/rbac.test.ts` «enforces on the server: forbidden action returns 403…» | ✅ |
| §6.1 | الموظف: الاطلاع على ملفه الشخصي وتقديم الطلبات ومتابعتها | role `employee`: `hr.employees:view` own, `hr.requests:view/create` own | `hr.test.ts` first test; `requests.test.ts` | ✅ |
| §6.2 | المدير المباشر: الاطلاع على بيانات موظفيه ومراجعة الطلبات وتقييم الأداء | derived `TEAM_LEAD_GRANTS` (team scope: employees view, requests view, tasks, reports) from `directManagerId`; inbox decisions; **appraisal rights 🔜 H3a** | `requests.test.ts` «…scope hides others' requests»; `golive-access.test.ts` E1 (lead sees no sensitive field) | ✅ (performance 🔜 H3a) |
| §6.3 | مسؤول الموارد البشرية: إدارة ملفات الموظفين والطلبات والحضور والعقود والتقارير | role `hr_officer` grants (`hr.employees / hr.contracts / hr.custody / hr.requests:approve / hr.reports / exports`); attendance resources 🔜 H2 | `core/auth/users.test.ts` «HR officer creates a user…»; `requests.test.ts` | ✅ (attendance 🔜 H2) |
| §6.4 | مدير الموارد البشرية: مراجعة واعتماد الإجراءات وفق الصلاحيات | role `hr_manager` (all HR actions + `workflows:edit`) | `requests.test.ts` «A6: nobody decides their own request, even with an HR or Finance role» | ✅ |
| §6.5 | الإدارة التنفيذية: الاطلاع على المؤشرات والتقارير المعتمدة | role `executive`: `hr.employees:view all` (dashboard), `hr.reports:view`, `hr.requests:view/approve`, no sensitive fields | `golive-access.test.ts` E1, E3 | ✅ |
| §6.6 | مدير النظام: إدارة إعدادات النظام والمستخدمين والصلاحيات التقنية | role `system_admin`: users, roles (grantable matrix), settings, workflows, audit, outbox; **no `hr.employees:export`, no financial approval** | `core/rbac/rbac.test.ts` «the system admin has no financial approval right»; `dashboard.test.ts` | ✅ |
| §6 | صلاحيات الاطلاع والتعديل والاعتماد والتصدير قابلة للتخصيص حسب الهيكل التنظيمي | `/admin/roles` edits grants; department-scoped roles; team scope from the org chart; admin-edited roles survive restarts (DECISIONS §20 change 1) | `core/rbac/rbac-sales.test.ts` «1: a default grant the admin removed from a system role stays removed…» | ✅ |

## §7 المتطلبات التقنية والتكامل المستقبلي

| § | Bullet | Implementation | Test | Status |
|---|---|---|---|---|
| §7.1 | التكامل مع بقية وحدات ERP | outbox events `hr.employee.*`, `hr.request.*`, `hr.request.handoff.finance`; shared employee lookups for Sales / tasks | `core/outbox/outbox.test.ts`; `requests.test.ts` advance test | ✅ |
| §7.2 | واجهات برمجية (APIs) تسمح بربط النظام بتطبيق للهواتف الذكية مستقبلاً | REST `/api/v1/hr/*` with cookie session; generated API document `/api/v1/docs` (`core/openapi`) lists every mounted route and its permission | `modules/sales/sales-s5.test.ts` «API document: every Sales, CRM, invoice and discussion route is listed…» (HR routes not asserted) | ✅ · 🔜 H4 HR assertion |
| §7.3 | دعم تعدد الفروع ومواقع التشغيل | `branches`, `sites` (per branch), employee `branchId / siteId`, dashboard by branch | `core/org/org.test.ts` | ✅ |
| §7.4 | دعم الموظفين العاملين في المواقع الميدانية | status «عمل ميداني» counts as on duty (`ON_DUTY_STATUSES`); field shift with several sites and GPS punching (H2) | `core/tasks/distribution.test.ts`; `hr-h2.test.ts` | ✅ |
| §7.5 | حفظ الطلبات والمعاملات كمسودات واستكمالها لاحقاً | `core/drafts` (`PUT /drafts` per `formKey`); HR request form wired (H1); recruitment requisition draft 🔜 H3b | `hr-h1.test.ts` «§7.5 drafts…» | ✅ requests · 🔜 H3b (requisition) |
| §7.6 | سجل تدقيق (Audit Log) لجميع العمليات والتعديلات | `core/audit` on every write, sensitive views / exports flagged; `/admin/audit` | `core/org/org.test.ts` (before/after); `dashboard.test.ts` (sensitive export audited) | ✅ |
| §7.7 | نظام إشعارات داخلي للموظفين والمديرين | `core/notifications` + center `/notifications`; HR types `contract.expiring`, `probation.ending`, `employee.birthday`, `secondment.report_reminder`, `employee.manager_or_department_changed`, `employee.promotion`, `employee.data_updated`, `document.expiring`, `request.decided`, `attendance.missed_punch` (H2) | `core/notifications/notifications.test.ts`; `apps/web/src/test/source-hygiene.test.ts` «every notification type has a badge label» | ✅ |
| §7.8 | حماية البيانات الشخصية والوظيفية وتقييد الوصول إليها | AES-256-GCM identity / IBAN, HKDF per-purpose keys, default-deny sensitive fields, scrypt passwords, TOTP for HR / Finance / admin | `core/auth/hardening.test.ts`, `security.test.ts`; `golive-access.test.ts` E1 | ✅ |
| §7.9 | توفير نسخ احتياطية للبيانات | configuration, not code: `docs/DEPLOY.md` «Backups» (Atlas cloud backup checklist) | — | ✅ (documented; ⏸ DECISIONS §1 infrastructure) |
| §7.10 | واجهات سهلة الاستخدام ومتوافقة مع الأجهزة المختلفة | Tailwind RTL, tables → cards at 375 px; attendance / payslips phone-first | `source-hygiene.test.ts` (copy, keys); 375 px pass 🔜 H4 | ✅ · 🔜 H4 check |
| §7.11 | دعم التوسع وإضافة وظائف جديدة دون إعادة بناء النظام | module registration (`registerHrModule`), settings registry, workflow definitions editable | `core/settings/settings.test.ts`; `core/workflow/workflow.test.ts` | ✅ |
| §7.12 | دراسة إمكانية التكامل مع المنصات الحكومية (قوى، التأمينات الاجتماعية) | `docs/HR_GOV_INTEGRATIONS.md` | — | 🔜 H4 (⏸ Q15) |

## §8 متطلبات أساسية قبل بدء التنفيذ (ترتيب المراحل)

| § | Bullet | Implementation | Status |
|---|---|---|---|
| §8 الأولى | بناء الهيكل التنظيمي؛ تعريف الإدارات والأقسام والفروع؛ إعداد بيانات الموظفين؛ إنشاء ملفات الموظفين الإلكترونية؛ تحديد المستخدمين والصلاحيات | phase 1 (`docs/PHASE1.md`) + H1 audit | ✅ → H1 |
| §8 الثانية | إعداد جداول وفترات العمل؛ بناء نظام الحضور والانصراف؛ تفعيل الموقع الجغرافي؛ بناء طلبات الموظفين ومسارات الاعتماد؛ تفعيل الإشعارات | requests + notifications exist; schedules / attendance / GPS H2 | ✅ partial → 🔜 H2 |
| §8 الثالثة | إدارة العقود والوثائق؛ إدارة الرواتب والمزايا؛ متابعة الأداء والتقييم؛ إدارة التدريب والتطوير؛ إنهاء الخدمة | contracts exist; payroll / performance / training H3a; end of service H3b | ✅ partial → 🔜 H3a / H3b |
| §8 الرابعة | بناء لوحة تحكم الموارد البشرية؛ تفعيل التقارير والتصدير المرن؛ تجهيز واجهات الربط البرمجية (APIs)؛ اختبار التكامل مع بقية وحدات ERP؛ تهيئة النظام للتطبيق المستقبلي | dashboard / export / API document exist in part; completion H4 | ✅ partial → 🔜 H4 |

## §9 مخرجات التنفيذ المطلوبة (acceptance walk — completed in H4)

| # | Output | Screen | API | Test | Status |
|---|---|---|---|---|---|
| 1 | واجهة رئيسية لقسم الموارد البشرية | `/hr` landing (`HrHomePage`): queues (requests awaiting HR, needs completion, pending profile changes, secondments without report), alerts (expiring within 30 days, probation, headcount), shortcuts; later queues arrive with H2–H3 | `/hr/dashboard/hr`, `/hr/requests?view=queue`, `/hr/profile-changes` | `hr-h1.test.ts` (dashboard counts), web hygiene tests (routes, keys) | ✅ |
| 2 | واجهة الهيكل التنظيمي | `/admin/departments|units|branches|positions` + org-chart tree `/hr/org-chart` (collapsible, search, scope-limited) | `/org/*`, `GET /hr/org-chart` | `core/org/org.test.ts`; `hr-h1.test.ts` «§9.2 org chart…» | ✅ |
| 3 | واجهة ملف الموظف الإلكتروني | `/hr/employees/:id` (8 tabs: + الحضور, الإجازات in H2), `/me/profile` | `/hr/employees/*`, `/hr/me`, `/hr/attendance/days`, `/hr/leave/*` | `hr.test.ts`, `portal.test.ts`, `hr-h2.test.ts` | ✅ (payroll / performance / offboarding tabs H3) |
| 4 | واجهة التوظيف وإجراءات مباشرة الموظف | `/hr/recruitment/*`, `/manager/requisitions` | `/hr/recruitment/*` | — | 🔜 H3b |
| 5 | واجهة الحضور والانصراف | `/me/attendance` (phone-first), `/manager/attendance`, `/hr/attendance`, `/hr/shifts`, `/hr/leave` | `/hr/attendance/*`, `/hr/shifts/*`, `/hr/leave/*` | `hr-h2.test.ts` (10 tests); web hygiene and label-parity tests | ✅ |
| 6 | واجهة طلبات الموظفين والخدمات الذاتية | `/me/requests`, `/manager/requests`, `/hr/requests`, detail page; eleven types since H2 | `/hr/requests/*` | `requests.test.ts`; `hr-h1.test.ts` (drafts, archive); `hr-h2.test.ts` | ✅ |
| 7 | واجهة العقود والوثائق | employee tabs العقود / الوثائق, `/hr/expiring` | `/hr/employees/:id/contracts*`, `/documents` | `hr.test.ts`, `golive-h.test.ts` H5; `hr-h1.test.ts` (`hr.documents_expiring`) | ✅ |
| 8 | واجهة الرواتب والمزايا | `/hr/payroll`, `/hr/payroll/:id`, `/finance/payroll` (thin stage), `/me/payslips` (phone-first), employee tab «الرواتب» | `/hr/payroll/*`, `/hr/payslips/*`, `/finance/payroll/*` | `hr-h3a.test.ts` | ✅ |
| 9 | واجهة تقييم الأداء والتدريب | `/hr/performance` (cycles, appraisals, goals, plans, template), `/hr/performance/appraisals/:id`, `/hr/performance/plans/:id`, `/manager/appraisals`, `/me/performance`, `/hr/discipline`, `/hr/training`, `/hr/training/:id`, `/me/training`, employee tabs | `/hr/performance/*`, `/hr/discipline/*`, `/hr/training/*` | `hr-h3a.test.ts` | ✅ |
| 10 | واجهة إنهاء الخدمة | `/hr/offboarding/*`, `/it/offboarding` | `/hr/offboarding/*` | — | 🔜 H3b |
| 11 | لوحة تحكم الموارد البشرية | `/hr/dashboard` (headcount, expiries, requests, attendance since H2) | `/hr/dashboard/hr`, `/hr/dashboard/expiring` | `dashboard.test.ts`, `hr-h1.test.ts`, `hr-h2.test.ts` | ✅ (performance cards H3a / H4) |
| 12 | نظام التقارير والتصدير إلى Excel | `/hr/export` | `/export/resources`, `/export` | `core/export/export.test.ts`, `dashboard.test.ts` | ✅ (scope grows per slice) |
| 13 | نظام الصلاحيات والإشعارات | `/admin/roles`, `/notifications` | `/roles`, `/notifications` | `core/rbac/rbac.test.ts`, `core/notifications/notifications.test.ts` | ✅ |
| 14 | توثيق واجهات الربط البرمجية وإمكانية التوسع مستقبلاً | `/api/v1/docs` | generated | `sales-s5.test.ts` (Sales routes) | ✅ · 🔜 H4 HR assertion + `docs/HR_GOV_INTEGRATIONS.md` |

## H1 audit — gaps found in the code (2026-11-24) and what H1 did about them

| # | Gap | H1 outcome |
|---|---|---|
| planned 1–8 | five request cards, request drafts, employee multi-select, expiring-documents export, org-chart view, `/hr` landing, `gosiJoinDate`, seed-on-empty-database test | ✅ all built — rows above, `hr-h1.test.ts`, `seed.test.ts` |
| 1 | no notification on a status change | ✅ `changeStatus` notifies employee + direct manager |
| 2 | no employment-type distribution | ✅ `headcount.byEmploymentType` + card |
| 3 | branch / nationality / contract bars without drill-down; list lacked filters | ✅ links + `nationality` / `employmentType` list filters (contract-type bar stays unlinked: a contract type is not an employee filter) |
| 4 | no export resource for HR requests | ✅ `hr.requests` |
| 5 | «أرشفة الطلب» never happened | ✅ daily job `hr.requests.autoclose` + setting `hr.requestAutoCloseBusinessDays` (5) — **default to confirm, DECISIONS §21** |
| 6 | job description not shown on the file / profile | ✅ read-only rows |
| 7 | «تأمين طبي» vs «وجود تأمين طبي» | ✅ relabelled (export + file) |
| 8 | site shown as «المواقع التشغيلية» | ✅ «موقع العمل» on file and profile |
| 9 | built bullets without tests | ✅ drafts, HR routes in the API document, GOSI date, org chart; units / branches / positions CRUD tests stay a 🔜 H4 item (`core/org`) |
| 10 | «المستندات التي تحتاج إلى تحديث» had no meaning | ✅ `expiring.needsUpdate` (already expired) + card |
| 11 | drafts unused by the web | ✅ wired |
| 12 | no parity test between shared labels and the locale | ✅ `apps/web/src/test/hr-labels.test.ts` |
| 13 | direct manager lacks `hr.contracts:view` team | noted, not a spec defect — unchanged |
| 14 | seed swallowed a failing block | ✅ try/catch removed; `seed.test.ts` runs the whole seed on an empty database |

### Original findings (kept for the record)

Beyond the eight gaps already planned for H1 (five request cards, request drafts, employee multi-select in export, expiring-documents export, org-chart view, `/hr` landing, `gosiJoinDate`, seed-on-empty-database test):

1. **§3.7 «إرسال إشعار للموظف عند … تغيير وضعه الوظيفي» — no notification on a status change.** `changeStatus` (`apps/api/src/modules/hr/service.ts` ~L542–615) writes the event, the audit row and the outbox event `hr.employee.status_changed`, but calls no `notify(...)`; `events.ts` has no subscriber for it either. Promotion and transfer do notify (`employee.promotion`, `employee.manager_or_department_changed`). An employee suspended, seconded, put on leave or reinstated is never told. Fix: notify the employee (and the direct manager) from `changeStatus`.
2. **§5 أولاً «توزيع الموظفين حسب … نوع التوظيف» — the dashboard has no employment-type distribution.** `dashboard.routes.ts` returns `headcount.byContractType` (from live contracts) and the page shows it under «حسب نوع العقد»; `employmentType` is never aggregated. Add `byEmploymentType` (and keep the contract-type card).
3. **§5 last paragraph — branch and nationality bars have no drill-down.** `HrDashboardPage.tsx` passes `linkFor` only for `byDepartment` and `to` only for `byStatus`; `byBranch`, `byNationality`, `byContractType` render without links although `/hr/employees` accepts `branchId` (and would need `nationality` / `employmentType` query filters — `listEmployeesQuerySchema` has `branchId`, `status`, `departmentId`, `managerId` only).
4. **§4 scope «الطلبات» — no export resource for HR requests.** Only `employees`, `employee_reports` (and `users`, Sales resources) are registered; HR requests (number, type, employee, state, dates, approver) cannot be exported from `/hr/export` although §4 lists «الطلبات» explicitly. Add `hr.requests` resource (permission `hr.requests:export`, already granted to HR roles).
5. **§3.5 م4 «أرشفة الطلب إلكترونياً» — closing is manual and never happens.** The `close` transition (approved / rejected → مغلق) is allowed to HR and `system`, but nothing calls it: no job, no UI button found (`requests.service.ts` only filters on `closedAt`). Decide: auto-close N business days after the decision (as tickets do, DECISIONS §8) or an explicit HR action — then test it.
6. **§3.3 / §3.1.4 «الوصف الوظيفي» is editable on `/admin/positions` but not shown on the employee file or the portal profile.** `hr.jobDescription` is used only in `PositionsPage.tsx`; `EmployeePage.tsx` and `ProfilePage.tsx` show the position title only. Show the position's `descriptionAr` in the job section (read-only).
7. **§4 example label paraphrased:** the export field reads «تأمين طبي» (`modules/hr/index.ts`) while the spec says «وجود تأمين طبي»; the employee-file label `hr.medicalInsurance` is also «تأمين طبي». Harmless, but the prompt asks for verbatim labels — rename the export column.
8. **§3.3 «الفرع وموقع العمل» label:** the file shows the site under `admin.org.sites` «المواقع التشغيلية» (admin wording) rather than the spec's «موقع العمل»; the create/edit form uses `hr.branch` «الفرع» only. Consider labels «الفرع» / «موقع العمل» in the HR file.
9. **Tests missing for built bullets:** units / branches / positions CRUD (only departments and sites are tested in `core/org/org.test.ts`); the employee-file rows «الفرع وموقع العمل», «الملاحظات» on requests, «الرقم الوظيفي» on the request detail; the document types المؤهلات العلمية / الشهادات المهنية / الوصف الوظيفي (covered only by the generic documents test); the drafts API (`core/drafts` has no test at all); the `/api/v1/docs` content for HR routes (only Sales/CRM routes are asserted in `sales-s5.test.ts`).
10. **§3.9 «المستندات التي تحتاج إلى تحديث» (§5 ثالثاً) has no distinct meaning in the code:** already-expired documents are folded into the 30-day bucket because the query has no lower bound (`expiryDate <= d(90)`); there is no «منتهية» count or filter on `/hr/expiring`. Add an `expired` bucket / `kind=expired` or document that «تحتاج إلى تحديث» = expired.
11. **§7.5 drafts:** `core/drafts` exists but `_form.tsx` / `NewRequestDialog.tsx` never call `/drafts`; `saveDraftSchema` is unused by the web app (grep found no `drafts` usage under `apps/web/src`). Already an H1 item; noting that the API side also lacks a test and an access check beyond `userId` (fine, drafts are per user).
12. **§3.1.7 spec list vs merged list:** the spec names four statuses; the code ships seven (DECISIONS §6). Covered by a decision, but the coverage row should keep saying so, and `EMPLOYEE_STATUS_AR` is the only place the labels live (locale `hr.status.*` duplicates them — a hygiene test for parity between `packages/shared` Arabic maps and `common.json` would catch drift; none exists for HR enums).
13. **§6.2 «تقييم الأداء» for the direct manager** has no grant yet (expected, H3a) — but `TEAM_LEAD_GRANTS` also lacks `hr.contracts:view` team, so a direct manager cannot see a report's contract end date on «فريقي»; the spec only requires «الاطلاع على بيانات موظفيه», which the public file satisfies. Noting, not a defect.
14. **Seed:** `seedSales.ts` wraps the S5 every-state block in `try { … } catch (err) { log; skip }` (L570–805). The prompt's rule «the seed never swallows errors» means this catch must go (rethrow) when the seed test is added.
