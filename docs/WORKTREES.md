# Department worktrees

One git worktree per department, side by side with the main checkout, each with its own ports and its own local
database — so work on one department never breaks or hides another (owner decision 2026-11-25). The single source of
code stays one repository and one `main`; the worktrees are checkouts of department branches.

## 1. The table

| Department | Folder (next to `erp-1`) | Branch prefix | API | Web | Local DB | Owns (a branch changes only these) |
|---|---|---|---|---|---|---|
| **main** (demo of everything merged) | `erp-1` | `main` only — **never check out another branch here** | 4000 | 5200 | `eayni_main` | — |
| Sales + shared CRM | `erp-1-sales` | `sales-<slice>` (`sales-s6`, …) | 4100 | 5210 | `eayni_sales` | `apps/api/src/modules/{sales,crm}/`, `apps/api/src/seedSales.ts`, `apps/web/src/pages/{sales,cs}/`, `packages/shared/src/schemas/sales*.ts`, `crm.ts`, `docs/SALES*.md`, `docs/prompts/sales.md` |
| HR + Employee Portal | `erp-1-hr` | `hr-<slice>` (`hr-h3b`, `hr-h4`, …) | 4200 | 5220 | `eayni_hr` | `apps/api/src/modules/hr/`, `apps/api/src/seed{Hr,Attendance,Requests,EmployeeReports,H3a}.ts`, `apps/web/src/pages/{hr,me,manager,requests,reports}/`, `apps/web/src/pages/dashboards/HrDashboardPage.tsx`, `packages/shared/src/schemas/{hr*,attendance,payroll,performance,training,portal}.ts`, `docs/HR*.md`, `docs/prompts/hr.md` |
| Finance | `erp-1-finance` | `finance-<slice>` | 4300 | 5230 | `eayni_finance` | `apps/api/src/modules/finance/`, `apps/web/src/pages/finance/`, `packages/shared/src/schemas/finance*.ts`, `docs/FINANCE*.md` |
| Customer Service | `erp-1-cs` | `cs-<slice>` | 4400 | 5240 | `eayni_cs` | `modules/cs/`, `pages/cs/`, `schemas/cs*.ts`, `docs/CS*.md` |
| Operations | `erp-1-ops` | `ops-<slice>` | 4500 | 5250 | `eayni_ops` | `modules/ops/`, `pages/ops/`, `schemas/ops*.ts`, `docs/OPS*.md` |
| Procurement | `erp-1-procurement` | `procurement-<slice>` | 4600 | 5260 | `eayni_procurement` | `modules/procurement/`, `pages/procurement/`, `schemas/procurement*.ts`, `docs/PRC*.md` |
| Marketing | `erp-1-marketing` | `marketing-<slice>` | 4700 | 5270 | `eayni_marketing` | `modules/marketing/`, `pages/marketing/`, `schemas/marketing*.ts`, `docs/MKT*.md` |
| Sustainability (الاستدامة) | `erp-1-sustainability` | `sustainability-<slice>` | 4800 | 5280 | `eayni_sustainability` | `modules/sustainability/`, `pages/sustainability/`, `schemas/sustainability*.ts`, `docs/SUS*.md` |
| IT | `erp-1-it` | `it-<slice>` | 4900 | 5290 | `eayni_it` | `modules/it/`, `pages/it/`, `schemas/it*.ts`, `docs/IT*.md` |

The table is code: `scripts/wt.mjs` (`DEPARTMENTS`). Web ports are 5200 + 10 per department, outside Vite's default range
(5173, 5174, …) so they never collide with other local Vite projects; API ports are 4000 + 100 per department. Only Sales, HR and Finance have worktrees today; `wt:new` creates
the others when their work starts. CI runs on every prefix above plus `infra-*` (platform work).

**Everything not in the "Owns" column is shared code**: `apps/api/src/core/`, `app.ts`, `bootstrap.ts`, `config.ts`,
`seed.ts`, `subscribers.ts`, `packages/shared/src/` (permissions, notifications, settings, enums, common schemas),
`apps/web/src/{router.tsx,lib/,shared/,locales/,test/}`, `AppShell.tsx`, `.github/`, root `package.json`,
`serverless.yml`, `docs/DECISIONS.md`, `CLAUDE.md`. The one Arabic locale file, the one navigation file and `seed.ts`
are the usual collision points between departments.

## 2. Ports, databases and `.env`

Each worktree has its own `.env` in its root (gitignored; `.env.example` documents it):

```
API_PORT=4200
WEB_PORT=5220
DEV_DB_NAME=eayni_hr
```

- The API reads the worktree's `.env` once at start (`apps/api/src/config.ts`; shell variables win; never loaded in
  tests or deployed stages). Vite reads the same file for the web port and the `/api` proxy target (`strictPort`: a
  busy port is an error, not a hop to the next one).
- **One local MongoDB for all worktrees**: `127.0.0.1:27117`, replica set `eayni-dev`, data under the main checkout's
  `apps/api/.data/mongo` whichever worktree starts it. Every worktree uses its own database name on that server, so
  the departments' demos never see each other's data and a reseed of one never touches another. Start it alone with
  `npm run mongo` (any worktree), or let the first `npm run dev` / `npm run seed` start it.
- `MONGODB_URI` in `.env` replaces all of that (another server); leave it empty locally.

## 3. Commands (run from any worktree; the script finds the main checkout by itself)

| Command | What it does |
|---|---|
| `npm run wt:list` | the table above with what exists: folder, branch, HEAD, `.env` |
| `npm run wt:new <dept> <slice>` | `git fetch`; worktree `../erp-1-<dept>` on branch `<dept>-<slice>` **from the latest `origin/main`** (an existing local or remote branch of that name is checked out instead, so in-progress work moves without losing a commit); writes `.env`; `npm install`; `npm run seed` into the department's database |
| `npm run wt:dev <dept>` | `npm run dev` in that worktree → its API and web ports, its database (`main` = the `erp-1` checkout) |
| `npm run wt:sync <dept>` | `git fetch`, then **merges `origin/main` into the branch** (no history rewritten, a plain push follows). `--rebase` rebases instead and prints the `--force-with-lease` command for the owner — the script never force-pushes |
| `npm run wt:check <dept>` | lint, typecheck, the **full test suite** (every department), web build; then: is the branch fast-forwardable onto `origin/main`, and which **shared files** it changed |
| `npm run wt:rm <dept>` | removes the worktree folder only when it is clean and fully pushed; **the branch is always kept** (local and origin) |
| `npm run wt:env <dept>` | rewrites `.env` from the table |
| `npm run mongo` | the shared local MongoDB on its own, for all worktrees |
| `npm run seed` | **one seed with every department's sample data** (org, users, HR, attendance, requests, tasks, tickets, news, reports, Sales/CRM, payroll/performance/training) into this worktree's database — every demo shows the whole app |

Typical day on HR:

```bash
npm run wt:dev hr                 # http://localhost:5220 (API 4200, DB eayni_hr)
# … work on erp-1-hr, commit with the spec citation …
git -C ../erp-1-hr push -u origin hr-h3b
npm run wt:sync hr                # pick up what landed on main
npm run wt:check hr               # full checks + shared-files list + ff-mergeable?
```

## 4. Rules that protect each department

**Departments and folders (owner rule 2026-11-26):**
1. Every department has its own worktree folder `../erp-1-<dept>` and its own entry in the VS Code multi-root workspace
   `../eayni-erp.code-workspace` (beside the worktrees, outside every repo, never committed) under its Arabic name:
   المبيعات، الموارد البشرية، المالية، خدمة العملاء، التشغيل، المشتريات، التسويق، الاستدامة، التقنية; `erp-1` appears as
   «main — لا تعدّل هنا».
2. A new department always starts with `npm run wt:new <dept> <slice>`: the folder from the latest `main`, its `.env`,
   `npm install`, the seed, and the workspace entry (the file is created with the main entry when missing). `wt:rm` removes
   the folder and its workspace entry; the branch stays.
3. Work on a department only inside its own folder — never in `erp-1`, never in another department's folder.
4. `erp-1` always stays on `main`: no edits, no commits, no branch switches there.

1. **`erp-1` ALWAYS stays on `main`.** Never check out another branch there; it is the demo of everything merged
   (API 4000, web 5200, DB `eayni_main`). Department work happens in the department's worktree. `wt:*` refuses to run
   while `erp-1` is on another branch.
2. **One worktree per department, one branch prefix per department**, always created from the latest `origin/main`.
   Never create a worktree inside another, never share a folder between branches.
3. **A department branch changes only its own folders** (the "Owns" column). When it must touch shared code, the
   slice report lists **every shared file changed and why** (`wt:check` prints the list). Shared changes that other
   departments depend on (permissions, navigation, locale keys, workflow engine) are called out explicitly to the owner.
4. **Department smoke tests run on every branch** — `apps/api/src/departments.smoke.test.ts` (each department's API
   routes answer 200 for a user with that department's roles, its permissions are granted) and
   `apps/web/src/test/departments.test.ts` (routes in the router, navigation entries and their Arabic labels, API
   mounts, module registration). If any department disappears, CI fails before the branch can merge. Add a row for a
   new department in the same slice that creates it.
5. **Before merging a department branch into `main`:** `npm run wt:sync <dept>` so the branch contains `origin/main`;
   `npm run wt:check <dept>` (full suite green locally, shared files listed); push; GitHub Actions green on the branch;
   the owner's explicit approval; then on `erp-1`: `git pull --ff-only && git merge --ff-only <branch> && git push`.
   Never a merge commit on `main`, never a force-push, never a merge without the owner's word.
6. **Sync often.** Run `wt:sync` after every merge into `main` so departments do not drift. The default is a merge of
   `main` into the branch, which keeps the "never rebase or force-push a pushed branch" rule; a rebase (`--rebase`) is
   only for an unpushed branch or with the owner's explicit OK for that push.
7. **Never delete** a worktree folder with changes, a branch, the `local-s4-attempt-2026-11-12` stash, or anything on
   `deploy-aws` (Ahmed Khaled's branch). `wt:rm` removes a folder only when it is clean and pushed, and keeps the branch.
8. **`.env` is per worktree and gitignored.** Ports and database names come from the table; do not hard-code them in
   code or docs, and do not reuse one worktree's `.env` in another.

## 5. Today's layout (2026-11-25)

| Folder | Branch | State |
|---|---|---|
| `erp-1` | `main` | Sales S1–S5, HR H1–H3a merged; main demo |
| `erp-1-hr` | `hr-h3b` | H3b step 0 (`docs/HR_H3B_LEGAL.md`), awaiting the owner's approval of the legal rules |
| `erp-1-sales` | `sales-s6` | empty branch from `main`, ready for the next Sales slice (rename the slice when it is defined) |
| `erp-1-infra` | `infra-worktrees` | this setup (temporary; removed after the merge) |

Merged branches kept for history: `sales-s4`, `sales-s5`, `hr-h1`, `hr-h2`, `hr-h3a`. Removed worktree folders
(branches kept): `erp-1-hr-h2`, `erp-1-hr-h3a`.
