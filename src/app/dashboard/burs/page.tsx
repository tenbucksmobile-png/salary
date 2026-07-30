'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Employee, Hotel } from '@/types/database';
import { sortHotels, MONTH_NAMES } from '@/lib/utils';
import { Receipt } from 'lucide-react';

// BURS = Botswana Unified Revenue Service. Monthly PAYE submission covering
// every taxed employee across these five properties. ILG submits its own
// payroll spreadsheet; the other four share one combined file.
const BURS_HOTEL_CODES = ['ILG', 'CSL', 'NL', 'CFEM', 'PomPom'];
const COMBINED_CODES = ['CSL', 'NL', 'CFEM', 'PomPom'];

export default function BursPage() {
  const sb = createClient();

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: h } = await sb.from('hotels').select('*');
      const hotelList = sortHotels((h ?? []) as Hotel[], { includeBursOnly: true })
        .filter(hh => BURS_HOTEL_CODES.includes(hh.short_code));
      setHotels(hotelList);

      const hotelIds = hotelList.map(hh => hh.id);
      const { data: e } = hotelIds.length
        ? await sb.from('employees').select('*').in('hotel_id', hotelIds).eq('status', 'active')
        : { data: [] };
      setEmployees((e ?? []) as Employee[]);
      setLoading(false);
    })();
  }, []);

  const hotelMap = useMemo(() => new Map(hotels.map(h => [h.id, h])), [hotels]);
  const combinedHotels = hotels.filter(h => COMBINED_CODES.includes(h.short_code));

  // Whichever taxed-employee filtering the real BURS template needs (e.g.
  // salary_records / payroll-upload paye > 0 for the selected month) is
  // deliberately not built yet — no template to build it against. This page
  // starts with what's independently useful right now: making sure every
  // active employee at these five hotels actually has an Omang captured,
  // since BURS submission needs it and Import HR List is the only way in.
  const missingOmang = useMemo(() => {
    return employees
      .filter(e => !e.id_number || !e.id_number.trim())
      .map(e => ({ employee: e, hotel: hotelMap.get(e.hotel_id) }))
      .sort((a, b) => {
        const hc = (a.hotel?.short_code ?? '').localeCompare(b.hotel?.short_code ?? '');
        return hc !== 0 ? hc : a.employee.surname.localeCompare(b.employee.surname);
      });
  }, [employees, hotelMap]);

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Receipt className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold text-foreground">BURS — Botswana PAYE Submission</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Monthly PAYE submission covering every taxed employee across Indaba Lodge Gaborone, Chobe Safari Lodge, Nata Lodge, CFE Management and Pom Pom.
        </p>
      </div>

      <div className="flex items-end gap-4 mb-6 flex-wrap">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Month</label>
          <select
            value={month}
            onChange={e => setMonth(parseInt(e.target.value))}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
          >
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Year</label>
          <select
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
          >
            {[year, year - 1].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 mb-8">
        <div className="bg-white rounded-xl border p-5">
          <h2 className="text-sm font-semibold mb-1">ILG — Own Payroll Spreadsheet</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Indaba Lodge Gaborone is submitted on its own payroll file, separate from the other four properties.
          </p>
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            Upload — awaiting the BURS template before this can be wired up.
          </div>
        </div>
        <div className="bg-white rounded-xl border p-5">
          <h2 className="text-sm font-semibold mb-1">Combined — CSL / NL / CFEM / Pom Pom</h2>
          <p className="text-xs text-muted-foreground mb-4">
            {combinedHotels.map(h => h.short_code).join(' / ')} are submitted together on one shared payroll spreadsheet.
          </p>
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            Upload — awaiting the BURS template before this can be wired up.
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="px-5 py-3 border-b bg-muted/30 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Omang Readiness</h2>
          <span className="text-xs text-muted-foreground">
            {missingOmang.length === 0
              ? 'All active employees have an Omang on file'
              : `${missingOmang.length} employee(s) missing an Omang number`}
          </span>
        </div>
        {missingOmang.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Every active employee across these five hotels has an Omang / National ID on file.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10">
                <th className="text-left px-5 py-2.5 font-medium text-muted-foreground">Hotel</th>
                <th className="text-left px-5 py-2.5 font-medium text-muted-foreground">Emp Code</th>
                <th className="text-left px-5 py-2.5 font-medium text-muted-foreground">Surname</th>
                <th className="text-left px-5 py-2.5 font-medium text-muted-foreground">First Name</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {missingOmang.map(({ employee, hotel }) => (
                <tr key={employee.id}>
                  <td className="px-5 py-2.5 text-muted-foreground">{hotel?.short_code ?? '—'}</td>
                  <td className="px-5 py-2.5 font-mono text-xs text-muted-foreground">{employee.employee_code ?? '—'}</td>
                  <td className="px-5 py-2.5 font-medium">{employee.surname}</td>
                  <td className="px-5 py-2.5">{employee.first_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="px-5 py-3 border-t bg-muted/10 text-xs text-muted-foreground">
          Fill gaps via <strong>Import HR List</strong> — its Omang / National ID column already updates <code>id_number</code> for matched employees.
        </div>
      </div>
    </div>
  );
}
