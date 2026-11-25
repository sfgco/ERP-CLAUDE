#!/usr/bin/env node
/**
 * Department worktrees — docs/WORKTREES.md.
 *
 *   npm run wt:list                      every department: folder, branch, ports, database
 *   npm run wt:new   <dept> <slice>      ../erp-1-<dept> on branch <dept>-<slice> from the latest origin/main (or an existing branch), .env, npm install, seed
 *   npm run wt:env   <dept>              (re)write that worktree's .env from the table
 *   npm run wt:dev   <dept>              start its API + web on its own ports and database (main = the erp-1 checkout)
 *   npm run wt:sync  <dept> [--rebase]   bring origin/main into the branch (merge by default; --rebase needs the owner's OK to force-push)
 *   npm run wt:check <dept>              lint + typecheck + FULL test suite + web build, the shared files it touched, ff-mergeable?
 *   npm run wt:rm    <dept>              remove the worktree folder when clean and pushed; the branch is always kept
 *
 * Plain Node, no dependencies. Never deletes a branch, never force-pushes, never touches `deploy-aws`, never checks
 * out another branch in the main checkout (erp-1 ALWAYS stays on main).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One row per department (CLAUDE.md "Modules"); ports and databases never overlap. `main` is the erp-1 checkout itself.
 * API ports 4000 + 100 per department; web ports 5200 + 10 per department — deliberately outside Vite's default range
 * (5173, 5174, …), which the owner's other local Vite projects occupy (owner decision 2026-11-25).
 */
export const DEPARTMENTS = {
  main: { api: 4000, web: 5200, db: 'eayni_main', nameAr: 'الفرع الرئيسي', owns: [] },
  sales: {
    api: 4100,
    web: 5210,
    db: 'eayni_sales',
    nameAr: 'المبيعات',
    owns: ['apps/api/src/modules/sales/', 'apps/api/src/modules/crm/', 'apps/api/src/seedSales.ts', 'apps/web/src/pages/sales/', 'apps/web/src/pages/cs/', 'packages/shared/src/schemas/sales', 'packages/shared/src/schemas/crm.ts', 'docs/SALES', 'docs/prompts/sales.md'],
  },
  hr: {
    api: 4200,
    web: 5220,
    db: 'eayni_hr',
    nameAr: 'الموارد البشرية',
    owns: [
      'apps/api/src/modules/hr/',
      'apps/api/src/seedHr.ts',
      'apps/api/src/seedAttendance.ts',
      'apps/api/src/seedRequests.ts',
      'apps/api/src/seedEmployeeReports.ts',
      'apps/api/src/seedH3a.ts',
      'apps/web/src/pages/hr/',
      'apps/web/src/pages/me/',
      'apps/web/src/pages/manager/',
      'apps/web/src/pages/requests/',
      'apps/web/src/pages/reports/',
      'apps/web/src/pages/dashboards/HrDashboardPage.tsx',
      'packages/shared/src/schemas/hr',
      'packages/shared/src/schemas/attendance.ts',
      'packages/shared/src/schemas/payroll.ts',
      'packages/shared/src/schemas/performance.ts',
      'packages/shared/src/schemas/training.ts',
      'packages/shared/src/schemas/portal.ts',
      'docs/HR',
      'docs/prompts/hr.md',
    ],
  },
  finance: { api: 4300, web: 5230, db: 'eayni_finance', nameAr: 'المالية', owns: ['apps/api/src/modules/finance/', 'apps/web/src/pages/finance/', 'packages/shared/src/schemas/finance', 'docs/FINANCE', 'docs/prompts/finance.md'] },
  cs: { api: 4400, web: 5240, db: 'eayni_cs', nameAr: 'خدمة العملاء', owns: ['apps/api/src/modules/cs/', 'apps/web/src/pages/cs/', 'packages/shared/src/schemas/cs', 'docs/CS', 'docs/prompts/cs.md'] },
  ops: { api: 4500, web: 5250, db: 'eayni_ops', nameAr: 'التشغيل', owns: ['apps/api/src/modules/ops/', 'apps/web/src/pages/ops/', 'packages/shared/src/schemas/ops', 'docs/OPS', 'docs/prompts/ops.md'] },
  procurement: { api: 4600, web: 5260, db: 'eayni_procurement', nameAr: 'المشتريات', owns: ['apps/api/src/modules/procurement/', 'apps/web/src/pages/procurement/', 'packages/shared/src/schemas/procurement', 'docs/PRC', 'docs/prompts/procurement.md'] },
  marketing: { api: 4700, web: 5270, db: 'eayni_marketing', nameAr: 'التسويق', owns: ['apps/api/src/modules/marketing/', 'apps/web/src/pages/marketing/', 'packages/shared/src/schemas/marketing', 'docs/MKT', 'docs/prompts/marketing.md'] },
  sustainability: { api: 4800, web: 5280, db: 'eayni_sustainability', nameAr: 'التنمية المستدامة والشراكات', owns: ['apps/api/src/modules/sustainability/', 'apps/web/src/pages/sustainability/', 'packages/shared/src/schemas/sustainability', 'docs/SUS', 'docs/prompts/sustainability.md'] },
  it: { api: 4900, web: 5290, db: 'eayni_it', nameAr: 'التقنية', owns: ['apps/api/src/modules/it/', 'apps/web/src/pages/it/', 'packages/shared/src/schemas/it', 'docs/IT', 'docs/prompts/it.md'] },
};

const PROTECTED_BRANCHES = ['main', 'deploy-aws'];

// ---------------------------------------------------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) {
    const msg = (r.stderr || r.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed${msg ? `: ${msg}` : ''}`);
  }
  return (r.stdout ?? '').trim();
}
const git = (args, opts) => sh('git', args, opts);

/** The main checkout (erp-1): git's common dir lives there whichever worktree this script runs from. */
const mainRoot = dirname(resolve(here, git(['rev-parse', '--git-common-dir'], { cwd: here })));
const parent = dirname(mainRoot);
const mainName = basename(mainRoot); // erp-1
const folderOf = (dept) => (dept === 'main' ? mainRoot : join(parent, `${mainName}-${dept}`));

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}
function dept(code) {
  if (!code || !DEPARTMENTS[code]) fail(`unknown department "${code ?? ''}". Known: ${Object.keys(DEPARTMENTS).join(', ')}`);
  return { code, ...DEPARTMENTS[code], folder: folderOf(code) };
}
function branchOf(folder) {
  return git(['branch', '--show-current'], { cwd: folder });
}
function isDirty(folder) {
  return git(['status', '--porcelain'], { cwd: folder }).length > 0;
}
function envText(d) {
  return `# ${d.nameAr} — written by \`npm run wt:env ${d.code}\` (docs/WORKTREES.md). Gitignored; edit freely.\nAPI_PORT=${d.api}\nWEB_PORT=${d.web}\nDEV_DB_NAME=${d.db}\n`;
}
function writeEnv(d) {
  writeFileSync(join(d.folder, '.env'), envText(d));
  console.log(`  .env → API ${d.api} · web ${d.web} · DB ${d.db}`);
}
function assertMainStaysOnMain() {
  const b = branchOf(mainRoot);
  if (b !== 'main') fail(`${mainName} is on "${b}". It must ALWAYS stay on main (docs/WORKTREES.md); switch it back with: git -C ${mainRoot} checkout main`);
}

// ---------------------------------------------------------------------------------------------------------------------
function list() {
  assertMainStaysOnMain();
  const rows = Object.keys(DEPARTMENTS).map((code) => {
    const d = dept(code);
    const exists = existsSync(join(d.folder, '.git')) || code === 'main';
    const branch = exists ? branchOf(d.folder) : '—';
    const head = exists ? git(['log', '--oneline', '-1', '--format=%h'], { cwd: d.folder }) : '—';
    const env = exists && existsSync(join(d.folder, '.env')) ? '.env ✓' : exists ? '.env ✗' : '';
    return { department: code, folder: basename(d.folder), present: exists ? '✓' : '', branch, head, api: d.api, web: d.web, db: d.db, env };
  });
  console.table(rows);
  console.log(`main checkout: ${mainRoot} (always on main)\nshared MongoDB: 127.0.0.1:27117 · data ${join(mainRoot, 'apps/api/.data/mongo')} · start it alone with: npm run mongo`);
}

function envCmd(code) {
  const d = dept(code);
  if (!existsSync(d.folder)) fail(`${d.folder} does not exist — create it with: npm run wt:new ${code} <slice>`);
  writeEnv(d);
}

function newWorktree(code, slice) {
  assertMainStaysOnMain();
  const d = dept(code);
  if (code === 'main') fail('main is the erp-1 checkout itself');
  if (!slice || !/^[a-z0-9][a-z0-9-]*$/.test(slice)) fail(`give the slice name: npm run wt:new ${code} <slice>  (branch ${code}-<slice>, e.g. ${code}-s6 or ${code}-h3b)`);
  const branch = `${code}-${slice}`;
  if (existsSync(d.folder)) fail(`${d.folder} already exists (one worktree per department). Remove it first: npm run wt:rm ${code}`);
  console.log(`▸ fetching origin`);
  git(['fetch', '--quiet', 'origin'], { cwd: mainRoot });
  const localExists = git(['branch', '--list', branch], { cwd: mainRoot }) !== '';
  const remoteExists = git(['branch', '-r', '--list', `origin/${branch}`], { cwd: mainRoot }) !== '';
  if (localExists) {
    console.log(`▸ worktree ${d.folder} on the existing branch ${branch}`);
    git(['worktree', 'add', d.folder, branch], { cwd: mainRoot, inherit: true });
  } else if (remoteExists) {
    console.log(`▸ worktree ${d.folder} tracking origin/${branch}`);
    git(['worktree', 'add', '--track', '-b', branch, d.folder, `origin/${branch}`], { cwd: mainRoot, inherit: true });
  } else {
    console.log(`▸ worktree ${d.folder} on the new branch ${branch} from origin/main`);
    git(['worktree', 'add', '-b', branch, d.folder, 'origin/main'], { cwd: mainRoot, inherit: true });
  }
  writeEnv(d);
  console.log('▸ npm install');
  sh('npm', ['install', '--no-fund', '--no-audit'], { cwd: d.folder, inherit: true });
  console.log(`▸ seed → ${d.db} (every department's sample data; starts the shared MongoDB if it is not running)`);
  sh('npm', ['run', 'seed'], { cwd: d.folder, inherit: true });
  console.log(`\n✓ ${d.nameAr}: ${d.folder} on ${branch}\n  start:  npm run wt:dev ${code}     → API http://localhost:${d.api} · web http://localhost:${d.web} · DB ${d.db}\n  sync:   npm run wt:sync ${code}\n  check:  npm run wt:check ${code}\n  push:   git -C ${d.folder} push -u origin ${branch}`);
}

function dev(code) {
  const d = dept(code);
  if (!existsSync(d.folder)) fail(`${d.folder} does not exist — npm run wt:new ${code} <slice>`);
  if (code === 'main') assertMainStaysOnMain();
  if (!existsSync(join(d.folder, '.env'))) writeEnv(d);
  console.log(`▸ ${d.nameAr} (${branchOf(d.folder)}): API http://localhost:${d.api} · web http://localhost:${d.web} · DB ${d.db}`);
  const r = spawnSync('npm', ['run', 'dev'], { cwd: d.folder, stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

function sync(code, flags) {
  const d = dept(code);
  if (code === 'main') fail('main is synced with: git -C ' + mainRoot + ' pull --ff-only');
  if (!existsSync(d.folder)) fail(`${d.folder} does not exist`);
  const branch = branchOf(d.folder);
  if (PROTECTED_BRANCHES.includes(branch)) fail(`${branch} is protected`);
  if (isDirty(d.folder)) fail(`${d.folder} has uncommitted changes — commit or stash them first (never discard)`);
  git(['fetch', '--quiet', 'origin'], { cwd: d.folder });
  const behind = git(['rev-list', '--count', `${branch}..origin/main`], { cwd: d.folder });
  if (behind === '0') return console.log(`✓ ${branch} already contains origin/main`);
  if (flags.includes('--rebase')) {
    console.log(`▸ rebasing ${branch} onto origin/main (${behind} new commits on main)`);
    git(['rebase', 'origin/main'], { cwd: d.folder, inherit: true });
    const pushed = git(['branch', '-r', '--list', `origin/${branch}`], { cwd: d.folder }) !== '';
    if (pushed) console.log(`\n! ${branch} was already pushed. A rebase rewrites it, so the push needs the owner's explicit OK and then:\n  git -C ${d.folder} push --force-with-lease origin ${branch}\nThis script never force-pushes.`);
  } else {
    console.log(`▸ merging origin/main into ${branch} (${behind} new commits on main) — no history rewritten, a plain push follows`);
    git(['merge', '--no-edit', 'origin/main'], { cwd: d.folder, inherit: true });
  }
  console.log(`✓ ${branch} now contains origin/main. Rerun the full checks: npm run wt:check ${code}`);
}

/** Files changed on the branch outside the department's own folders — the report must list each with its reason. */
function sharedFilesChanged(d) {
  const files = git(['diff', '--name-only', 'origin/main...HEAD'], { cwd: d.folder }).split('\n').filter(Boolean);
  return files.filter((f) => !d.owns.some((o) => f.startsWith(o)));
}

function check(code) {
  const d = dept(code);
  if (!existsSync(d.folder)) fail(`${d.folder} does not exist`);
  const branch = branchOf(d.folder);
  git(['fetch', '--quiet', 'origin'], { cwd: d.folder });
  console.log(`▸ ${d.nameAr} · ${branch} · full checks (every department's tests run, not only ${code}'s)`);
  for (const step of [['run', 'lint'], ['run', 'typecheck'], ['run', 'test'], ['run', 'build', '-w', 'apps/web']]) sh('npm', step, { cwd: d.folder, inherit: true });
  const shared = code === 'main' ? [] : sharedFilesChanged(d);
  const behind = code === 'main' ? '0' : git(['rev-list', '--count', `${branch}..origin/main`], { cwd: d.folder });
  console.log('\n──────── summary ────────');
  console.log(`checks: lint ✓ typecheck ✓ tests ✓ web build ✓`);
  if (code !== 'main') {
    console.log(behind === '0' ? `fast-forward: ✓ ${branch} contains origin/main — \`git merge --ff-only ${branch}\` on main is possible` : `fast-forward: ✗ origin/main has ${behind} commits not in ${branch} — run: npm run wt:sync ${code}`);
    console.log(shared.length ? `shared files changed (list each with its reason in the report):\n  ${shared.join('\n  ')}` : 'shared files changed: none — the branch stays inside its own folders');
  }
}

function rm(code) {
  const d = dept(code);
  if (code === 'main') fail('the main checkout is never removed');
  if (!existsSync(d.folder)) fail(`${d.folder} does not exist`);
  const branch = branchOf(d.folder);
  if (isDirty(d.folder)) fail(`${d.folder} has uncommitted changes — commit or stash them first; nothing is discarded by this script`);
  git(['fetch', '--quiet', 'origin'], { cwd: d.folder });
  const remote = git(['branch', '-r', '--list', `origin/${branch}`], { cwd: d.folder }) !== '';
  const unpushed = remote ? git(['rev-list', '--count', `origin/${branch}..${branch}`], { cwd: d.folder }) : 'all';
  if (unpushed !== '0') fail(`${branch} has ${unpushed} commits not on origin — push first: git -C ${d.folder} push -u origin ${branch}`);
  git(['worktree', 'remove', d.folder], { cwd: mainRoot, inherit: true });
  console.log(`✓ removed ${d.folder}. Branch ${branch} is kept (local and origin); recreate the worktree any time with: npm run wt:new ${code} ${branch.replace(`${code}-`, '')}`);
}

// ---------------------------------------------------------------------------------------------------------------------
const [cmd, arg1, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'list':
    case undefined:
      list();
      break;
    case 'new':
      newWorktree(arg1, rest[0]);
      break;
    case 'env':
      envCmd(arg1);
      break;
    case 'dev':
      dev(arg1);
      break;
    case 'sync':
      sync(arg1, rest);
      break;
    case 'check':
      check(arg1);
      break;
    case 'rm':
      rm(arg1);
      break;
    default:
      fail(`unknown command "${cmd}". See the header of scripts/wt.mjs or docs/WORKTREES.md`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
