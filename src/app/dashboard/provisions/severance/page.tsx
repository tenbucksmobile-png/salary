'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient, fetchAllRows } from '@/lib/supabase/client';
import { Employee, Hotel, SalaryRecord, SeveranceProvisionBookBalance } from '@/types/database';
import { fmtCurrency, sortHotels } from '@/lib/utils';
import { calculateBurden, isBotswana } from '@/lib/payroll-calc';
import { exportReport, type ReportSheet } from '@/lib/reports-export';
import { RefreshCw, Download, HandCoins } from 'lucide-react';

const HOTEL_FILTER_KEY = 'ihg-salary-severance-hotel';
const ALL = 'ALL';

// Severance/Gratuity provision hotels — ILG (severance only, historically)
// plus CSL/NL/CFEM (where gratuity_applicable employees exist, e.g. CFEM's
// FRE001/FRE002 at a 10% rate). A hotel/employee can have either, both, or
// neither of Severance and Gratuity — the two are independent employee flags.
const SEVERANCE_HOTEL_CODES = ['ILG', 'CSL', 'NL', 'CFEM'];
const SEVERANCE_SENIOR_YEARS = 5; // 60 months — daily rate doubles at this tenure

// One-off override: FRE001/FRE002 (Diane & James French, CFEM) accrue
// gratuity from their LOA start date rather than a straight Gross × Rate%,
// per explicit instruction — every other gratuity_applicable employee keeps
// the straight formula. Not a general employee field (yet); hardcoded here.
const GRATUITY_ACCRUAL_START: Record<string, string> = {
  FRE001: '2024-10-01',
  FRE002: '2024-10-01',
};

// Whole calendar months from the accrual start date to 31 July of the
// selected Year (e.g. 1 Oct 2024 → 31 Jul 2026 = 21 months).
function periodOfAccrualMonths(startDate: string, year: number): number {
  const start = new Date(startDate);
  const end = new Date(year, 6, 31); // 31 July
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

function yearsOfService(date: string | null): number {
  if (!date) return 0;
  const ms = Date.now() - new Date(date).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25) * 10) / 10;
}

// Whole calendar months elapsed from `date` to now.
function monthsOfService(date: string | null): number {
  if (!date) return 0;
  const start = new Date(date);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

// Severance is assumed paid out at every 5-year mark (5, 10, 15…), so the
// provision balance only ever covers months accrued since the most recent
// threshold crossed — not the employee's full tenure. E.g. 12.7 years of
// service (152 months) last crossed the 10-year mark, so only the ~32
// months since then are provisioned for.
function monthsSinceLastPayoutThreshold(date: string | null): number {
  const totalMonths = monthsOfService(date);
  const lastThresholdMonths = Math.floor(totalMonths / 60) * 60;
  return totalMonths - lastThresholdMonths;
}

export default function SeveranceProvisionPage() {
  const sb = createClient();

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [hotelFilter, setHotelFilter] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [salaryRecords, setSalaryRecords] = useState<SalaryRecord[]>([]);
  const [bookBalances, setBookBalances] = useState<SeveranceProvisionBookBalance[]>([]);
  const [bookInputs, setBookInputs] = useState<Map<string, string>>(new Map());
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
    let hotelList = sortHotels((h ?? []) as Hotel[]).filter(hh => SEVERANCE_HOTEL_CODES.includes(hh.short_code));
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
      const [{ data: e }, { data: b }] = await Promise.all([
        sb.from('employees').select('*').in('hotel_id', hotelIds).eq('status', 'active')
          .or('severance_applicable.eq.true,gratuity_applicable.eq.true'),
        sb.from('severance_provision_book_balances').select('*').in('hotel_id', hotelIds),
      ]);
      const empList = (e ?? []) as Employee[];
      const empIds = empList.map(emp => emp.id);
      const s = empIds.length
        ? await fetchAllRows<SalaryRecord>(() => sb.from('salary_records').select('*').in('employee_id', empIds))
        : [];
      setEmployees(empList);
      setSalaryRecords(s);
      setBookBalances((b ?? []) as SeveranceProvisionBookBalance[]);
    })();
  }, [hotelFilter, hotels]);

  const hotelMap = useMemo(() => new Map(hotels.map(h => [h.id, h])), [hotels]);
  const selectedHotel = hotelFilter !== ALL ? hotels.find(h => h.id === hotelFilter) : undefined;
  const isAll = hotelFilter === ALL;

  // Latest salary record per employee — severance is the monthly accrual
  // already calculated by calculateBurden() from the fixed Basic/26 daily
  // rate formula.
  const latestSalaryMap = useMemo(() => {
    const m = new Map<string, SalaryRecord>();
    for (const s of salaryRecords) {
      const ex = m.get(s.employee_id);
      if (!ex || s.period_year > ex.period_year || (s.period_year === ex.period_year && s.period_month > ex.period_month)) {
        m.set(s.employee_id, s);
      }
    }
    return m;
  }, [salaryRecords]);

  // A row can be severance-applicable, gratuity-applicable, or both — the two
  // flags are independent per employee. Gratuity's Provision Balance is a
  // straight Gross × Rate% read from the already-calculated salary_records
  // .gratuity figure (calculateBurden()'s own formula) — unlike Severance,
  // it has no 5-year payout threshold/accrual concept — EXCEPT the
  // GRATUITY_ACCRUAL_START override (FRE001/FRE002), which multiplies by the
  // whole-months period of accrual instead.
  const rows = useMemo(() => {
    return employees
      .map(employee => {
        const salary = latestSalaryMap.get(employee.id);
        const hasSeverance = employee.severance_applicable;
        const hasGratuity = employee.gratuity_applicable;
        const monthsAccrued = hasSeverance ? monthsSinceLastPayoutThreshold(employee.employment_date) : 0;
        const severanceBalance = hasSeverance ? Math.round((salary?.severance ?? 0) * monthsAccrued * 100) / 100 : 0;
        const accrualStart = employee.employee_code ? GRATUITY_ACCRUAL_START[employee.employee_code] : undefined;
        const gratuityBalance = !hasGratuity ? 0
          : accrualStart
            ? Math.round((salary?.total_earnings ?? 0) * ((employee.gratuity_rate ?? 0) / 100) * periodOfAccrualMonths(accrualStart, year) * 100) / 100
            : (salary?.gratuity ?? 0);
        const totalBalance = severanceBalance + gratuityBalance;
        return {
          employee, salary, hotel: hotelMap.get(employee.hotel_id),
          hasSeverance, hasGratuity, monthsAccrued, severanceBalance, gratuityBalance, totalBalance,
        };
      })
      .filter(r => r.salary)
      .sort((a, b) => {
        const hotelCmp = (a.hotel?.short_code ?? '').localeCompare(b.hotel?.short_code ?? '');
        return hotelCmp !== 0 ? hotelCmp : a.employee.surname.localeCompare(b.employee.surname);
      });
  }, [employees, latestSalaryMap, hotelMap, year]);

  const totalsByCountry = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of rows) {
      const key = r.hotel ? (isBotswana(r.hotel.country) ? 'BWP' : 'ZAR') : 'BWP';
      totals.set(key, (totals.get(key) ?? 0) + r.totalBalance);
    }
    return totals;
  }, [rows]);

  const fmt = (n: number, hotel?: Hotel) => fmtCurrency(n, hotel?.country ?? selectedHotel?.country ?? 'Botswana');

  // Book Adjustment — cost of severance provision (as calculated) less the
  // manually-entered current book provision, floored to the nearest 100
  // toward negative infinity. Same pattern as Leave and Bonus Provision.
  const bookMap = useMemo(
    () => new Map(bookBalances.filter(b => b.period_year === year).map(b => [b.hotel_id, b])),
    [bookBalances, year],
  );

  const adjustmentHotels = useMemo(() => {
    if (isAll) return hotels;
    return selectedHotel ? [selectedHotel] : [];
  }, [isAll, hotels, selectedHotel]);

  // Book Adjustment stays Severance-only (matches the existing
  // severance_provision_book_balances data on the books) — Gratuity has no
  // book-balance table of its own, so it's excluded from this reconciliation.
  const adjustmentRows = useMemo(() => {
    return adjustmentHotels.map(h => {
      const cost = rows
        .filter(r => r.hotel?.id === h.id)
        .reduce((sum, r) => sum + r.severanceBalance, 0);
      const book = bookMap.get(h.id)?.book_provision ?? 0;
      const adjustment = Math.floor((cost - book) / 100) * 100;
      return { hotel: h, cost, book, adjustment };
    });
  }, [adjustmentHotels, rows, bookMap]);

  useEffect(() => {
    setBookInputs(prev => {
      const next = new Map(prev);
      for (const h of adjustmentHotels) {
        next.set(h.id, String(bookMap.get(h.id)?.book_provision ?? ''));
      }
      return next;
    });
  }, [bookMap, adjustmentHotels]);

  function handleBookInputChange(hotelId: string, value: string) {
    setBookInputs(prev => new Map(prev).set(hotelId, value));
  }

  async function handleBookInputBlur(hotelId: string) {
    const raw = bookInputs.get(hotelId) ?? '';
    const parsed = parseFloat(raw.replace(/[^0-9.\-]/g, ''));
    const value = isNaN(parsed) ? 0 : parsed;
    const { data } = await sb
      .from('severance_provision_book_balances')
      .upsert(
        { hotel_id: hotelId, period_year: year, book_provision: value, updated_at: new Date().toISOString() },
        { onConflict: 'hotel_id,period_year' },
      )
      .select()
      .single();
    if (data) {
      setBookBalances(prev => [
        ...prev.filter(b => !(b.hotel_id === hotelId && b.period_year === year)),
        data as SeveranceProvisionBookBalance,
      ]);
    }
  }

  // Recompute severance from each employee's latest salary record and
  // current tenure, and gratuity from Gross × Rate%. Severance also zeroes
  // provident_employee/provident_company per the Botswana rule
  // (severance_applicable employees have no PF), so — like Methods' "Save &
  // Update All" — this writes back the full set of dependent fields rather
  // than just `severance`/`gratuity`, to avoid leaving PF or total_cost
  // stale relative to them.
  async function recalculate() {
    setRecalculating(true);

    await Promise.all(rows.map(r => {
      const hotel = r.hotel;
      const sal = r.salary;
      if (!hotel || !sal) return Promise.resolve();

      const burden = calculateBurden({
        basic:               sal.basic_salary,
        totalEarnings:       sal.total_earnings,
        jobTitle:            r.employee.job_title,
        country:             hotel.country,
        wcaRate:             hotel.wca_rate ?? 0,
        hotelShortCode:      hotel.short_code,
        yearsOfService:      yearsOfService(r.employee.employment_date),
        severanceApplicable: r.employee.severance_applicable,
        incentiveApplicable: r.employee.incentive_applicable,
        incentiveMultiplier: r.employee.incentive_multiplier,
        gratuityApplicable:  r.employee.gratuity_applicable,
        gratuityRate:        r.employee.gratuity_rate,
        taxPaye:             sal.tax_paye,
        medicalEmployee:     sal.medical_employee,
        medicalCompany:      sal.medical_company,
        ancillaEmployee:     sal.ancilla_employee,
        ancillaCompany:      sal.ancilla_company,
        leaveProvision:      sal.leave_provision,
        otherCompanyContrib: sal.other_company_contrib,
        mgmtIncentive:       sal.mgmt_incentive,
        bonusAccrualDec:     sal.bonus_accrual_dec,
        bonusAccrualJuly:    sal.bonus_accrual_july,
        providentEeRate:       hotel.provident_ee_rate ?? undefined,
        providentErRate:       hotel.provident_er_rate ?? undefined,
        providentErRateSenior: hotel.provident_er_rate_senior ?? undefined,
        uifRate:               hotel.uif_rate ?? undefined,
        uifCap:                hotel.uif_cap ?? undefined,
        sdlRate:               hotel.sdl_rate ?? undefined,
        mealsStandard:         hotel.meals_standard ?? undefined,
        mealsManager:          hotel.meals_manager ?? undefined,
        leaveDays:             hotel.leave_days ?? undefined,
        bonusDays:             hotel.bonus_days ?? undefined,
        ctcProvidentEr:        hotel.ctc_provident_er ?? undefined,
        ctcUifEr:              hotel.ctc_uif_er ?? undefined,
        ctcSdl:                hotel.ctc_sdl ?? undefined,
        ctcWca:                hotel.ctc_wca ?? undefined,
        ctcMeals:              hotel.ctc_meals ?? undefined,
        ctcLeaveAccrual:       hotel.ctc_leave_accrual ?? undefined,
        ctcBonus:              hotel.ctc_bonus ?? undefined,
        leaveAccrualPct:       hotel.leave_accrual_pct ?? undefined,
        bonusProvisionPct:     hotel.bonus_provision_pct ?? undefined,
      });

      return sb.from('salary_records').update({
        provident_employee:    burden.provident_employee,
        uif_employee:          burden.uif_employee,
        total_deductions:      burden.total_deductions,
        net_salary:            burden.net_salary,
        provident_company:     burden.provident_company,
        severance:             burden.severance,
        gratuity:              burden.gratuity,
        total_company_contrib: burden.total_company_contrib,
        total_payroll_burden:  burden.total_payroll_burden,
        total_cost:            burden.total_cost,
        ctc:                   burden.ctc,
      }).eq('id', sal.id);
    }));

    const empIds = employees.map(e => e.id);
    const s = empIds.length
      ? await fetchAllRows<SalaryRecord>(() => sb.from('salary_records').select('*').in('employee_id', empIds))
      : [];
    setSalaryRecords(s);
    setRecalculating(false);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const headers = [
        ...(isAll ? ['Hotel'] : []),
        'Emp Code', 'Surname', 'First Name',
        'Basic Salary', 'Yrs Service', 'Daily Rate', 'Days / Month', 'Monthly Rate', 'Months Accrued', 'Severance Balance',
        'Gross Salary', 'Gratuity Rate', 'Gratuity Balance',
        'Total Provision Balance',
      ];
      const dataRows = rows.map(({ employee, salary, hotel, hasSeverance, hasGratuity, monthsAccrued, severanceBalance, gratuityBalance, totalBalance }) => {
        const yrs = yearsOfService(employee.employment_date);
        const daysPerMonth = yrs >= SEVERANCE_SENIOR_YEARS ? 2 : 1;
        const dailyRate = (salary?.basic_salary ?? 0) / 26;
        return [
          ...(isAll ? [hotel?.short_code ?? '—'] : []),
          employee.employee_code ?? '—',
          employee.surname,
          employee.first_name,
          hasSeverance ? (salary?.basic_salary ?? 0) : null,
          hasSeverance ? yrs : null,
          hasSeverance ? Math.round(dailyRate * 100) / 100 : null,
          hasSeverance ? daysPerMonth : null,
          hasSeverance ? (salary?.severance ?? 0) : null,
          hasSeverance ? monthsAccrued : null,
          hasSeverance ? severanceBalance : null,
          hasGratuity ? (salary?.total_earnings ?? 0) : null,
          hasGratuity ? (employee.gratuity_rate ?? 0) : null,
          hasGratuity ? gratuityBalance : null,
          totalBalance,
        ];
      });
      const totalsRow = [
        ...(isAll ? [''] : []),
        `Total (${rows.length} employees)`, '', '',
        '', '', '', '', '', '', '',
        '', '', '',
        [...totalsByCountry.entries()].map(([cur, v]) => `${cur} ${v.toLocaleString('en-ZA', { maximumFractionDigits: 2 })}`).join(' / '),
      ];
      const sheet: ReportSheet = {
        name: isAll ? 'All Hotels' : (selectedHotel?.short_code ?? 'Severance Provision'),
        headers,
        rows: [...dataRows, totalsRow],
        isTotalsRow: [...dataRows.map(() => false), true],
      };
      const label = isAll ? 'All_Hotels' : (selectedHotel?.short_code ?? 'Severance_Provision');
      await exportReport('Severance Provision', `Severance_Provision_${label}_${year}.xlsx`, [sheet]);
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
        <div className="flex items-center gap-3 mb-2">
          <HandCoins className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold text-foreground">Severance & Gratuity Provision</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Severance accrual — Basic ÷ 26 daily rate, 1 day/month under 60 months' service, 2 days/month thereafter, paid out at every 5-year mark so the balance only covers months accrued since the most recent threshold crossed. Gratuity — Gross Salary × Rate%, no accrual threshold (FRE001/FRE002 use a period-of-accrual multiplier instead: whole months from LOA start 1 Oct 2024 to 31 Jul {year}, multiplied directly into the formula). ILG, CSL, NL and CFEM; shows employees with "Calculate severance accrual" and/or "Gratuity applicable" ticked on the Employee page — an employee can have either, both, or (once ticked) neither.
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
            {[year, year - 1, year - 2].map(y => <option key={y} value={y}>{y}</option>)}
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

      {adjustmentRows.length > 0 && (
        <div className="bg-white rounded-xl border overflow-x-auto mb-6">
          <div className="px-4 py-3 border-b bg-muted/40">
            <h2 className="text-sm font-semibold">Book Adjustment — {year}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Cost of Severance Provision (as calculated) less Current Provision on Books = Adjustment Required, rounded down to the nearest 100.
            </p>
          </div>
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/20">
                {isAll && <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Hotel</th>}
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Cost of Severance Provision (as calculated)</th>
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Current Provision on Books</th>
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Adjustment Required</th>
              </tr>
            </thead>
            <tbody>
              {adjustmentRows.map(({ hotel, cost, adjustment }) => (
                <tr key={hotel.id} className="border-b last:border-0">
                  {isAll && <td className="px-4 py-2.5 text-muted-foreground">{hotel.short_code}</td>}
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmt(cost, hotel)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={bookInputs.get(hotel.id) ?? ''}
                      onChange={e => handleBookInputChange(hotel.id, e.target.value)}
                      onBlur={() => handleBookInputBlur(hotel.id)}
                      placeholder="0"
                      className="w-32 text-right rounded-md border border-input px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono font-medium ${adjustment === 0 ? 'text-muted-foreground' : adjustment < 0 ? 'text-red-600' : 'text-amber-600'}`}>
                    {fmt(adjustment, hotel)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border p-10 text-center text-sm text-muted-foreground">
          No employees with severance accrual or gratuity enabled for {isAll ? 'any hotel' : (selectedHotel?.short_code ?? 'this hotel')}.
          Tick "Calculate severance accrual" and/or "Gratuity applicable" on the Employee page to add someone here.
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
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Basic Salary</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Yrs Service</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Daily Rate</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Days / Month</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Monthly Rate</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Months Accrued</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Severance Balance</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground border-l">Gross Salary</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Gratuity Rate</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Gratuity Balance</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground border-l">Total Provision Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ employee, salary, hotel, hasSeverance, hasGratuity, monthsAccrued, severanceBalance, gratuityBalance, totalBalance }, i) => {
                const yrs = yearsOfService(employee.employment_date);
                const daysPerMonth = yrs >= SEVERANCE_SENIOR_YEARS ? 2 : 1;
                const dailyRate = (salary?.basic_salary ?? 0) / 26;
                return (
                  <tr key={employee.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                    {isAll && <td className="px-4 py-2.5 text-muted-foreground">{hotel?.short_code ?? '—'}</td>}
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{employee.employee_code ?? '—'}</td>
                    <td className="px-4 py-2.5 font-medium">{employee.surname}</td>
                    <td className="px-4 py-2.5">{employee.first_name}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{hasSeverance ? fmt(salary?.basic_salary ?? 0, hotel) : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{hasSeverance ? yrs.toFixed(1) : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{hasSeverance ? fmt(dailyRate, hotel) : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{hasSeverance ? daysPerMonth : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{hasSeverance ? fmt(salary?.severance ?? 0, hotel) : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{hasSeverance ? monthsAccrued : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{hasSeverance ? fmt(severanceBalance, hotel) : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground border-l">{hasGratuity ? fmt(salary?.total_earnings ?? 0, hotel) : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{hasGratuity ? `${employee.gratuity_rate ?? 0}%` : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{hasGratuity ? fmt(gratuityBalance, hotel) : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-medium border-l">{fmt(totalBalance, hotel)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/20 font-medium">
                <td className="px-4 py-3" colSpan={isAll ? 14 : 13}>Total ({rows.length} employees)</td>
                <td className="px-4 py-3 text-right font-mono border-l">
                  {[...totalsByCountry.entries()].map(([cur, v]) => (
                    <div key={cur}>{cur === 'BWP' ? 'P' : 'R'} {v.toLocaleString('en-ZA', { maximumFractionDigits: 2 })}</div>
                  ))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
