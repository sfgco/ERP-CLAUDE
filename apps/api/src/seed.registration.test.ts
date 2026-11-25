import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { seed } from './seed';
import { kpiDefinition } from './core/kpi/registry';
import { Customer } from './modules/crm/model';
import { Goal } from './modules/hr/performance.model';
import { PayrollRun } from './modules/hr/payroll.model';
import { Employee } from './modules/hr/model';

/**
 * Owner review 2026-11-25: the first seed of `eayni_main` failed with «مؤشر الأداء غير معروف» — the module registration
 * (KPI registry, subscribers) was a side effect of the Sales block and did not happen when that block returned early
 * because customers already existed. This file runs in its own worker, so nothing is registered before `seed()`:
 * a database that already holds a customer must still get the H3a goals, whatever ran before and whatever else is booting.
 */
describe('seed registers the modules itself — never through a sample block that may be skipped', () => {
  it('a database that already has customers (Sales block skipped) still seeds the H3a goals linked to KPI codes', async () => {
    expect(kpiDefinition('hr.attendance_rate')).toBeUndefined(); // fresh worker: nothing registered yet
    await Customer.collection.insertOne({
      number: 'CUS-TEST-00001',
      kind: 'organization',
      nameAr: 'عميل سابق',
      normalizedName: 'عميل سابق',
      source: 'other',
      status: 'active',
      ownerUserId: new mongoose.Types.ObjectId(),
      departmentId: new mongoose.Types.ObjectId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const r = await seed();
    expect(r.sampleEmployees).toBeGreaterThan(20);
    expect(await Customer.countDocuments()).toBe(1); // the Sales block saw the customer and returned early, as designed
    expect(kpiDefinition('hr.attendance_rate')?.module).toBe('hr'); // registered by seed() itself
    expect(await Employee.countDocuments()).toBe(r.sampleEmployees);
    expect(await PayrollRun.countDocuments()).toBeGreaterThan(0);
    expect(await Goal.countDocuments({ kpiCode: { $exists: true, $ne: null } })).toBeGreaterThan(0); // the goals that used to fail
  }, 180_000);
});
