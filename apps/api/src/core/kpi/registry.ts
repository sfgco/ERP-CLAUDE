import type { KpiDirection, KpiUnit } from './service';

/**
 * Registry of KPI definitions (CLAUDE.md "KPI framework", HR_PLAN §3.8): a code every module may point at — an HR goal
 * «يرتبط بمؤشرات أداء القسم» [HR §3.7] names one of these codes and the server validates it. Modules register their own
 * definitions at start; the computation of actuals stays in the owning module.
 */
export interface KpiDefinition {
  code: string;
  nameAr: string;
  unit: KpiUnit | 'percent' | 'hours';
  direction: KpiDirection;
  /** Owning module / department code (sales, hr, …). */
  module: string;
}

const registry = new Map<string, KpiDefinition>();

export function registerKpiDefinitions(defs: KpiDefinition[]): void {
  for (const d of defs) registry.set(d.code, d);
}
export function kpiDefinition(code: string): KpiDefinition | undefined {
  return registry.get(code);
}
export function listKpiDefinitions(module?: string): KpiDefinition[] {
  return [...registry.values()].filter((d) => !module || d.module === module).sort((a, b) => a.code.localeCompare(b.code));
}
