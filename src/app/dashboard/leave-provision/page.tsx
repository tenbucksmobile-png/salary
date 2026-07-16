'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Employee, Hotel, LeaveProvision, SalaryRecord } from '@/types/database';
import { fmtCurrency, sortHotels } from '@/lib/utils';
import { isBotswana, LEAVE_PROVISION_CAP_DAYS } from '@/lib/payroll-calc';
import { exportReport, type ReportSheet } from '@/lib/reports-export';
import { RefreshCw, Download } from 'lucide-react';

const HOTEL_FILTER_KEY = 'ihg-salary-leave-hotel';
const ALL = 'ALL';

export default function LeaveProvisionPage() {
  const sb = createClient();

  const [hotels, setHotels]     = useState<Hotel[]>([]);
  const [hotelFilter, setHotelFilter] = useState('');
  const [provisions, setProvisions] = useState<LeaveProvision[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function load() {
    const [{ data: h }, meRes] = await Promise.all([
      sb.from('hotels').select('*'),
      fetch('/api/auth/me').then(r => r.ok ? r.json() : null),
    ]);
    const me = meRes as { role: string; hotelIds: string[] | null } | null;
    let hotelList = sortHotels((h ?? []) as Hotel[]);
    if (me?.role === 'sub' && me.hotelIds?.length) {
      hotelList = hotelList.filter(hh => me.hotelIds!.includes(hh.id));
    }
    setHotels(hotelList);
    if (hotelList.length > 0) {
      setHotelFilter(prev => {
        if (prev && (prev === ALL || hotelList.some(hh => hh.id === prev))) return prev;
        try {
          const saved = localStorage.getItem(HOTEL_FILTER_KEY);
          if (saved && (saved === ALL || hotelList.some(hh => hh.id === saved))) return saved;
        } catch {}
        return hotelList[0].id;
      });
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (hotelFilter) {
      try { localStorage.setItem(HOTEL_FILTER_KEY, hotelFilter); } catch {}
    }
  }, [hotelFilter]);

  useEffect(() => {
    if (!hotelFilter || hotels.length === 0) return;
    (async () => {
      const hotelIds = hotelFilter === ALL ? hotels.map(h => h.id) : [hotelFilter];
      const [{ data: p }, { data: e }] = await Promise.all([
        sb.from('leave_provisions').select('*').in('hotel_id', hotelIds),
        sb.from('employees').select('*').in('hotel_id', hotelIds),
      ]);
      setProvisions((p ?? []) as LeaveProvision[]);
      setEmployees((e ?? []) as Employee[]);
    })();
  }, [hotelFilter, hotels]);

  const hotelMap = useMemo(() => new Map(hotels.map(h => [h.id, h])), [hotels]);
  const selectedHotel = hotelFilter !== ALL ? hotels.find(h => h.id === hotelFilter) : undefined;
  const isAll = hotelFilter === ALL;

  const availableYears = useMemo(() => {
    const years = new Set(provisions.map(p => p.period_year));
    years.add(year);
    return [...years].sort((a, b) => b - a);
  }, [provisions, year]);

  const empMap = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);

  const rows = useMemo(() => {
    return provisions
      .filter(p => p.period_year === year)
      .map(p => ({ provision: p, employee: empMap.get(p.employee_id), hotel: hotelMap.get(p.hotel_id) }))
      .filter(r => r.employee)
      .sort((a, b) => {
        const hotelCmp = (a.hotel?.short_code ?? '').localeCompare(b.hotel?.short_code ?? '');
        return hotelCmp !== 0 ? hotelCmp : a.employee!.surname.localeCompare(b.employee!.surname);
      });
  }, [provisions, year, empMap, hotelMap]);

  // Group provision totals by currency — ALL view can mix ZAR (SA) and BWP (Botswana)
  const totalsByCountry = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of rows) {
      const key = r.hotel ? (isBotswana(r.hotel.country) ? 'BWP' : 'ZAR') : 'ZAR';
      totals.set(key, (totals.get(key) ?? 0) + r.provision.provision_value);
    }
    return totals;
  }, [rows]);

  const fmt = (n: number, hotel?: Hotel) => fmtCurrency(n, hotel?.country ?? selectedHotel?.country ?? '');

  async function recalculate() {
    setRecalculating(true);

    const empIds = rows.map(r => r.employee!.id);
    const { data: salData } = empIds.length
      ? await sb.from('salary_records').select('*').in('employee_id', empIds)
      : { data: [] };
    const salList = (salData ?? []) as SalaryRecord[];
    const latestSalary = new Map<string, SalaryRecord>();
    for (const sal of salList) {
      const ex = latestSalary.get(sal.employee_id);
      if (!ex || sal.period_year > ex.period_year || (sal.period_year === ex.period_year && sal.period_month > ex.period_month)) {
        latestSalary.set(sal.employee_id, sal);
      }
    }

    await Promise.all(rows.map(r => {
      const hotel = r.hotel;
      const bw = hotel ? isBotswana(hotel.country) : false;
      const divisor = hotel?.leave_provision_divisor ?? (bw ? 26 : 30.42);
      // Gross salary (total_earnings, inclusive of structure) drives the daily
      // rate — never basic or CTC.
      const gross = latestSalary.get(r.employee!.id)?.total_earnings ?? r.provision.basic_at_calc;
      const cappedDays = Math.min(r.provision.leave_balance_days, LEAVE_PROVISION_CAP_DAYS);
      const dailyRate = Math.round((gross / divisor) * 100) / 100;
      const provisionValue = Math.round(dailyRate * cappedDays * 100) / 100;
      return sb.from('leave_provisions').update({
        basic_at_calc:   gross,
        daily_rate:      dailyRate,
        provision_value: provisionValue,
      }).eq('id', r.provision.id);
    }));

    const hotelIds = isAll ? hotels.map(h => h.id) : [hotelFilter];
    const { data: p } = await sb.from('leave_provisions').select('*').in('hotel_id', hotelIds);
    setProvisions((p ?? []) as LeaveProvision[]);
    setRecalculating(false);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const headers = [
        ...(isAll ? ['Hotel'] : []),
        'Emp Code', 'Surname', 'First Name', 'Grade',
        'Actual Leave Balance', 'Capped Leave Balance', 'Daily Rate', 'Provision Value', 'Imported',
      ];
      const dataRows = rows.map(({ provision, employee, hotel }) => [
        ...(isAll ? [hotel?.short_code ?? '—'] : []),
        employee!.employee_code ?? '—',
        employee!.surname,
        employee!.first_name,
        employee!.grade_label ?? 'Unclassified',
        provision.leave_balance_days,
        Math.min(provision.leave_balance_days, LEAVE_PROVISION_CAP_DAYS),
        provision.daily_rate,
        provision.provision_value,
        new Date(provision.imported_at).toLocaleDateString(),
      ]);
      const totalsRow = [
        ...(isAll ? [''] : []),
        `Total (${rows.length} employees)`, '', '', '', '', '', '',
        [...totalsByCountry.entries()].map(([cur, v]) => `${cur} ${v.toLocaleString('en-ZA', { maximumFractionDigits: 2 })}`).join(' / '),
        '',
      ];
      const sheet: ReportSheet = {
        name: isAll ? 'All Hotels' : (selectedHotel?.short_code ?? 'Leave Provision'),
        headers,
        rows: [...dataRows, totalsRow],
        isTotalsRow: [...dataRows.map(() => false), true],
      };
      const label = isAll ? 'All_Hotels' : (selectedHotel?.short_code ?? 'Leave_Provision');
      await exportReport('Leave Provision', `Leave_Provision_${label}_${year}.xlsx`, [sheet]);
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Leave Provision</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Annual (July) leave balance provisioning — daily rate × leave balance, capped at {LEAVE_PROVISION_CAP_DAYS} days. Standalone from payroll burden; import via Import HR List.
        </p>
      </div>

      <div className="flex items-end gap-4 mb-6 flex-wrap">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Hotel</label>
          <select
            value={hotelFilter}
            onChange={e => setHotelFilter(e.target.value)}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white min-w-[220px]"
          >
            <option value={ALL}>All Hotels</option>
            {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Year</label>
          <select
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
          >
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button
          onClick={recalculate}
          disabled={recalculating || rows.length === 0}
          className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${recalculating ? 'animate-spin' : ''}`} />
          {recalculating ? 'Recalculating…' : 'Recalculate'}
        </button>
        <button
          onClick={handleExport}
          disabled={exporting || rows.length === 0}
          className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exporting…' : 'Export to Excel'}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border p-10 text-center text-sm text-muted-foreground">
          No leave provision data for {isAll ? 'any hotel' : (selectedHotel?.short_code ?? 'this hotel')} in {year}.
          Run the Leave Balance import via Import HR List to populate this.
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/40">
                {isAll && <th className="text-left px-4 py-3 font-medium text-muted-foreground">Hotel</th>}
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Emp Code</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Surname</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">First Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Grade</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actual Leave Balance</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Capped Leave Balance</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Daily Rate</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Provision Value</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Imported</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ provision, employee, hotel }, i) => (
                <tr key={provision.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                  {isAll && <td className="px-4 py-2.5 text-muted-foreground">{hotel?.short_code ?? '—'}</td>}
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{employee!.employee_code ?? '—'}</td>
                  <td className="px-4 py-2.5 font-medium">{employee!.surname}</td>
                  <td className="px-4 py-2.5">{employee!.first_name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{employee!.grade_label ?? 'Unclassified'}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{provision.leave_balance_days}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{Math.min(provision.leave_balance_days, LEAVE_PROVISION_CAP_DAYS)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmt(provision.daily_rate, hotel)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmt(provision.provision_value, hotel)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{new Date(provision.imported_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/20 font-medium">
                <td className="px-4 py-3" colSpan={isAll ? 5 : 4}>Total ({rows.length} employees)</td>
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
                <td className="px-4 py-3 text-right font-mono">
                  {[...totalsByCountry.entries()].map(([cur, v]) => (
                    <div key={cur}>{cur === 'BWP' ? 'P' : 'R'} {v.toLocaleString('en-ZA', { maximumFractionDigits: 2 })}</div>
                  ))}
                </td>
                <td className="px-4 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
