'use client';

import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Hotel, Employee, SalaryRecord, ScenarioLine } from '@/types/database';
import { fmtZAR, fmtCurrency, sortHotels } from '@/lib/utils';
import { Plus, Minus, ChevronDown } from 'lucide-react';

const GRADE_OPTIONS = [
  'ANO', 'Fixed Term', 'DNQ', 'Frontline', 'Supervisory', 'Management', 'Executive', 'Flexible',
];
const GRADE_ORDER = [...GRADE_OPTIONS, 'Unclassified'];

interface EmployeeFigures {
  currentGross: number;
  increaseAdj:  number;
  newGross:     number;
  currentCtc:   number;
  newCtc:       number;
}

// Same before/after logic as the per-hotel rollup, applied to a single
// employee — scenario_lines stores basic-only before/after, so the structure
// allowance (unaffected by the increase) is added back for true gross.
function computeEmployeeFigures(
  emp: Employee,
  latestSalary: Map<string, SalaryRecord>,
  slMap: Map<string, ScenarioLine>,
): EmployeeFigures | null {
  const sal = latestSalary.get(emp.id);
  if (!sal) return null;
  const sl = slMap.get(emp.id);
  if (sl) {
    const structure = sal.allowances?.structure ?? 0;
    return {
      currentGross: sl.current_basic + structure,
      increaseAdj:  sl.increase_amount,
      newGross:     sl.new_basic + structure,
      currentCtc:   sl.current_ctc,
      newCtc:       sl.new_ctc,
    };
  }
  return {
    currentGross: sal.total_earnings,
    increaseAdj:  0,
    newGross:     sal.total_earnings,
    currentCtc:   sal.ctc,
    newCtc:       sal.ctc,
  };
}

interface GradeGroup {
  grade: string;
  headcount: number;
  currentGross: number;
  increaseAdj: number;
  newGross: number;
  currentCtc: number;
  newCtc: number;
  members: { employee: Employee; figures: EmployeeFigures }[];
}

interface RowData {
  hotel: Hotel;
  headcount: number;
  currentGross: number;
  increaseAdj: number;
  newGross: number;
  currentCtc: number;
  newCtc: number;
  gradeGroups: GradeGroup[];
}

export default function SalarySummaryTable() {
  const sb = createClient();

  const [hotels,       setHotels]       = useState<Hotel[]>([]);
  const [employees,    setEmployees]     = useState<Employee[]>([]);
  const [latestSalary, setLatestSalary]  = useState<Map<string, SalaryRecord>>(new Map());
  const [slMap,        setSlMap]         = useState<Map<string, ScenarioLine>>(new Map());
  const [scenarioName, setScenarioName]  = useState<string | null>(null);
  const [loading,      setLoading]       = useState(true);

  // Filter state
  const [selectedHotels, setSelectedHotels] = useState<Set<string>>(new Set()); // empty = all
  const [selectedGrades, setSelectedGrades] = useState<Set<string>>(new Set()); // empty = all
  const [hotelDropdownOpen, setHotelDropdownOpen] = useState(false);
  const [gradeDropdownOpen, setGradeDropdownOpen] = useState(false);
  const hotelDropdownRef = useRef<HTMLDivElement>(null);
  const gradeDropdownRef = useRef<HTMLDivElement>(null);

  // Two-level expand/collapse: hotel → grade subtotal rows → individual employees
  const [expandedHotels, setExpandedHotels] = useState<Set<string>>(new Set());
  const [expandedGrades, setExpandedGrades] = useState<Set<string>>(new Set()); // key = `${hotelId}::${grade}`

  function toggleExpandHotel(hotelId: string) {
    setExpandedHotels(prev => {
      const next = new Set(prev);
      next.has(hotelId) ? next.delete(hotelId) : next.add(hotelId);
      return next;
    });
  }

  function toggleExpandGrade(key: string) {
    setExpandedGrades(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (hotelDropdownRef.current && !hotelDropdownRef.current.contains(e.target as Node)) {
        setHotelDropdownOpen(false);
      }
      if (gradeDropdownRef.current && !gradeDropdownRef.current.contains(e.target as Node)) {
        setGradeDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    async function load() {
      const [{ data: h }, { data: e }, { data: s }, meRes] = await Promise.all([
        sb.from('hotels').select('*'),
        sb.from('employees').select('*').eq('status', 'active'),
        sb.from('salary_records').select('*'),
        fetch('/api/auth/me').then(r => r.ok ? r.json() : null),
      ]);
      const me = meRes as { role: string; hotelIds: string[] | null } | null;

      let hotelList = sortHotels((h ?? []) as Hotel[]);
      let empList   = (e ?? []) as Employee[];
      // Sub users restricted to specific hotels — filter both, not just the
      // hotel checkbox list, since "All Hotels" (empty selection) elsewhere
      // means "show everyone" and must never include a non-permitted hotel.
      if (me?.role === 'sub' && me.hotelIds?.length) {
        hotelList = hotelList.filter(h => me.hotelIds!.includes(h.id));
        empList   = empList.filter(e => me.hotelIds!.includes(e.hotel_id));
      }
      const salList   = (s ?? []) as SalaryRecord[];

      const salMap = new Map<string, SalaryRecord>();
      for (const sr of salList) {
        const ex = salMap.get(sr.employee_id);
        if (!ex || sr.period_year > ex.period_year ||
          (sr.period_year === ex.period_year && sr.period_month > ex.period_month)) {
          salMap.set(sr.employee_id, sr);
        }
      }

      // Load all draft scenarios (one per hotel) — these take priority for display.
      // hotel_id must be set: legacy pre-per-hotel-draft scenarios (from before
      // migration 012) can have hotel_id/settings_json null and would otherwise
      // silently contaminate every hotel's employee → scenario_line mapping.
      const { data: draftScenarios } = await sb
        .from('increase_scenarios')
        .select('id, hotel_id')
        .eq('status', 'draft')
        .not('hotel_id', 'is', null);

      let scenarioLineMap = new Map<string, ScenarioLine>();
      let displayName: string | null = null;

      if ((draftScenarios ?? []).length > 0) {
        const ids = draftScenarios!.map(s => s.id);
        const { data: draftLines } = await sb
          .from('scenario_lines')
          .select('*')
          .in('scenario_id', ids);
        scenarioLineMap = new Map((draftLines ?? []).map(l => [l.employee_id, l as ScenarioLine]));
        const count = draftScenarios!.length;
        displayName = `Draft increases — ${count} hotel${count !== 1 ? 's' : ''} pending commit`;
      } else {
        // Fallback: most recent committed scenario
        const { data: latestScenario } = await sb
          .from('increase_scenarios')
          .select('id, name, status')
          .in('status', ['approved', 'applied', 'committed'])
          .order('committed_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestScenario) {
          displayName = latestScenario.name;
          const { data: lines } = await sb
            .from('scenario_lines')
            .select('*')
            .eq('scenario_id', latestScenario.id);
          scenarioLineMap = new Map((lines ?? []).map(l => [l.employee_id, l as ScenarioLine]));
        }
      }

      setScenarioName(displayName);

      setHotels(hotelList);
      setEmployees(empList);
      setLatestSalary(salMap);
      setSlMap(scenarioLineMap);
      setLoading(false);
    }
    load();
  }, []);

  // Employees passing all filters
  const filteredEmps = useMemo(() =>
    employees.filter(e => {
      if (selectedHotels.size > 0 && !selectedHotels.has(e.hotel_id)) return false;
      if (selectedGrades.size > 0 && !selectedGrades.has(e.grade_label ?? '')) return false;
      return true;
    }),
    [employees, selectedHotels, selectedGrades],
  );

  // One row per hotel (only hotels with matching employees)
  const rows = useMemo((): RowData[] =>
    hotels
      .filter(h => selectedHotels.size === 0 || selectedHotels.has(h.id))
      .map(hotel => {
        const emps = filteredEmps.filter(e => e.hotel_id === hotel.id);
        const groupMap = new Map<string, GradeGroup>();
        let headcount = 0, currentGross = 0, increaseAdj = 0,
            newGross = 0, currentCtc = 0, newCtc = 0;

        for (const emp of emps) {
          const figures = computeEmployeeFigures(emp, latestSalary, slMap);
          if (!figures) continue;

          const grade = emp.grade_label ?? 'Unclassified';
          let group = groupMap.get(grade);
          if (!group) {
            group = { grade, headcount: 0, currentGross: 0, increaseAdj: 0, newGross: 0, currentCtc: 0, newCtc: 0, members: [] };
            groupMap.set(grade, group);
          }
          // Dashboard HC is the total headcount per grade/hotel, irrespective
          // of whether a salary adjustment applies to any given employee —
          // unlike Salary Review's "effected" count, this is not filtered.
          group.headcount++;
          group.currentGross += figures.currentGross;
          group.increaseAdj  += figures.increaseAdj;
          group.newGross     += figures.newGross;
          group.currentCtc   += figures.currentCtc;
          group.newCtc       += figures.newCtc;
          group.members.push({ employee: emp, figures });

          headcount++;
          currentGross += figures.currentGross;
          increaseAdj  += figures.increaseAdj;
          newGross     += figures.newGross;
          currentCtc   += figures.currentCtc;
          newCtc       += figures.newCtc;
        }
        if (headcount === 0) return null;

        const gradeGroups = [...groupMap.values()].sort((a, b) => {
          const ai = GRADE_ORDER.indexOf(a.grade), bi = GRADE_ORDER.indexOf(b.grade);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
        for (const g of gradeGroups) {
          g.members.sort((a, b) =>
            a.employee.surname.localeCompare(b.employee.surname) ||
            a.employee.first_name.localeCompare(b.employee.first_name));
        }

        return { hotel, headcount, currentGross, increaseAdj, newGross, currentCtc, newCtc, gradeGroups };
      })
      .filter((r): r is RowData => r !== null),
    [hotels, filteredEmps, latestSalary, slMap, selectedHotels],
  );

  const totals = useMemo(() => ({
    headcount:    rows.reduce((s, r) => s + r.headcount,    0),
    currentGross: rows.reduce((s, r) => s + r.currentGross, 0),
    increaseAdj:  rows.reduce((s, r) => s + r.increaseAdj,  0),
    newGross:     rows.reduce((s, r) => s + r.newGross,      0),
    currentCtc:   rows.reduce((s, r) => s + r.currentCtc,   0),
    newCtc:       rows.reduce((s, r) => s + r.newCtc,        0),
  }), [rows]);

  function pct(inc: number, base: number) {
    return base > 0 && inc > 0 ? `${(inc / base * 100).toFixed(1)}%` : '—';
  }

  if (loading) {
    return (
      <div className="mt-10 text-sm text-muted-foreground">Loading summary…</div>
    );
  }

  return (
    <div className="mt-10">
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Salary Review Summary
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {scenarioName
            ? `Scenario: ${scenarioName}`
            : 'No salary review scenario — showing current salaries only'}
        </p>
      </div>

      {/* ── Filters ── */}
      <div className="bg-white rounded-xl border p-5 mb-4 flex flex-wrap gap-4">
        {/* Hotels — dropdown checkbox list */}
        <div className="relative" ref={hotelDropdownRef}>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Hotel</label>
          <button
            type="button"
            onClick={() => setHotelDropdownOpen(v => !v)}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white flex items-center gap-2 min-w-[200px] justify-between"
          >
            <span>{selectedHotels.size === 0 ? 'All Hotels' : `${selectedHotels.size} hotel${selectedHotels.size > 1 ? 's' : ''} selected`}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          </button>
          {hotelDropdownOpen && (
            <div className="absolute z-20 mt-1 bg-white border rounded-lg shadow-lg py-1.5 min-w-[220px]">
              <label className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted/30 cursor-pointer text-sm font-medium">
                <input
                  type="checkbox"
                  checked={selectedHotels.size === 0}
                  onChange={() => setSelectedHotels(new Set())}
                  className="rounded accent-primary"
                />
                All Hotels
              </label>
              <div className="border-t my-1" />
              {hotels.map(h => (
                <label key={h.id} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted/30 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={selectedHotels.has(h.id)}
                    onChange={() => setSelectedHotels(prev => {
                      const n = new Set(prev);
                      n.has(h.id) ? n.delete(h.id) : n.add(h.id);
                      return n;
                    })}
                    className="rounded accent-primary"
                  />
                  <span>{h.name}</span>
                  <span className="text-xs text-muted-foreground">{h.short_code}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Grades — dropdown checkbox list */}
        <div className="relative" ref={gradeDropdownRef}>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Grade</label>
          <button
            type="button"
            onClick={() => setGradeDropdownOpen(v => !v)}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white flex items-center gap-2 min-w-[180px] justify-between"
          >
            <span>{selectedGrades.size === 0 ? 'All Grades' : `${selectedGrades.size} grade${selectedGrades.size > 1 ? 's' : ''} selected`}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          </button>
          {gradeDropdownOpen && (
            <div className="absolute z-20 mt-1 bg-white border rounded-lg shadow-lg py-1.5 min-w-[180px]">
              <label className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted/30 cursor-pointer text-sm font-medium">
                <input
                  type="checkbox"
                  checked={selectedGrades.size === 0}
                  onChange={() => setSelectedGrades(new Set())}
                  className="rounded accent-primary"
                />
                All Grades
              </label>
              <div className="border-t my-1" />
              {GRADE_OPTIONS.map(g => (
                <label key={g} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted/30 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={selectedGrades.has(g)}
                    onChange={() => setSelectedGrades(prev => {
                      const n = new Set(prev);
                      n.has(g) ? n.delete(g) : n.add(g);
                      return n;
                    })}
                    className="rounded accent-primary"
                  />
                  <span>{g}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border p-10 text-center text-sm text-muted-foreground">
          No employees match the selected filters.
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Hotel</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">HC</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current Gross</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current CTC</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Increase + Adj</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">New Gross</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">New CTC</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Annualised CTC</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const hotelExpanded = expandedHotels.has(r.hotel.id);
                return (
                  <Fragment key={r.hotel.id}>
                    <tr className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                      <td className="px-4 py-2.5 font-medium">
                        <button
                          onClick={() => toggleExpandHotel(r.hotel.id)}
                          className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded border border-input text-muted-foreground align-middle hover:bg-muted transition-colors"
                          title={hotelExpanded ? 'Hide grade breakdown' : 'Show grade breakdown'}
                        >
                          {hotelExpanded ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                        </button>
                        {r.hotel.name}
                        <span className="ml-1.5 text-xs text-muted-foreground font-normal">{r.hotel.short_code}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.headcount}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCurrency(r.currentGross, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCurrency(r.currentCtc, r.hotel.country)}</td>
                      <td className={`px-4 py-2.5 text-right font-mono ${r.increaseAdj > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>
                        {r.increaseAdj > 0 ? `+${fmtCurrency(r.increaseAdj, r.hotel.country)}` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold">{fmtCurrency(r.newGross, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold">{fmtCurrency(r.newCtc, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmtCurrency(r.newCtc * 12, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {pct(r.increaseAdj, r.currentGross)}
                      </td>
                    </tr>
                    {hotelExpanded && r.gradeGroups.map(g => {
                      const gradeKey = `${r.hotel.id}::${g.grade}`;
                      const gradeExpanded = expandedGrades.has(gradeKey);
                      return (
                        <Fragment key={gradeKey}>
                          <tr className="border-b last:border-0 bg-muted/10 text-xs">
                            <td className="px-4 py-2 pl-9 text-left font-medium">
                              <button
                                onClick={() => toggleExpandGrade(gradeKey)}
                                className="mr-2 inline-flex h-4 w-4 items-center justify-center rounded border border-input text-muted-foreground align-middle hover:bg-muted transition-colors"
                                title={gradeExpanded ? 'Hide individual employees' : 'Show individual employees'}
                              >
                                {gradeExpanded ? <Minus className="h-2.5 w-2.5" /> : <Plus className="h-2.5 w-2.5" />}
                              </button>
                              {g.grade}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{g.headcount}</td>
                            <td className="px-4 py-2 text-right font-mono">{fmtCurrency(g.currentGross, r.hotel.country)}</td>
                            <td className="px-4 py-2 text-right font-mono">{fmtCurrency(g.currentCtc, r.hotel.country)}</td>
                            <td className={`px-4 py-2 text-right font-mono ${g.increaseAdj > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>
                              {g.increaseAdj > 0 ? `+${fmtCurrency(g.increaseAdj, r.hotel.country)}` : '—'}
                            </td>
                            <td className="px-4 py-2 text-right font-mono font-semibold">{fmtCurrency(g.newGross, r.hotel.country)}</td>
                            <td className="px-4 py-2 text-right font-mono font-semibold">{fmtCurrency(g.newCtc, r.hotel.country)}</td>
                            <td className="px-4 py-2 text-right font-mono text-muted-foreground">{fmtCurrency(g.newCtc * 12, r.hotel.country)}</td>
                            <td className="px-4 py-2 text-right font-mono">{pct(g.increaseAdj, g.currentGross)}</td>
                          </tr>
                          {gradeExpanded && g.members.map(m => (
                            <tr key={m.employee.id} className="border-b last:border-0 bg-muted/5 text-xs">
                              <td className="px-4 py-2 pl-16 text-left text-muted-foreground">
                                {m.employee.surname}, {m.employee.first_name}
                              </td>
                              <td className="px-4 py-2 text-left text-muted-foreground">{m.employee.grade_label ?? 'Unclassified'}</td>
                              <td className="px-4 py-2 text-right font-mono">{fmtCurrency(m.figures.currentGross, r.hotel.country)}</td>
                              <td className="px-4 py-2 text-right font-mono">{fmtCurrency(m.figures.currentCtc, r.hotel.country)}</td>
                              <td className={`px-4 py-2 text-right font-mono ${m.figures.increaseAdj > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>
                                {m.figures.increaseAdj > 0 ? `+${fmtCurrency(m.figures.increaseAdj, r.hotel.country)}` : '—'}
                              </td>
                              <td className="px-4 py-2 text-right font-mono">{fmtCurrency(m.figures.newGross, r.hotel.country)}</td>
                              <td className="px-4 py-2 text-right font-mono">{fmtCurrency(m.figures.newCtc, r.hotel.country)}</td>
                              <td className="px-4 py-2 text-right font-mono text-muted-foreground">{fmtCurrency(m.figures.newCtc * 12, r.hotel.country)}</td>
                              <td className="px-4 py-2 text-right font-mono">{pct(m.figures.increaseAdj, m.figures.currentGross)}</td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 bg-muted/20 font-semibold">
                  <td className="px-4 py-3">
                    Grand Total
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      {rows.length > 1 ? `${rows.length} properties` : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{totals.headcount}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtZAR(totals.currentGross)}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtZAR(totals.currentCtc)}</td>
                  <td className={`px-4 py-3 text-right font-mono ${totals.increaseAdj > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>
                    {totals.increaseAdj > 0 ? `+${fmtZAR(totals.increaseAdj)}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{fmtZAR(totals.newGross)}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtZAR(totals.newCtc)}</td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">{fmtZAR(totals.newCtc * 12)}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    {pct(totals.increaseAdj, totals.currentGross)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

