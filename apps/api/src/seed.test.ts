import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { seed } from './seed';
import { Employee } from './modules/hr/model';
import { HrRequest } from './modules/hr/requests.model';
import { Customer } from './modules/crm/model';
import { Opportunity } from './modules/sales/model';

/**
 * The full seed on an empty database (HR prompt §0 "lessons from Sales"): two Sales seed bugs only showed up on a
 * fresh database, and a failing sample block must fail the seed instead of being logged and skipped. The test
 * database is wiped before every test by `test/setup.ts`, so this is exactly the fresh-install path.
 */
describe('seed on an empty database [HR prompt §0, SAL §17 المرحلة الخامسة]', () => {
  it('creates the whole sample set without swallowing an error, and a second run adds nothing', async () => {
    const r = await seed();
    expect(r.sampleEmployees).toBeGreaterThan(20);
    expect(r.sampleLogins.length).toBeGreaterThan(10);
    const counts = {
      employees: await Employee.countDocuments(),
      requests: await HrRequest.countDocuments(),
      customers: await Customer.countDocuments(),
      opportunities: await Opportunity.countDocuments(),
      collections: (await mongoose.connection.db!.collections()).length,
    };
    expect(counts.employees).toBe(r.sampleEmployees);
    expect(counts.requests).toBeGreaterThan(5);
    // The S5 every-state block (the one that used to be skipped) reaches a customer «غير مهتم».
    expect(await Customer.countDocuments({ status: 'not_interested' })).toBeGreaterThan(0);
    expect(counts.opportunities).toBeGreaterThan(5);

    // Idempotent: a second run against the seeded database keeps every count.
    const again = await seed();
    expect(again.sampleEmployees).toBe(0);
    expect(await Employee.countDocuments()).toBe(counts.employees);
    expect(await HrRequest.countDocuments()).toBe(counts.requests);
    expect(await Customer.countDocuments()).toBe(counts.customers);
    expect(await Opportunity.countDocuments()).toBe(counts.opportunities);
  }, 180_000);
});
