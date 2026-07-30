'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Employee, Hotel, SalaryRecord, BonusProvisionBookBalance } from '@/types/database';
import { fmtCurrency, sortHotels } from '@/lib/utils';
import { calculateBurden, isBotswana } from '@/lib/payroll-calc';
import { exportReport, type ReportSheet } from '@/lib/reports-export';
import { RefreshCw, Download, Gift } from 'lucide-react';

const HOTEL_FILTER_KEY = 'ihg-salary-bonus-hotel';
const ACCRUAL_MONTHS_KEY = 'ihg-salary-bonus-accrual-months';
const ALL = 'ALL';
const DEFAULT_ACCRUAL_MONTHS = 7; // monthly total accrued to end July

// Bonus Provision only applies to these four hotels.
const BONUS_HOTEL_CODES = ['ILG', 'IH', 'ILRB', 'APA'];

function yearsOfService(date: string | null): number {
  if (!date) return 0;
  const ms = Date.now() - new Date(date).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25) * 10) / 10;
}

export default function BonusProvisionPage() {
  const sb = createClient();

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [hotelFilter, setHotelFilter] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [salaryRecords, setSalaryRecords] = useState<SalaryRecord[]>([]);
  const [bookBalances, setBookBalances] = useState<BonusProvisionBookBalance[]>([]);
  const [bookInputs, setBookInputs] = useState<Map<string, string>>(new Map());
  const [year, setYear] = useState(new Date().getFullYear());
  const [accrualMonths, setAccrualMonths] = useState(DEFAULT_ACCRUAL_MONTHS);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function load() {
    const [{ data: h }, meRes] = await Promise.all([
      sb.from('hotels').select('*'),
      fetch('/api/auth/me').then(r => r.ok ? r.json() : null),
    ]);
    const me = meRes as { role: string; hotelIds: string[] | null } | null;
    let hotelList = sortHotels((h ?? []) as Hotel[]).filter(hh => BONUS_HOTEL_CODES.includes(hh.short_code));
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
    try {
      const saved = localStorage.getItem(ACCRUAL_MONTHS_KEY);
      if (saved) {
        const n = parseFloat(saved);
        if (!isNaN(n) && n > 0) setAccrualMonths(n);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (hotelFilter) {
      try { localStorage.setItem(HOTEL_FILTER_KEY, hotelFilter); } catch {}
    }
  }, [hotelFilter]);

  useEffect(() => {
    try { localStorage.setItem(ACCRUAL_MONTHS_KEY, String(accrualMonths)); } catch {}
  }, [accrualMonths]);

  useEffect(() => {
    if (!hotelFilter || hotels.length === 0) return;
    (async () => {
      const hotelIds = hotelFilter === ALL ? hotels.map(h => h.id) : [hotelFilter];
      const [{ data: e }, { data: b }] = await Promise.all([
        sb.from('employees').select('*').in('hotel_id', hotelIds).eq('status', 'active'),
        sb.from('bonus_provision_book_balances').select('*').in('hotel_id', hotelIds),
      ]);
      const empList = (e ?? []) as Employee[];
      const empIds = empList.map(emp => emp.id);
      const { data: s } = empIds.length
        ? await sb.from('salary_records').select('*').in('employee_id', empIds)
        : { data: [] };
      setEmployees(empList);
      setSalaryRecords((s ?? []) as SalaryRecord[]);
      setBookBalances((b ?? []) as BonusProvisionBookBalance[]);
    })();
  }, [hotelFilter, hotels]);

  const hotelMap = useMemo(() => new Map(hotels.map(h => [h.id, h])), [hotels]);
  const selectedHotel = hotelFilter !== ALL ? hotels.find(h => h.id === hotelFilter) : undefined;
  const isAll = hotelFilter === ALL;

  // Latest salary record per employee — bonus_provision is the monthly 13th-
  // cheque accrual Methods already calculates from each hotel's bonus rates.
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

  const rows = useMemo(() => {
    return employees
      .map(employee => {
        const salary = latestSalaryMap.get(employee.id);
        // ANO = an unfilled/vacant position, not a real employee — never
        // carries a bonus or incentive provision regardless of what's on
        // its placeholder salary record.
        const isAno = employee.grade_label === 'ANO';
        const monthlyAmount = isAno ? 0 : (salary?.bonus_provision ?? 0) + (salary?.incentive ?? 0);
        // Bonus provision is a monthly rate — the balance actually owed by a
        // given point in the year is that monthly rate accrued over however
        // many months have elapsed (7 = to end July, editable in the header).
        const provisionBalance = Math.round(monthlyAmount * accrualMonths * 100) / 100;
        return { employee, salary, hotel: hotelMap.get(employee.hotel_id), isAno, monthlyAmount, provisionBalance };
      })
      .filter(r => r.salary)
      .sort((a, b) => {
        const hotelCmp = (a.hotel?.short_code ?? '').localeCompare(b.hotel?.short_code ?? '');
        return hotelCmp !== 0 ? hotelCmp : a.employee.surname.localeCompare(b.employee.surname);
      });
  }, [employees, latestSalaryMap, hotelMap, accrualMonths]);

  // Group totals by currency — ALL view can mix ZAR (SA: IH, ILRB, APA) and BWP (ILG).
  // Incentive-scheme employees (incentive_applicable) get salary_records.incentive
  // instead of bonus_provision (calculateBurden zeroes one or the other) — both
  // represent the same annual payout reserve via different schemes, so they're
  // combined into one total. ANO rows contribute 0 (see `monthlyAmount` above).
  const totalsByCountry = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of rows) {
      const key = r.hotel ? (isBotswana(r.hotel.country) ? 'BWP' : 'ZAR') : 'ZAR';
      totals.set(key, (totals.get(key) ?? 0) + r.provisionBalance);
    }
    return totals;
  }, [rows]);

  const fmt = (n: number, hotel?: Hotel) => fmtCurrency(n, hotel?.country ?? selectedHotel?.country ?? '');

  // Book Adjustment — cost of bonus provision (as calculated) less the
  // manually-entered current book provision, floored to the nearest 100
  // toward negative infinity. Same pattern as the Leave Provision page.
  const bookMap = useMemo(
    () => new Map(bookBalances.filter(b => b.period_year === year).map(b => [b.hotel_id, b])),
    [bookBalances, year],
  );

  const adjustmentHotels = useMemo(() => {
    if (isAll) return hotels;
    return selectedHotel ? [selectedHotel] : [];
  }, [isAll, hotels, selectedHotel]);

  const adjustmentRows = useMemo(() => {
    return adjustmentHotels.map(h => {
      const cost = rows
        .filter(r => r.hotel?.id === h.id)
        .reduce((sum, r) => sum + r.provisionBalance, 0);
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
      .from('bonus_provision_book_balances')
      .upsert(
        { hotel_id: hotelId, period_year: year, book_provision: value, updated_at: new Date().toISOString() },
        { onConflict: 'hotel_id,period_year' },
      )
      .select()
      .single();
    if (data) {
      setBookBalances(prev => [
        ...prev.filter(b => !(b.hotel_id === hotelId && b.period_year === year)),
        data as BonusProvisionBookBalance,
      ]);
    }
  }

  // Recompute bonus_provision from each employee's latest salary record and
  // their hotel's current Methods-configured bonus rates — useful if rates
  // changed since the last "Save & Update All" on the Methods page.
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
        bonus_provision:      burden.bonus_provision,
        incentive:            burden.incentive,
        total_payroll_burden: burden.total_payroll_burden,
        total_cost:           burden.total_cost,
        ctc:                  burden.ctc,
      }).eq('id', sal.id);
    }));

    const empIds = employees.map(e => e.id);
    const { data: s } = empIds.length
      ? await sb.from('salary_records').select('*').in('employee_id', empIds)
      : { data: [] };
    setSalaryRecords((s ?? []) as SalaryRecord[]);
    setRecalculating(false);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const headers = [
        ...(isAll ? ['Hotel'] : []),
        'Emp Code', 'Surname', 'First Name', 'Grade', 'Gross Salary', 'Bonus Provision', 'Incentive', 'Accrual Months', 'Provision Balance',
      ];
      const dataRows = rows.map(({ employee, salary, hotel, isAno, provisionBalance }) => [
        ...(isAll ? [hotel?.short_code ?? '—'] : []),
        employee.employee_code ?? '—',
        employee.surname,
        employee.first_name,
        employee.grade_label ?? 'Unclassified',
        salary?.total_earnings ?? 0,
        isAno ? 0 : (salary?.bonus_provision ?? 0),
        isAno ? 0 : (salary?.incentive ?? 0),
        accrualMonths,
        provisionBalance,
      ]);
      const totalsRow = [
        ...(isAll ? [''] : []),
        `Total (${rows.length} employees)`, '', '', '', '', '', '', '',
        [...totalsByCountry.entries()].map(([cur, v]) => `${cur} ${v.toLocaleString('en-ZA', { maximumFractionDigits: 2 })}`).join(' / '),
      ];
      const sheet: ReportSheet = {
        name: isAll ? 'All Hotels' : (selectedHotel?.short_code ?? 'Bonus Provision'),
        headers,
        rows: [...dataRows, totalsRow],
        isTotalsRow: [...dataRows.map(() => false), true],
      };
      const label = isAll ? 'All_Hotels' : (selectedHotel?.short_code ?? 'Bonus_Provision');
      await exportReport('Bonus Provision', `Bonus_Provision_${label}_${year}.xlsx`, [sheet]);
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
          <Gift className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold text-foreground">Bonus Provision</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          13th-cheque bonus provision — pulled from each employee's latest salary record and their hotel's Methods-configured bonus rates, plus employees ticked for incentive bonus on the Employee page (Incentive column). ANO (vacant) positions always show "—". ILG, IH, ILRB and APA only.
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
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Accrual Months</label>
          <input
            type="number" step="1" min="1" max="12"
            value={accrualMonths}
            onChange={e => {
              const n = parseFloat(e.target.value);
              setAccrualMonths(isNaN(n) ? 0 : n);
            }}
            className="w-24 rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
          />
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
              Cost of Bonus Provision (monthly total × {accrualMonths} accrual months, including Incentive) less Current Provision on Books = Adjustment Required, rounded down to the nearest 100.
            </p>
          </div>
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/20">
                {isAll && <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Hotel</th>}
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Cost of Bonus Provision (as calculated)</th>
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
          No salary records found for {isAll ? 'any hotel' : (selectedHotel?.short_code ?? 'this hotel')}.
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
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Gross Salary</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Bonus Provision</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Incentive</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Provision Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ employee, salary, hotel, isAno, provisionBalance }, i) => (
                <tr key={employee.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                  {isAll && <td className="px-4 py-2.5 text-muted-foreground">{hotel?.short_code ?? '—'}</td>}
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{employee.employee_code ?? '—'}</td>
                  <td className="px-4 py-2.5 font-medium">{employee.surname}</td>
                  <td className="px-4 py-2.5">{employee.first_name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{employee.grade_label ?? 'Unclassified'}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmt(salary?.total_earnings ?? 0, hotel)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">
                    {isAno || employee.incentive_applicable ? '—' : fmt(salary?.bonus_provision ?? 0, hotel)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">
                    {!isAno && employee.incentive_applicable ? fmt(salary?.incentive ?? 0, hotel) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">
                    {isAno ? '—' : fmt(provisionBalance, hotel)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/20 font-medium">
                <td className="px-4 py-3" colSpan={isAll ? 8 : 7}>Total ({rows.length} employees)</td>
                <td className="px-4 py-3 text-right font-mono">
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
