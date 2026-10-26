'use client';

// Annual Bonus — the actual bonus payment schedule. Modelled on Salary Review
// (per-hotel % of gross + flat, grade/employee exclusions, per-employee
// overrides, persistent per-hotel drafts) but without the Threshold Basic tier,
// and it never writes salary_records: a bonus is a one-off payment, not a
// change to anyone's salary. Drafts live in annual_bonus_scenarios (migration
// 034), never in increase_scenarios, which the Dashboard reads.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createClient, fetchAllRows } from '@/lib/supabase/client';
import { Hotel, Employee, SalaryRecord } from '@/types/database';
import { fmtCurrency, sortHotels, MONTH_NAMES } from '@/lib/utils';
import { Pencil, X, Check, Download, Save, Trash2 } from 'lucide-react';
import { exportAnnualBonus, AnnualBonusExportHotel } from '@/lib/annual-bonus-export';

// Eligibility: under 6 months' service at 31 Dec of the bonus year = no bonus;
// 6–11 months = pro rata (months / 12); 12+ months = full. Same rule and anchor
// date as the Bonus Provision page's 13th-cheque calc.
const MIN_ELIGIBLE_MONTHS = 6;

function monthsOfServiceAtDec(employmentDate: string | null, year: number): number | null {
  if (!employmentDate) return null;
  const start = new Date(employmentDate);
  const ref = new Date(year, 11, 31);
  let months = (ref.getFullYear() - start.getFullYear()) * 12 + (ref.getMonth() - start.getMonth());
  if (ref.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

// Incentive bonuses are paid on last year's salary — the gross as at July of the
// bonus year (latest salary record on or before July), i.e. before that year's
// increase. Falls back to the current gross when no record is that early.
const INCENTIVE_BASE_MONTH = 7;

// Incentive employees whose bonus is paid on their CURRENT gross instead of the
// July (old) gross — explicit exceptions confirmed by the user, Oct 2026.
const INCENTIVE_CURRENT_GROSS_CODES = new Set(['GEY001', 'NKO003', 'PEF001', 'JAM001']);

function payoutFactor(months: number | null): number {
  if (months == null || months < MIN_ELIGIBLE_MONTHS) return 0;
  return Math.min(months, 12) / 12;
}

interface Override {
  pct: string;
  flat: string;
}

interface HotelSettings {
  pct: string;
  flat: string;
  overrides: Map<string, Override>;
  excluded: Set<string>;
}

interface BonusRow {
  employee: Employee;
  hotel: Hotel;
  currentGross: number;
  baseGross: number;              // gross the bonus is calculated on (July record for incentive employees)
  basePeriod: string | null;      // e.g. "Jun 2026" when baseGross comes from an earlier record
  baseIsException: boolean;       // incentive employee on the current-gross exception list
  monthsService: number | null;   // at 31 Dec of the bonus year; null = no start date
  factor: number;                 // 0 (ineligible), months/12 (pro rata) or 1
  incentiveMultiplier: number | null; // set for incentive-scheme employees: bonus = gross × multiplier × factor
  effectivePct: number;
  effectiveFlat: number;
  bonusAmount: number;
  hasOverride: boolean;
  isExcluded: boolean;
}

function computeRows(
  hotelId: string,
  settings: HotelSettings,
  employees: Employee[],
  hotelMap: Map<string, Hotel>,
  latestSalary: Map<string, SalaryRecord>,
  julySalary: Map<string, SalaryRecord>,
  bonusYear: number,
): BonusRow[] {
  const gPct  = (parseFloat(settings.pct) || 0) / 100;
  const gFlat = parseFloat(settings.flat) || 0;

  const hotelEmployees = employees.filter(e => e.hotel_id === hotelId);
  const hasIncentive   = hotelEmployees.some(e => e.incentive_applicable);
  if (gPct === 0 && gFlat === 0 && !hasIncentive && settings.overrides.size === 0 && settings.excluded.size === 0) return [];

  return hotelEmployees
    .map(e => {
      const sal   = latestSalary.get(e.id);
      const hotel = hotelMap.get(e.hotel_id);
      if (!sal || !hotel) return null;

      const currentGross = sal.total_earnings;
      const isExcluded   = settings.excluded.has(e.id);
      const ov           = settings.overrides.get(e.id);
      const hasOv        = !!ov && (ov.pct !== '' || ov.flat !== '');

      // Incentive-scheme employees (employees.incentive_applicable, e.g. APA's
      // executives) get gross × incentive_multiplier instead of the hotel's
      // % + flat. A per-employee override still takes precedence.
      const incentiveMultiplier = e.incentive_applicable && !hasOv ? (e.incentive_multiplier ?? 0) : null;
      const basePct  = incentiveMultiplier != null ? incentiveMultiplier : gPct;
      const baseFlat = incentiveMultiplier != null ? 0 : gFlat;

      const effectivePct  = isExcluded ? 0 : (ov && ov.pct  !== '' ? (parseFloat(ov.pct)  || 0) / 100 : basePct);
      const effectiveFlat = isExcluded ? 0 : (ov && ov.flat !== '' ? (parseFloat(ov.flat) || 0)        : baseFlat);

      // Bonus = (gross × factor) × % + flat × factor, rounded to cents.
      // The factor pro-rates the flat too, and zeroes everything when ineligible.
      const baseIsException = incentiveMultiplier != null && INCENTIVE_CURRENT_GROSS_CODES.has(e.employee_code ?? '');
      const julySal    = incentiveMultiplier != null && !baseIsException ? julySalary.get(e.id) : undefined;
      const baseGross  = julySal ? julySal.total_earnings : currentGross;
      const basePeriod = julySal ? `${MONTH_NAMES[julySal.period_month - 1]} ${julySal.period_year}` : null;

      const monthsService = monthsOfServiceAtDec(e.employment_date, bonusYear);
      const factor        = payoutFactor(monthsService);
      const bonusAmount   = isExcluded ? 0
        : Math.round((baseGross * factor * effectivePct + effectiveFlat * factor) * 100) / 100;

      return {
        employee: e, hotel, currentGross, baseGross, basePeriod, baseIsException, monthsService, factor, incentiveMultiplier, effectivePct, effectiveFlat, bonusAmount,
        hasOverride: !!ov && !isExcluded, isExcluded,
      };
    })
    .filter((r): r is BonusRow => r !== null && r.currentGross > 0)
    .sort((a, b) =>
      a.employee.surname.localeCompare(b.employee.surname) ||
      a.employee.first_name.localeCompare(b.employee.first_name));
}

// Latest salary record per employee, and latest on or before July of the bonus
// year (the incentive base — see INCENTIVE_BASE_MONTH).
function latestSalaryMap(salList: SalaryRecord[]): Map<string, SalaryRecord> {
  const m = new Map<string, SalaryRecord>();
  for (const sr of salList) {
    const ex = m.get(sr.employee_id);
    if (!ex || sr.period_year > ex.period_year ||
      (sr.period_year === ex.period_year && sr.period_month > ex.period_month)) {
      m.set(sr.employee_id, sr);
    }
  }
  return m;
}

function julySalaryMap(salList: SalaryRecord[], bonusYear: number): Map<string, SalaryRecord> {
  const cutoff = bonusYear * 12 + INCENTIVE_BASE_MONTH;
  const m = new Map<string, SalaryRecord>();
  for (const sr of salList) {
    const key = sr.period_year * 12 + sr.period_month;
    if (key > cutoff) continue;
    const ex = m.get(sr.employee_id);
    if (!ex || key > ex.period_year * 12 + ex.period_month) m.set(sr.employee_id, sr);
  }
  return m;
}

function settingsFromJson(s2: Record<string, unknown>): HotelSettings {
  return {
    pct:  (s2.pct  as string) ?? '',
    flat: (s2.flat as string) ?? '',
    overrides: new Map(Object.entries((s2.overrides as Record<string, Override>) ?? {})),
    excluded:  new Set<string>((s2.excluded as string[]) ?? []),
  };
}

export default function AnnualBonusPage() {
  const sb = createClient();

  const [hotels, setHotels]             = useState<Hotel[]>([]);
  const [employees, setEmployees]       = useState<Employee[]>([]);
  const [latestSalary, setLatestSalary] = useState<Map<string, SalaryRecord>>(new Map());
  const [salaryList, setSalaryList]     = useState<SalaryRecord[]>([]);

  const [hotelFilter, setHotelFilter] = useState('');
  const [bonusYear, setBonusYear]     = useState(() => new Date().getFullYear());

  const [pct,  setPct]  = useState('');
  const [flat, setFlat] = useState('');
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const [excluded,  setExcluded]  = useState<Set<string>>(new Set());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Override>({ pct: '', flat: '' });

  const [hotelSettings, setHotelSettings] = useState<Map<string, HotelSettings>>(new Map());
  const hotelSettingsRef = useRef<Map<string, HotelSettings>>(new Map());
  const hotelDraftIdsRef = useRef<Map<string, string>>(new Map());
  const [draftsLoadedFor, setDraftsLoadedFor] = useState<number | null>(null);

  const [saving,    setSaving]    = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Hotels, employees and latest salary records — loaded once
  useEffect(() => {
    async function load() {
      const [{ data: h }, empList, salList] = await Promise.all([
        sb.from('hotels').select('*'),
        fetchAllRows<Employee>(() => sb.from('employees').select('*').eq('status', 'active')),
        fetchAllRows<SalaryRecord>(() => sb.from('salary_records').select('*')),
      ]);
      const hotelList = sortHotels((h ?? []) as Hotel[]);

      setHotels(hotelList);
      setEmployees(empList);
      setLatestSalary(latestSalaryMap(salList));
      setSalaryList(salList);
      if (hotelList.length > 0) setHotelFilter(prev => prev || hotelList[0].id);
    }
    load();
  }, []);

  // Saved drafts for the selected bonus year
  useEffect(() => {
    let cancelled = false;
    async function loadDrafts() {
      const { data: drafts, error } = await sb
        .from('annual_bonus_scenarios')
        .select('id, hotel_id, settings_json')
        .eq('period_year', bonusYear);
      if (cancelled) return;
      if (error) console.error('annual_bonus_scenarios load failed — has migration 034 been applied?', error);

      const settingsMap = new Map<string, HotelSettings>();
      const draftIds    = new Map<string, string>();
      for (const d of (drafts ?? [])) {
        settingsMap.set(d.hotel_id as string, settingsFromJson((d.settings_json ?? {}) as Record<string, unknown>));
        draftIds.set(d.hotel_id as string, d.id as string);
      }
      hotelSettingsRef.current = settingsMap;
      hotelDraftIdsRef.current = draftIds;
      setHotelSettings(settingsMap);
      setDraftsLoadedFor(bonusYear);
    }
    loadDrafts();
    return () => { cancelled = true; };
  }, [bonusYear]);

  // When the hotel (or the year's drafts) change, load that hotel's saved settings into the form
  useEffect(() => {
    if (!hotelFilter || draftsLoadedFor === null) return;
    const saved = hotelSettingsRef.current.get(hotelFilter);
    setPct(saved?.pct ?? '');
    setFlat(saved?.flat ?? '');
    setOverrides(new Map(saved?.overrides ?? []));
    setExcluded(new Set(saved?.excluded ?? []));
    setEditingId(null);
  }, [hotelFilter, draftsLoadedFor]);

  // Latest salary record per employee on or before July of the bonus year
  const julySalary = useMemo(() => julySalaryMap(salaryList, bonusYear), [salaryList, bonusYear]);

  const hotelMap = useMemo(() => new Map(hotels.map(h => [h.id, h])), [hotels]);

  const bonusRows = useMemo((): BonusRow[] => {
    if (!hotelFilter) return [];
    return computeRows(hotelFilter, { pct, flat, overrides, excluded }, employees, hotelMap, latestSalary, julySalary, bonusYear);
  }, [hotelFilter, pct, flat, overrides, excluded, employees, hotelMap, latestSalary, julySalary, bonusYear]);

  const totals = useMemo(() => ({
    currentGross:  bonusRows.reduce((s, r) => s + r.currentGross, 0),
    bonus:         bonusRows.reduce((s, r) => s + r.bonusAmount,  0),
    totalFlat:     bonusRows.reduce((s, r) => s + r.effectiveFlat, 0),
    count:         bonusRows.length,
    paidCount:     bonusRows.filter(r => !r.isExcluded && r.bonusAmount > 0).length,
    excludedCount: bonusRows.filter(r => r.isExcluded).length,
    ineligibleCount: bonusRows.filter(r => !r.isExcluded && r.factor === 0).length,
    proRataCount:  bonusRows.filter(r => !r.isExcluded && r.factor > 0 && r.factor < 1).length,
    incentiveCount: bonusRows.filter(r => !r.isExcluded && r.incentiveMultiplier != null).length,
  }), [bonusRows]);

  const savedSummary = useMemo(() =>
    hotels
      .filter(h => hotelSettings.has(h.id))
      .map(h => {
        const s    = hotelSettings.get(h.id)!;
        const rows = computeRows(h.id, s, employees, hotelMap, latestSalary, julySalary, bonusYear);
        return {
          hotel: h,
          pct:   s.pct,
          flat:  s.flat,
          incentiveCount: rows.filter(r => !r.isExcluded && r.incentiveMultiplier != null).length,
          count: rows.filter(r => !r.isExcluded && r.bonusAmount > 0).length,
          bonus: rows.reduce((a, r) => a + r.bonusAmount, 0),
        };
      }),
    [hotels, hotelSettings, employees, hotelMap, latestSalary, julySalary, bonusYear],
  );

  // ── Override editing ───────────────────────────────────────────────────────

  function startEdit(emp: Employee) {
    setEditDraft({ ...(overrides.get(emp.id) ?? { pct: '', flat: '' }) });
    setEditingId(emp.id);
  }

  function applyEdit(empId: string) {
    if (editDraft.pct === '' && editDraft.flat === '') {
      setOverrides(prev => { const n = new Map(prev); n.delete(empId); return n; });
    } else {
      setOverrides(prev => new Map(prev).set(empId, { ...editDraft }));
    }
    setEditingId(null);
  }

  function clearOverride(empId: string) {
    setOverrides(prev => { const n = new Map(prev); n.delete(empId); return n; });
    setEditingId(null);
  }

  // ── Save current hotel's settings to DB ───────────────────────────────────

  async function saveHotelSettings() {
    if (!hotelFilter) return;
    setSaving(true);
    try {
      const entry: HotelSettings = {
        pct, flat, overrides: new Map(overrides), excluded: new Set(excluded),
      };
      const settingsJson = {
        pct, flat,
        overrides: Object.fromEntries([...overrides.entries()]),
        excluded:  [...excluded],
      };

      const { data, error } = await sb.from('annual_bonus_scenarios').upsert({
        hotel_id:      hotelFilter,
        period_year:   bonusYear,
        status:        'draft',
        settings_json: settingsJson,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'hotel_id,period_year' }).select('id').single();
      if (error) {
        alert(`Could not save the bonus: ${error.message}\n\nHas migration 034_annual_bonus_scenarios.sql been applied?`);
        return;
      }

      const nextSettings = new Map(hotelSettingsRef.current).set(hotelFilter, entry);
      hotelSettingsRef.current = nextSettings;
      setHotelSettings(nextSettings);
      hotelDraftIdsRef.current = new Map(hotelDraftIdsRef.current).set(hotelFilter, (data as { id: string }).id);

      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  // ── Delete a hotel's saved bonus ──────────────────────────────────────────

  async function deleteDraft(hotelId: string) {
    const id = hotelDraftIdsRef.current.get(hotelId);
    if (!id) return;
    const hotel = hotelMap.get(hotelId);
    if (!window.confirm(`Delete the saved ${bonusYear} bonus for ${hotel?.name ?? 'this hotel'}?`)) return;

    await sb.from('annual_bonus_scenarios').delete().eq('id', id);

    const nextSettings = new Map(hotelSettingsRef.current);
    nextSettings.delete(hotelId);
    hotelSettingsRef.current = nextSettings;
    setHotelSettings(nextSettings);

    const nextIds = new Map(hotelDraftIdsRef.current);
    nextIds.delete(hotelId);
    hotelDraftIdsRef.current = nextIds;

    if (hotelFilter === hotelId) {
      setPct(''); setFlat('');
      setOverrides(new Map()); setExcluded(new Set());
    }
  }

  // ── Excel export (saved hotels, one sheet each + overview) ────────────────

  async function handleExport() {
    if (savedSummary.length === 0) {
      alert("Save at least one hotel's bonus before exporting.");
      return;
    }
    setExporting(true);
    try {
      // Re-read the roster and salary records now, so the export reflects the
      // current employee lists even if an HR List import ran after this page loaded.
      const [empList, salList] = await Promise.all([
        fetchAllRows<Employee>(() => sb.from('employees').select('*').eq('status', 'active')),
        fetchAllRows<SalaryRecord>(() => sb.from('salary_records').select('*')),
      ]);
      setEmployees(empList);
      setSalaryList(salList);
      const latest = latestSalaryMap(salList);
      setLatestSalary(latest);
      const july = julySalaryMap(salList, bonusYear);

      const exportHotels: AnnualBonusExportHotel[] = savedSummary.map(s => {
        const rows = computeRows(s.hotel.id, hotelSettings.get(s.hotel.id)!, empList, hotelMap, latest, july, bonusYear);
        return {
          name:      s.hotel.name,
          shortCode: s.hotel.short_code ?? s.hotel.name,
          currency:  s.hotel.country.toLowerCase().includes('botswana') ? 'BWP' : 'ZAR',
          pct:       s.pct,
          flat:      s.flat,
          rows: rows.map(r => ({
            employeeCode: r.employee.employee_code ?? '',
            surname:      r.employee.surname,
            firstName:    r.employee.first_name,
            jobTitle:     r.employee.job_title ?? '',
            gradeLabel:   r.employee.grade_label,
            basis:        r.isExcluded ? 'Excluded'
              : r.hasOverride ? 'Override'
              : r.incentiveMultiplier != null ? `Incentive ×${r.incentiveMultiplier}` : 'Standard',
            startDate:    r.employee.employment_date,
            currentGross: r.currentGross,
            baseGross:    r.baseGross,
            basePeriod:   r.basePeriod ?? (r.baseIsException ? 'Current (exception)' : null),
            rate:         r.effectivePct,
            isIncentive:  r.incentiveMultiplier != null,
            flat:         r.effectiveFlat,
            isExcluded:   r.isExcluded,
          })),
        };
      });
      await exportAnnualBonus(exportHotels, bonusYear);
    } finally {
      setExporting(false);
    }
  }

  const currentHotel  = hotelMap.get(hotelFilter);
  const country       = currentHotel?.country ?? '';
  const hasAnyInput   = (parseFloat(pct) > 0) || (parseFloat(flat) > 0) || overrides.size > 0 || totals.incentiveCount > 0;
  const overrideCount = bonusRows.filter(r => r.hasOverride).length;
  const currencySym   = country.toLowerCase().includes('botswana') ? 'P' : 'R';

  return (
    <div className="p-8">
      <div className="mb-8 flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Annual Bonus</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Bonus payment schedule — set the bonus per hotel as a % of gross and/or a flat amount, then save. Incentive-scheme employees are paid gross × their incentive multiplier.
            This is separate from the Bonus Provision and does not change anyone&apos;s salary.
          </p>
        </div>

        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-2 rounded-md border border-input bg-white px-5 py-2.5 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Building Excel…' : 'Export to Excel'}
        </button>
      </div>

      {/* ── Saved hotels summary ── */}
      {savedSummary.length > 0 && (
        <div className="mb-6 bg-white rounded-xl border p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Saved Bonuses — {bonusYear}
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 font-medium text-muted-foreground">Hotel</th>
                <th className="text-right py-2 font-medium text-muted-foreground">% of Gross</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Flat</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Incentive</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Employees</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Total Bonus</th>
                <th className="py-2 w-24" />
              </tr>
            </thead>
            <tbody>
              {savedSummary.map(s => (
                <tr key={s.hotel.id} className={`border-b last:border-0 ${s.hotel.id === hotelFilter ? 'bg-primary/5' : ''}`}>
                  <td className="py-2 font-medium">
                    {s.hotel.name}
                    <span className="ml-1.5 text-xs text-muted-foreground font-normal">{s.hotel.short_code}</span>
                  </td>
                  <td className="py-2 text-right font-mono text-green-700">{s.pct ? `${s.pct}%` : '—'}</td>
                  <td className="py-2 text-right font-mono">{s.flat ? fmtCurrency(parseFloat(s.flat), s.hotel.country) : '—'}</td>
                  <td className="py-2 text-right text-muted-foreground text-xs">
                    {s.incentiveCount > 0 ? `${s.incentiveCount} on gross × multiplier` : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">{s.count}</td>
                  <td className="py-2 text-right font-mono text-amber-700">
                    {s.bonus > 0 ? fmtCurrency(s.bonus, s.hotel.country) : '—'}
                  </td>
                  <td className="py-2 text-center">
                    <div className="flex items-center justify-center gap-3">
                      <button onClick={() => setHotelFilter(s.hotel.id)} className="text-xs text-primary hover:underline">
                        Edit
                      </button>
                      <button
                        onClick={() => deleteDraft(s.hotel.id)}
                        title="Delete this hotel's saved bonus"
                        className="text-destructive hover:opacity-70 transition-opacity"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Controls ── */}
      <div className="bg-white rounded-xl border p-5 mb-6">
        <div className="flex gap-4 items-end flex-wrap">

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Hotel</label>
            <select
              value={hotelFilter}
              onChange={e => setHotelFilter(e.target.value)}
              className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white min-w-[200px]"
            >
              {hotels.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}{hotelSettings.has(h.id) ? ' ✓' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Bonus Year</label>
            <input
              type="number" min="2020" max="2099"
              value={bonusYear}
              onChange={e => setBonusYear(Number(e.target.value))}
              className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-24 font-mono"
            />
          </div>

          <div className="h-px w-px mx-1 self-stretch" aria-hidden />

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">% of Gross</label>
            <div className="relative">
              <input
                type="number" min="0" max="1000" step="0.1"
                value={pct}
                onChange={e => setPct(e.target.value)}
                placeholder="e.g. 100"
                className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-28 pr-7"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Flat Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{currencySym}</span>
              <input
                type="number" min="0" step="1"
                value={flat}
                onChange={e => setFlat(e.target.value)}
                placeholder="e.g. 500"
                className="rounded-md border border-input pl-7 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-32"
              />
            </div>
          </div>

          <button
            onClick={saveHotelSettings}
            disabled={!hotelFilter || saving}
            className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors self-end"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving…' : saveFlash ? 'Saved ✓' : `Save${currentHotel ? ` — ${currentHotel.short_code ?? currentHotel.name}` : ''}`}
          </button>
        </div>

        {(pct || flat || totals.incentiveCount > 0) && (
          <p className="mt-3 text-xs text-muted-foreground">
            Formula per employee:
            <span className="font-mono ml-1 text-foreground">
              factor = months service at 31 Dec {bonusYear} ÷ 12 (max 1; under 6 months = 0)
              {' · '}
              bonus = gross × factor{pct ? ` × ${pct}%` : ''}{flat ? ` + ${flat} flat × factor` : ''}
              {totals.incentiveCount > 0 && ` · incentive employees: bonus = gross as at July ${bonusYear} × factor × incentive multiplier`}
            </span>
          </p>
        )}
      </div>

      {/* ── Impact summary ── */}
      {bonusRows.length > 0 && (
        <>
          <div className="grid grid-cols-4 gap-4 mb-6">
            <ImpactCard label="Employees Paid"     value={`${totals.paidCount} of ${totals.count}`} />
            <ImpactCard label="Current Gross / mo" value={fmtCurrency(totals.currentGross, country)} />
            <ImpactCard label="Total Bonus"        value={fmtCurrency(totals.bonus, country)} highlight />
            <ImpactCard
              label="Bonus as % of Monthly Gross"
              value={totals.currentGross > 0 ? `${(totals.bonus / totals.currentGross * 100).toFixed(1)}%` : '—'}
              highlight
            />
          </div>

          {overrideCount > 0 && (
            <div className="flex items-center gap-2 mb-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 w-fit">
              <span className="h-2 w-2 rounded-full bg-amber-400 inline-block" />
              {overrideCount} employee{overrideCount > 1 ? 's' : ''} with individual overrides
              <button onClick={() => setOverrides(new Map())} className="ml-2 underline hover:no-underline">
                Clear all
              </button>
            </div>
          )}

          {/* ── Line-by-line table ── */}
          <div className="bg-white rounded-xl border overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Emp Code</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Employee</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Mths Service (Dec)</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Factor</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current Gross</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground" title="Gross the bonus is calculated on. Incentive employees use the gross as at July of the bonus year.">Bonus Base</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">% of Gross</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Flat</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Bonus Amount</th>
                  <th className="px-4 py-3 w-12 text-center font-medium text-muted-foreground text-xs" title="Exclude from bonus">Excl.</th>
                  <th className="px-4 py-3 w-10" />
                </tr>
              </thead>
              <tbody>
                {bonusRows.map((r, i) => (
                  <React.Fragment key={r.employee.id}>
                    <tr className={`border-b ${r.isExcluded ? 'opacity-45' : editingId === r.employee.id ? 'bg-amber-50' : i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{r.employee.employee_code ?? '—'}</td>
                      <td className="px-4 py-2.5 font-medium">
                        <div className="flex items-center gap-2">
                          {r.employee.surname}, {r.employee.first_name}
                          {r.isExcluded && (
                            <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs font-medium">
                              excluded
                            </span>
                          )}
                          {r.incentiveMultiplier != null && !r.isExcluded && (
                            <span className="inline-flex items-center rounded-full bg-violet-100 text-violet-700 px-2 py-0.5 text-xs font-medium">
                              incentive ×{r.incentiveMultiplier}
                            </span>
                          )}
                          {r.hasOverride && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-medium">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                              custom
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">
                        {r.monthsService ?? <span className="text-red-600 text-xs font-sans">no start date</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {r.factor === 0
                          ? <span className="text-xs font-sans text-red-600">not eligible</span>
                          : r.factor < 1
                            ? <span className="text-blue-700">{r.factor.toFixed(4)}</span>
                            : '1.0000'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCurrency(r.currentGross, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {r.basePeriod ? (
                          <div className="leading-tight">
                            <div className="text-violet-700">{fmtCurrency(r.baseGross, r.hotel.country)}</div>
                            <div className="text-[10px] text-muted-foreground font-sans">@ {r.basePeriod}</div>
                          </div>
                        ) : r.baseIsException ? (
                          <div className="leading-tight">
                            <div>{fmtCurrency(r.baseGross, r.hotel.country)}</div>
                            <div className="text-[10px] text-muted-foreground font-sans">current gross (exception)</div>
                          </div>
                        ) : fmtCurrency(r.baseGross, r.hotel.country)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-700">
                        {r.isExcluded ? <span className="text-muted-foreground">—</span> : `${(r.effectivePct * 100).toFixed(1)}%`}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {r.effectiveFlat > 0 && !r.isExcluded ? fmtCurrency(r.effectiveFlat, r.hotel.country) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold">
                        {r.bonusAmount > 0 ? fmtCurrency(r.bonusAmount, r.hotel.country) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={r.isExcluded}
                          onChange={() => setExcluded(prev => {
                            const n = new Set(prev);
                            n.has(r.employee.id) ? n.delete(r.employee.id) : n.add(r.employee.id);
                            return n;
                          })}
                          title="Exclude from bonus"
                          className="rounded cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          onClick={() => editingId === r.employee.id ? setEditingId(null) : startEdit(r.employee)}
                          disabled={r.isExcluded}
                          title="Override for this employee"
                          className={`rounded p-1 transition-colors disabled:opacity-30 ${editingId === r.employee.id ? 'bg-amber-200 text-amber-800' : 'hover:bg-muted text-muted-foreground hover:text-foreground'}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>

                    {editingId === r.employee.id && (
                      <tr className="border-b bg-amber-50">
                        <td colSpan={11} className="px-4 py-3">
                          <div className="flex items-end gap-4 flex-wrap">
                            <span className="text-xs font-semibold text-amber-800 uppercase tracking-wide self-center">
                              Override — {r.employee.first_name} {r.employee.surname}
                            </span>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground block mb-1">
                                Custom % <span className="font-normal">(blank = use hotel rate)</span>
                              </label>
                              <div className="relative">
                                <input
                                  type="number" min="0" max="1000" step="0.1"
                                  value={editDraft.pct}
                                  onChange={e => setEditDraft(d => ({ ...d, pct: e.target.value }))}
                                  placeholder={String((r.effectivePct * 100).toFixed(1))}
                                  className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-400 w-28 pr-7"
                                />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                              </div>
                            </div>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground block mb-1">
                                Custom flat <span className="font-normal">(blank = use hotel flat)</span>
                              </label>
                              <input
                                type="number" min="0" step="1"
                                value={editDraft.flat}
                                onChange={e => setEditDraft(d => ({ ...d, flat: e.target.value }))}
                                placeholder={r.effectiveFlat ? String(r.effectiveFlat) : '0'}
                                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-400 w-32"
                              />
                            </div>
                            <div className="flex gap-2 self-end">
                              <button
                                onClick={() => applyEdit(r.employee.id)}
                                className="flex items-center gap-1.5 rounded-md bg-amber-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-amber-700 transition-colors"
                              >
                                <Check className="h-3.5 w-3.5" /> Apply
                              </button>
                              {r.hasOverride && (
                                <button
                                  onClick={() => clearOverride(r.employee.id)}
                                  className="flex items-center gap-1.5 rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium hover:bg-amber-100 transition-colors text-amber-800"
                                >
                                  <X className="h-3.5 w-3.5" /> Clear override
                                </button>
                              )}
                              <button
                                onClick={() => setEditingId(null)}
                                className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/20 font-semibold">
                  <td className="px-4 py-3" colSpan={4}>
                    Totals ({totals.count} employees{totals.excludedCount > 0 ? `, ${totals.excludedCount} excluded` : ''}
                    {totals.ineligibleCount > 0 ? `, ${totals.ineligibleCount} not eligible` : ''}
                    {totals.proRataCount > 0 ? `, ${totals.proRataCount} pro rata` : ''})
                  </td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-right font-mono">{fmtCurrency(totals.currentGross, country)}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtCurrency(bonusRows.reduce((a, r) => a + r.baseGross, 0), country)}</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-right font-mono">{totals.totalFlat > 0 ? fmtCurrency(totals.totalFlat, country) : '—'}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtCurrency(totals.bonus, country)}</td>
                  <td className="px-4 py-3" colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {bonusRows.length === 0 && hasAnyInput && (
        <p className="text-muted-foreground text-sm mb-6">
          No employees match the selected filters, or no salary data has been imported yet.
        </p>
      )}

      {!hasAnyInput && (
        <p className="text-muted-foreground text-sm mb-6">
          Enter a % of gross or a flat amount above to see the bonus schedule for this hotel.
        </p>
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
