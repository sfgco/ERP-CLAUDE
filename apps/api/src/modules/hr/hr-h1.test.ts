import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { activateAccount, auth, loginAs, makeDepartment, makeUser, testApp } from '../../test/helpers';
import { setSetting } from '../../core/settings/service';
import { SYSTEM_ACTOR } from '../../core/http/context';
import { Notification } from '../../core/notifications/model';
import { StageLog } from '../../core/workflow/model';
import { collectRoutes } from '../../core/openapi/service';
import { User } from '../../core/auth/model';
import { Position } from '../../core/org/model';
import { HrRequest, HrRequestAction } from './requests.model';
import { runRequestAutoClose } from './requests.service';

const app = () => testApp();
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/**
 * H1 — التأسيس: the gaps the phase-1 audit found [HR §8 المرحلة الأولى]. Each test names the spec bullet it closes.
 */
async function setup() {
  await setSetting('auth.mfaRequiredRoles', [], SYSTEM_ACTOR);
  const ops = await makeDepartment('ops', 'التشغيل');
  const pos = await Position.create({
    code: 'driver',
    titleAr: 'سائق',
    descriptionAr: 'قيادة شاحنة الجمع وتسليم الحاويات',
    departmentId: ops._id,
    active: true,
  });
  await makeUser('hr@eayni.local', [{ role: 'employee' }, { role: 'hr_manager' }]);
  const hr = await loginAs('hr@eayni.local');
  let n = 0;
  const mk = async (email: string, first: string, extra: Record<string, unknown> = {}, directManagerId?: string) => {
    const r = await request(app())
      .post('/api/v1/hr/employees')
      .set(auth(hr))
      .send({
        firstNameAr: first,
        lastNameAr: 'الغامدي',
        gender: 'male',
        nationality: 'سعودي',
        workEmail: email,
        identity: {
          type: 'national_id',
          number: `10${String(50000000 + ++n).padStart(8, '0')}`,
          expiryDate: new Date(Date.now() + 20 * DAY),
        },
        hireDate: '2024-01-10',
        departmentId: String(ops._id),
        directManagerId,
        ...extra,
      });
    expect(r.status).toBe(201);
    return {
      employeeId: r.body._id as string,
      userId: r.body.userId as string,
      token: await activateAccount(email, r.body.temporaryPassword),
    };
  };
  const mgr = await mk('mgr@eayni.local', 'خالد', { positionId: String(pos._id) });
  const a = await mk('a@eayni.local', 'أحمد', { nationality: 'مصري', employmentType: 'part_time' }, mgr.employeeId);
  const b = await mk('b@eayni.local', 'بدر', { gosiJoinDate: '2025-01-15' }, mgr.employeeId);
  return { hr, ops, pos, mgr, a, b };
}

const leave = (token: string, from: string, to: string) =>
  request(app())
    .post('/api/v1/hr/requests')
    .set(auth(token))
    .send({ type: 'leave', details: { leaveType: 'annual', startDate: from, endDate: to, reason: 'إجازة سنوية' } });
const act = (token: string, id: string, transition: string, extra: Record<string, unknown> = {}) =>
  request(app()).post(`/api/v1/hr/requests/${id}/transition`).set(auth(token)).send({ transition, ...extra });

describe('H1 — audit gaps of phase 1 [HR §8 المرحلة الأولى]', () => {
  it('§5 رابعاً: the dashboard counts new / pending / approved / rejected / needs-completion requests for a period, and each card drills down', async () => {
    const { hr, mgr, a, b } = await setup();
    const r1 = await leave(a.token, '2026-12-01', '2026-12-03'); // approved end to end
    const r2 = await leave(a.token, '2026-12-10', '2026-12-11'); // rejected by the manager
    const r3 = await leave(b.token, '2026-12-20', '2026-12-21'); // returned by HR
    const r4 = await leave(b.token, '2026-12-25', '2026-12-26'); // still waiting for the manager
    await act(mgr.token, r1.body._id, 'approve');
    await act(hr, r1.body._id, 'approve');
    await act(mgr.token, r2.body._id, 'reject', { reason: 'ضغط العمل' });
    await act(mgr.token, r3.body._id, 'approve');
    await act(hr, r3.body._id, 'return', { reason: 'أرفق المستند' });

    const dash = await request(app()).get('/api/v1/hr/dashboard/hr').set(auth(hr));
    expect(dash.status).toBe(200);
    expect(dash.body.requestsByState).toMatchObject({ new: 4, pending: 1, approved: 1, rejected: 1, needsCompletion: 1 });
    expect(dash.body.requestsByState.period.from.endsWith('-01')).toBe(true);
    // Another period: nothing was submitted or decided then.
    const old = await request(app()).get('/api/v1/hr/dashboard/hr?from=2020-01-01&to=2020-01-31').set(auth(hr));
    expect(old.body.requestsByState).toMatchObject({ new: 0, approved: 0, rejected: 0, pending: 1, needsCompletion: 1 });
    expect(old.body.requestsByState.period).toEqual({ from: '2020-01-01', to: '2020-01-31' });
    // «حسب الجنسية ونوع التوظيف» [HR §5 أولاً] and «المستندات التي تحتاج إلى تحديث» [HR §5 ثالثاً]
    expect(dash.body.headcount.byEmploymentType).toEqual(
      expect.arrayContaining([{ key: 'part_time', count: 1 }, { key: 'full_time', count: 2 }]),
    );
    expect(dash.body.expiring.needsUpdate).toBe(0);

    // Drill-downs: the list accepts the same filters.
    const list = (q: string) => request(app()).get(`/api/v1/hr/requests?view=all&${q}`).set(auth(hr));
    const numbers = (res: request.Response) => res.body.items.map((i: { number: string }) => i.number).sort();
    expect(numbers(await list('outcome=approved'))).toEqual([r1.body.number]);
    expect(numbers(await list('outcome=rejected'))).toEqual([r2.body.number]);
    expect(numbers(await list('pending=true'))).toEqual([r4.body.number]);
    expect(numbers(await list('state=needs_completion'))).toEqual([r3.body.number]);
    expect(numbers(await list(`from=${iso(0)}&to=${iso(0)}`))).toHaveLength(4);
    expect(numbers(await list('from=2020-01-01&to=2020-01-31'))).toHaveLength(0);
    expect((await list('from=bad')).status).toBe(400);
  });

  it('§3.5 المرحلة الرابعة «أرشفة الطلب»: decided requests close automatically after the configured business days, through the workflow, once', async () => {
    const { hr, mgr, a } = await setup();
    const r1 = await leave(a.token, '2026-12-01', '2026-12-03');
    const r2 = await leave(a.token, '2026-12-10', '2026-12-11');
    const r3 = await leave(a.token, '2026-12-20', '2026-12-21');
    await act(mgr.token, r1.body._id, 'approve');
    await act(hr, r1.body._id, 'approve');
    await act(mgr.token, r2.body._id, 'reject', { reason: 'ضغط العمل' });
    await act(mgr.token, r3.body._id, 'approve');
    await act(hr, r3.body._id, 'return', { reason: 'أرفق المستند' });

    await setSetting('hr.requestAutoCloseBusinessDays', 5, SYSTEM_ACTOR);
    // Not yet due: nothing closes.
    expect(await runRequestAutoClose(new Date())).toBe(0);
    // Due: the two decided requests close; the returned one is untouched.
    const later = new Date(Date.now() + 12 * DAY);
    expect(await runRequestAutoClose(later)).toBe(2);
    const closed = await HrRequest.find({ state: 'closed' }).lean();
    expect(closed.map((r) => r.number).sort()).toEqual([r1.body.number, r2.body.number].sort());
    expect(closed.every((r) => r.closedAt && r.pendingWith === null)).toBe(true);
    expect((await HrRequest.findById(r3.body._id).lean())!.state).toBe('needs_completion');
    // The archive step is in the action log and the stage log; the decision outcome is still readable.
    expect(await HrRequestAction.countDocuments({ requestId: r1.body._id, action: 'close', actorRole: 'system' })).toBe(1);
    expect(await StageLog.countDocuments({ recordType: 'hr_request', recordId: String(r1.body._id), toState: 'closed' })).toBe(1);
    expect((await HrRequest.findById(r2.body._id).lean())!.decision?.outcome).toBe('rejected');
    // Idempotent, and the dashboard still counts them as approved / rejected in their period.
    expect(await runRequestAutoClose(later)).toBe(0);
    const dash = await request(app()).get('/api/v1/hr/dashboard/hr').set(auth(hr));
    expect(dash.body.requestsByState).toMatchObject({ approved: 1, rejected: 1 });
    const list = await request(app()).get('/api/v1/hr/requests?view=all&outcome=approved').set(auth(hr));
    expect(list.body.items.map((i: { number: string }) => i.number)).toEqual([r1.body.number]);
  });

  it('§4 step 2 «تحديد الموظفين المستهدفين» and §3.9 expiring-documents export; §4 «الطلبات» export; a plain employee may export none of them', async () => {
    const { hr, mgr, a, b } = await setup();
    await leave(a.token, '2026-12-01', '2026-12-03');
    const resources = await request(app()).get('/api/v1/export/resources').set(auth(hr));
    const codes = resources.body.items.map((r: { resource: string }) => r.resource);
    expect(codes).toEqual(expect.arrayContaining(['employees', 'hr.documents_expiring', 'hr.requests']));
    const employeesRes = resources.body.items.find((r: { resource: string }) => r.resource === 'employees');
    expect(employeesRes.fields.map((f: { labelAr: string }) => f.labelAr)).toEqual(
      expect.arrayContaining(['وجود تأمين طبي', 'نوع الدوام', 'تاريخ الانضمام للتأمينات الاجتماعية', 'موقع العمل']),
    );

    const preview = (body: Record<string, unknown>) =>
      request(app()).post('/api/v1/export').set(auth(hr)).send({ format: 'preview', ...body });
    // Chosen employees only (intersected with scope).
    const chosen = await preview({
      resource: 'employees',
      fields: ['fullNameAr', 'gosiJoinDate'],
      filters: { employeeIds: [a.employeeId, b.employeeId] },
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.rows.map((r: unknown[]) => r[0]).sort()).toEqual(['أحمد الغامدي', 'بدر الغامدي']);
    expect(String(chosen.body.rows.find((r: unknown[]) => r[0] === 'بدر الغامدي')![1]).slice(0, 10)).toBe('2025-01-15');
    const all = await preview({ resource: 'employees', fields: ['fullNameAr'], filters: {} });
    expect(all.body.total).toBe(3);
    // Expiring documents: the three identities expire in 20 days; the kind filter and the employee list apply.
    const exp = await preview({
      resource: 'hr.documents_expiring',
      fields: ['kindAr', 'fullNameAr', 'daysLeft'],
      filters: { within: 30 },
    });
    expect(exp.status).toBe(200);
    expect(exp.body.total).toBe(3);
    expect(exp.body.rows[0][0]).toBe('هوية / إقامة');
    const expOne = await preview({
      resource: 'hr.documents_expiring',
      fields: ['fullNameAr'],
      filters: { within: 30, kind: 'identities', employeeIds: [mgr.employeeId] },
    });
    expect(expOne.body.rows).toEqual([['خالد الغامدي']]);
    expect((await preview({ resource: 'hr.documents_expiring', fields: ['fullNameAr'], filters: { within: 30, kind: 'contracts' } })).body.total).toBe(0);
    // Requests export carries the spec's request fields.
    const reqs = await preview({
      resource: 'hr.requests',
      fields: ['number', 'typeAr', 'employeeName', 'stateAr', 'pendingWithAr'],
      filters: {},
    });
    expect(reqs.status).toBe(200);
    expect(reqs.body.header).toEqual(['رقم الطلب', 'نوع الطلب', 'اسم مقدم الطلب', 'حالة الطلب', 'المسؤول عن الموافقة']);
    expect(reqs.body.rows[0].slice(1)).toEqual(['طلب إجازة', 'أحمد الغامدي', 'بانتظار موافقة المدير', 'المدير المباشر']);
    // A plain employee holds no export grant on any of these.
    const mine = await request(app()).get('/api/v1/export/resources').set(auth(a.token));
    expect(mine.status === 403 || !mine.body.items?.some((r: { resource: string }) => r.resource.startsWith('hr.') || r.resource === 'employees')).toBe(true);
    const forbidden = await request(app())
      .post('/api/v1/export')
      .set(auth(a.token))
      .send({ resource: 'hr.requests', fields: ['number'], format: 'preview' });
    expect(forbidden.status).toBe(403);
  });

  it('§3.6.3 / DECISIONS §21 Q8: the GOSI join date is on the file, editable by HR, visible to the employee, clearable', async () => {
    const { hr, a, b } = await setup();
    const file = await request(app()).get(`/api/v1/hr/employees/${b.employeeId}`).set(auth(hr));
    expect(String(file.body.gosiJoinDate).slice(0, 10)).toBe('2025-01-15');
    const me = await request(app()).get('/api/v1/hr/me').set(auth(b.token));
    expect(String(me.body.gosiJoinDate).slice(0, 10)).toBe('2025-01-15');
    const set = await request(app())
      .patch(`/api/v1/hr/employees/${a.employeeId}`)
      .set(auth(hr))
      .send({ gosiJoinDate: '2024-09-01' });
    expect(set.status).toBe(200);
    expect(String(set.body.gosiJoinDate).slice(0, 10)).toBe('2024-09-01');
    const clear = await request(app())
      .patch(`/api/v1/hr/employees/${a.employeeId}`)
      .set(auth(hr))
      .send({ gosiJoinDate: null });
    expect(clear.status).toBe(200);
    expect(clear.body.gosiJoinDate ?? null).toBeNull();
    // The employee cannot edit it (official data is HR-only).
    expect(
      (await request(app()).patch(`/api/v1/hr/employees/${a.employeeId}`).set(auth(a.token)).send({ gosiJoinDate: '2020-01-01' })).status,
    ).toBe(403);
  });

  it('§9.2 org chart: every employee within the viewer’s scope with position, manager and report counts; the profile shows the job description', async () => {
    const { hr, mgr, a } = await setup();
    const all = await request(app()).get('/api/v1/hr/org-chart').set(auth(hr));
    expect(all.status).toBe(200);
    expect(all.body.scope).toBe('all');
    expect(all.body.employees).toHaveLength(3);
    const m = all.body.employees.find((e: { _id: string }) => e._id === mgr.employeeId);
    expect(m).toMatchObject({ positionTitle: 'سائق', reports: 2 });
    expect(all.body.departments.map((d: { code: string }) => d.code)).toContain('ops');
    // The direct manager (no role) sees himself and his two reports; a report sees only himself.
    const team = await request(app()).get('/api/v1/hr/org-chart').set(auth(mgr.token));
    expect(team.status).toBe(200);
    expect(team.body.employees.map((e: { fullNameAr: string }) => e.fullNameAr).sort()).toEqual(['أحمد الغامدي', 'بدر الغامدي', 'خالد الغامدي']);
    const own = await request(app()).get('/api/v1/hr/org-chart').set(auth(a.token));
    expect(own.body.employees.map((e: { _id: string }) => e._id)).toEqual([a.employeeId]);
    // «الوصف الوظيفي» [HR §3.1.4, §3.3] reaches the portal profile.
    const me = await request(app()).get('/api/v1/hr/me').set(auth(mgr.token));
    expect(me.body.labels.jobDescription).toBe('قيادة شاحنة الجمع وتسليم الحاويات');
  });

  it('§3.7 «إشعار الموظف عند تغيير وضعه الوظيفي»: a status change notifies the employee and the direct manager', async () => {
    const { hr, mgr, a } = await setup();
    const r = await request(app())
      .post(`/api/v1/hr/employees/${a.employeeId}/status`)
      .set(auth(hr))
      .send({ status: 'suspended', effectiveDate: iso(0), reason: 'تحقيق إداري' });
    expect(r.status).toBe(200);
    const toEmployee = await Notification.findOne({ userId: a.userId, type: 'employee.promotion' }).lean();
    expect(toEmployee?.bodyAr).toContain('موقوف');
    expect(toEmployee?.bodyAr).toContain('تحقيق إداري');
    expect(await Notification.countDocuments({ userId: mgr.userId, type: 'employee.promotion' })).toBe(1);
  });

  it('§7.5 drafts: a request form can be saved as a draft, read back and discarded by its owner only', async () => {
    const { a, b } = await setup();
    const save = await request(app())
      .put('/api/v1/drafts')
      .set(auth(a.token))
      .send({ formKey: 'hr_request', data: { type: 'leave', values: { leaveType: 'annual', reason: 'سفر' }, attachments: [] } });
    expect(save.status).toBe(200);
    const mine = await request(app()).get('/api/v1/drafts?formKey=hr_request').set(auth(a.token));
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].data.values.reason).toBe('سفر');
    // Saving again replaces the same draft; another user sees nothing and cannot delete it.
    await request(app()).put('/api/v1/drafts').set(auth(a.token)).send({ formKey: 'hr_request', data: { type: 'leave', values: { reason: 'حج' } } });
    const again = await request(app()).get('/api/v1/drafts?formKey=hr_request').set(auth(a.token));
    expect(again.body.items).toHaveLength(1);
    expect(again.body.items[0].data.values.reason).toBe('حج');
    expect((await request(app()).get('/api/v1/drafts?formKey=hr_request').set(auth(b.token))).body.items).toHaveLength(0);
    await request(app()).delete(`/api/v1/drafts/${save.body._id}`).set(auth(b.token));
    expect((await request(app()).get('/api/v1/drafts?formKey=hr_request').set(auth(a.token))).body.items).toHaveLength(1);
    await request(app()).delete(`/api/v1/drafts/${save.body._id}`).set(auth(a.token));
    expect((await request(app()).get('/api/v1/drafts?formKey=hr_request').set(auth(a.token))).body.items).toHaveLength(0);
  });

  it('§7.2 / §9.14 API document: every HR route is listed with its permission', async () => {
    await setup();
    await makeUser('it-admin@eayni.local', [{ role: 'employee' }, { role: 'system_admin' }]);
    const admin = await loginAs('it-admin@eayni.local');
    const doc = await request(app()).get('/api/v1/openapi.json').set(auth(admin));
    expect(doc.status).toBe(200);
    const routes = collectRoutes(app()).filter((r) => /^\/api\/v1\/(hr|org|export|drafts|documents)(\/|$)/.test(r.path));
    expect(routes.length).toBeGreaterThan(40);
    for (const r of routes) {
      const path = r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      expect(doc.body.paths[path]?.[r.method], `${r.method} ${r.path}`).toBeDefined();
    }
    expect(doc.body.paths['/api/v1/hr/org-chart'].get['x-permission']).toBe('hr.employees:view');
    expect(doc.body.paths['/api/v1/hr/requests'].get.parameters.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(['from', 'to', 'outcome', 'pending']),
    );
    // Nobody may delete a system admin's own grants from a test; just make sure the user exists for the audit.
    expect(await User.countDocuments({ email: 'it-admin@eayni.local' })).toBe(1);
  });
});
