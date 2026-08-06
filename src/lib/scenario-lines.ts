// Shared Salary Review scenario-line resolution — used anywhere a page needs
// each employee's post-increase New Gross Salary (Provisions Overview export,
// Bonus Provision page, …) without duplicating the draft-vs-committed lookup.

import { createClient } from '@/lib/supabase/client';
import { ScenarioLine, SalaryRecord } from '@/types/database';

// Per-hotel scenario resolution, mirroring SalarySummaryTable's own draft-vs-
// committed priority: a hotel's draft scenario wins if one exists; otherwise
// its own most recent approved/applied/committed scenario. Unlike the
// dashboard's single global fallback, this resolves independently per hotel,
// so a multi-hotel page gets each hotel's own correct scenario rather than
// just whichever hotel happens to have the single most recent commit.
export async function fetchScenarioLineMap(sb: ReturnType<typeof createClient>, hotelIds: string[]): Promise<Map<string, ScenarioLine>> {
  if (hotelIds.length === 0) return new Map();

  const { data: draftScenarios } = await sb
    .from('increase_scenarios')
    .select('id, hotel_id')
    .eq('status', 'draft')
    .not('hotel_id', 'is', null)
    .in('hotel_id', hotelIds);

  const draftHotelIds = new Set((draftScenarios ?? []).map((s: { hotel_id: string }) => s.hotel_id));
  const scenarioIds: string[] = (draftScenarios ?? []).map((s: { id: string }) => s.id);

  const missingHotelIds = hotelIds.filter(id => !draftHotelIds.has(id));
  if (missingHotelIds.length > 0) {
    const { data: committed } = await sb
      .from('increase_scenarios')
      .select('id, hotel_id, committed_at')
      .in('hotel_id', missingHotelIds)
      .in('status', ['approved', 'applied', 'committed'])
      .order('committed_at', { ascending: false });
    const seen = new Set<string>();
    for (const s of (committed ?? []) as { id: string; hotel_id: string }[]) {
      if (seen.has(s.hotel_id)) continue;
      seen.add(s.hotel_id);
      scenarioIds.push(s.id);
    }
  }

  if (scenarioIds.length === 0) return new Map();
  const { data: lines } = await sb.from('scenario_lines').select('*').in('scenario_id', scenarioIds);
  return new Map(((lines ?? []) as ScenarioLine[]).map(l => [l.employee_id, l]));
}

// Reconstructs true New Gross Salary from a scenario line the same way
// SalarySummaryTable's computeEmployeeFigures() does — scenario_lines stores
// basic-only before/after, so the structure allowance (unaffected by the
// increase) is added back. Falls back to the employee's current Gross Salary
// when they have no scenario line (excluded from the increase, or no
// scenario at all for their hotel).
export function resolveNewGross(
  employeeId: string,
  scenarioLineMap: Map<string, ScenarioLine>,
  salary: SalaryRecord | undefined,
): number {
  const currentGross = salary?.total_earnings ?? 0;
  const sl = scenarioLineMap.get(employeeId);
  if (!sl || !salary) return currentGross;
  const structure = salary.allowances?.structure ?? 0;
  return sl.new_basic + structure;
}
