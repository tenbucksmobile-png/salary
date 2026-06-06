'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Hotel, Employee, SalaryRecord } from '@/types/database';
import { fmtZAR } from '@/lib/utils';
import { TrendingUp, CheckCircle } from 'lucide-react';

const GRADE_OPTIONS = ['All Grades', 'ANO', 'Front Line', 'Supervisory', 'Middle Management', 'Management', 'Exec'];

interface ForecastRow {
  employee: Employee;
  hotel: Hotel;
  currentBasic: number;
  newBasic: number;
  increaseAmount: number;
  currentCtc: number;
  newCtc: number;
  pct: number;
}

export default function SalaryReviewPage() {
  const sb = createClient();

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [latestSalary, setLatestSalary] = useState<Map<string, SalaryRecord>>(new Map());

  const [hotelFilter, setHotelFilter] = useState('all');
  const [gradeFilter, setGradeFilter] = useState('All Grades');
  const [pct, setPct] = useState('');
  const [committed, setCommitted] = useState(false);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    async function load() {
      const [{ data: h }, { data: e }, { data: s }] = await Promise.all([
        sb.from('hotels').select('*').order('name'),
        sb.from('employees').select('*').eq('status', 'active'),
        sb.from('salary_records').select('*'),
      ]);
      const hotelList = (h ?? []) as Hotel[];
      const empList   = (e ?? []) as Employee[];
      const salList   = (s ?? []) as SalaryRecord[];

      const salMap = new Map<string, SalaryRecord>();
      for (const sr of salList) {
        const ex = salMap.get(sr.employee_id);
        if (!ex || sr.period_year > ex.period_year ||
          (sr.period_year === ex.period_year && sr.period_month > ex.period_month)) {
          salMap.set(sr.employee_id, sr);
        }
      }

      setHotels(hotelList);
      setEmployees(empList);
      setLatestSalary(salMap);
    }
    load();
  }, []);

  const hotelMap = useMemo(() => new Map(hotels.map(h => [h.id, h])), [hotels]);

  const forecastRows = useMemo((): ForecastRow[] => {
    const increase = parseFloat(pct) / 100;
    if (isNaN(increase) || increase <= 0) return [];

    return employees
      .filter(e => hotelFilter === 'all' || e.hotel_id === hotelFilter)
      .filter(e => gradeFilter === 'All Grades' || e.grade_label === gradeFilter)
      .map(e => {
        const sal = latestSalary.get(e.id);
        const currentBasic = sal?.basic_salary ?? 0;
        const currentCtc   = sal?.ctc ?? 0;
        const newBasic     = Math.round(currentBasic * (1 + increase));
        const ctcRatio     = currentBasic > 0 ? currentCtc / currentBasic : 1;
        const newCtc       = Math.round(newBasic * ctcRatio);

        return {
          employee: e,
          hotel: hotelMap.get(e.hotel_id)!,
          currentBasic,
          newBasic,
          increaseAmount: newBasic - currentBasic,
          currentCtc,
          newCtc,
          pct: increase,
        };
      })
      .filter(r => r.currentBasic > 0);
  }, [employees, hotelFilter, gradeFilter, pct, latestSalary, hotelMap]);

  const totals = useMemo(() => ({
    currentBasic:    forecastRows.reduce((s, r) => s + r.currentBasic, 0),
    newBasic:        forecastRows.reduce((s, r) => s + r.newBasic, 0),
    increaseAmount:  forecastRows.reduce((s, r) => s + r.increaseAmount, 0),
    currentCtc:      forecastRows.reduce((s, r) => s + r.currentCtc, 0),
    newCtc:          forecastRows.reduce((s, r) => s + r.newCtc, 0),
    count:           forecastRows.length,
  }), [forecastRows]);

  // Group by hotel for sub-totals
  const byHotel = useMemo(() => {
    const map = new Map<string, ForecastRow[]>();
    for (const r of forecastRows) {
      const hid = r.employee.hotel_id;
      if (!map.has(hid)) map.set(hid, []);
      map.get(hid)!.push(r);
    }
    return map;
  }, [forecastRows]);

  async function commitIncrease() {
    setCommitting(true);
    const now = new Date();

    const { data: scenario } = await sb.from('increase_scenarios').insert({
      name: `${pct}% increase — ${gradeFilter !== 'All Grades' ? gradeFilter + ' · ' : ''}${hotelFilter === 'all' ? 'All Hotels' : hotels.find(h => h.id === hotelFilter)?.name}`,
      effective_date: now.toISOString().split('T')[0],
      status: 'committed',
      committed_at: now.toISOString(),
    }).select().single();

    const scenarioId = (scenario as any)?.id;
    if (scenarioId) {
      await sb.from('scenario_lines').insert(
        forecastRows.map(r => ({
          scenario_id:     scenarioId,
          employee_id:     r.employee.id,
          hotel_id:        r.employee.hotel_id,
          increase_pct:    r.pct,
          current_basic:   r.currentBasic,
          new_basic:       r.newBasic,
          increase_amount: r.increaseAmount,
          current_ctc:     r.currentCtc,
          new_ctc:         r.newCtc,
        }))
      );

      // Update salary records with new basic
      for (const r of forecastRows) {
        const sal = latestSalary.get(r.employee.id);
        if (!sal) continue;
        const ctcDelta = r.newCtc - r.currentCtc;
        await sb.from('salary_records').upsert({
          employee_id:          r.employee.id,
          import_id:            null,
          period_month:         now.getMonth() + 1,
          period_year:          now.getFullYear(),
          basic_salary:         r.newBasic,
          allowances:           sal.allowances,
          total_earnings:       sal.total_earnings + (r.newBasic - r.currentBasic),
          tax_paye:             sal.tax_paye,
          uif_employee:         sal.uif_employee,
          medical_employee:     sal.medical_employee,
          ancilla_employee:     sal.ancilla_employee,
          provident_employee:   sal.provident_employee,
          total_deductions:     sal.total_deductions,
          uif_company:          sal.uif_company,
          medical_company:      sal.medical_company,
          provident_company:    sal.provident_company,
          sdl_company:          sal.sdl_company,
          ancilla_company:      sal.ancilla_company,
          total_company_contrib: sal.total_company_contrib + ctcDelta,
          net_salary:           sal.net_salary + (r.newBasic - r.currentBasic),
          ctc:                  r.newCtc,
        }, { onConflict: 'employee_id,period_year,period_month' });
      }
    }

    setCommitting(false);
    setCommitted(true);
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Salary Review</h1>
        <p className="text-muted-foreground text-sm mt-1">Model an increase across any selection of employees and commit when ready</p>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-xl border p-5 mb-6">
        <div className="flex gap-4 items-end flex-wrap">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Hotel</label>
            <select
              value={hotelFilter}
              onChange={e => { setHotelFilter(e.target.value); setCommitted(false); }}
              className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white min-w-[180px]"
            >
              <option value="all">All Hotels</option>
              {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Grade</label>
            <select
              value={gradeFilter}
              onChange={e => { setGradeFilter(e.target.value); setCommitted(false); }}
              className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
            >
              {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Increase %</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={pct}
                onChange={e => { setPct(e.target.value); setCommitted(false); }}
                placeholder="e.g. 6"
                className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-28 pr-7"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Impact summary */}
      {forecastRows.length > 0 && (
        <>
          <div className="grid grid-cols-5 gap-4 mb-6">
            <ImpactCard label="Employees" value={totals.count.toString()} />
            <ImpactCard label="Current Basic / mo" value={fmtZAR(totals.currentBasic)} />
            <ImpactCard label="New Basic / mo" value={fmtZAR(totals.newBasic)} highlight />
            <ImpactCard label="Monthly Increase Cost" value={fmtZAR(totals.increaseAmount)} highlight />
            <ImpactCard label="Annual Increase Cost" value={fmtZAR(totals.increaseAmount * 12)} highlight />
          </div>

          {/* Per-hotel breakdown when all hotels selected */}
          {hotelFilter === 'all' && byHotel.size > 1 && (
            <div className="bg-white rounded-xl border p-5 mb-6">
              <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground mb-4">By Hotel</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium text-muted-foreground">Hotel</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Employees</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Current Basic</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">New Basic</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Monthly Cost</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Annual Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byHotel.entries()].map(([hid, rows]) => {
                    const h = hotelMap.get(hid);
                    const cur = rows.reduce((s, r) => s + r.currentBasic, 0);
                    const nw  = rows.reduce((s, r) => s + r.newBasic, 0);
                    return (
                      <tr key={hid} className="border-b last:border-0">
                        <td className="py-2 font-medium">{h?.name}</td>
                        <td className="py-2 text-right">{rows.length}</td>
                        <td className="py-2 text-right font-mono">{fmtZAR(cur)}</td>
                        <td className="py-2 text-right font-mono">{fmtZAR(nw)}</td>
                        <td className="py-2 text-right font-mono text-amber-700">{fmtZAR(nw - cur)}</td>
                        <td className="py-2 text-right font-mono text-amber-700">{fmtZAR((nw - cur) * 12)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Line-by-line table */}
          <div className="bg-white rounded-xl border overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Employee</th>
                  {hotelFilter === 'all' && <th className="text-left px-4 py-3 font-medium text-muted-foreground">Hotel</th>}
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Grade</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current Basic</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">+ Amount</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">New Basic</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current CTC</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">New CTC</th>
                </tr>
              </thead>
              <tbody>
                {forecastRows.map((r, i) => (
                  <tr key={r.employee.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                    <td className="px-4 py-2.5 font-medium">{r.employee.surname}, {r.employee.first_name}</td>
                    {hotelFilter === 'all' && <td className="px-4 py-2.5 text-muted-foreground">{r.hotel?.short_code}</td>}
                    <td className="px-4 py-2.5 text-muted-foreground">{r.employee.grade_label ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtZAR(r.currentBasic)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-green-700">+{fmtZAR(r.increaseAmount)}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold">{fmtZAR(r.newBasic)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmtZAR(r.currentCtc)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtZAR(r.newCtc)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/20 font-semibold">
                  <td className="px-4 py-3" colSpan={hotelFilter === 'all' ? 3 : 2}>Totals ({totals.count} employees)</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtZAR(totals.currentBasic)}</td>
                  <td className="px-4 py-3 text-right font-mono text-green-700">+{fmtZAR(totals.increaseAmount)}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtZAR(totals.newBasic)}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtZAR(totals.currentCtc)}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtZAR(totals.newCtc)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {!committed ? (
            <button
              onClick={commitIncrease}
              disabled={committing}
              className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-5 py-2.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <TrendingUp className="h-4 w-4" />
              {committing ? 'Committing…' : `Commit ${pct}% Increase to ${totals.count} Employees`}
            </button>
          ) : (
            <div className="flex items-center gap-2 text-green-700 font-medium text-sm">
              <CheckCircle className="h-5 w-5" />
              Increase committed and salary records updated.
            </div>
          )}
        </>
      )}

      {forecastRows.length === 0 && pct && (
        <div className="text-muted-foreground text-sm">
          No employees match the selected filters, or no salary data has been imported yet.
        </div>
      )}

      {!pct && (
        <div className="text-muted-foreground text-sm">
          Enter an increase percentage above to see the forecast.
        </div>
      )}
    </div>
  );
}

function ImpactCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${highlight ? 'bg-amber-50 border-amber-200' : 'bg-white'}`}>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-lg font-bold ${highlight ? 'text-amber-800' : ''}`}>{value}</p>
    </div>
  );
}
