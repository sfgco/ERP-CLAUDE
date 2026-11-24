import { subscribe } from '../../core/outbox/service';
import { recomputeDays } from './attendance.service';

/**
 * HR domain events (CLAUDE.md "Domain events").
 *
 * Published by this module (consumed by other modules through the outbox):
 * - `hr.request.<state>`                     every HR request transition; payload { number, type, from }
 * - `hr.request.handoff.finance`             an approved advance waiting for Finance on the same number [FIN §11]
 * - `hr.attendance.recompute_requested`      an approved correction / exception / remote work / overtime changed the
 *                                            sources of an employee's days; payload { employeeId, days[] } (H2)
 *
 * Consumed here: `hr.attendance.recompute_requested` recomputes the days again from the worker, so a crash between
 * the approval commit and the in-process recompute never leaves a stale day (HR_PLAN §10.2). Events nobody handles
 * are parked as 'unhandled' and replayed when a subscriber registers (review B11b).
 */
export function registerHrSubscribers(): void {
  subscribe(
    'hr.attendance.recompute_requested',
    async (event) => {
      const p = event.payload as { employeeId?: string; days?: string[] };
      if (p.employeeId && p.days?.length) await recomputeDays(p.employeeId, p.days);
    },
    'hr.attendance',
  );
}
