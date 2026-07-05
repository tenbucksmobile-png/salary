'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Hotel, Employee, SalaryRecord } from '@/types/database';
import { fmtZAR, fmtCurrency, MONTH_NAMES, sortHotels } from '@/lib/utils';
import { TrendingUp, CheckCircle, Pencil, X, Check, Download, Save, Trash2, ChevronDown } from 'lucide-react';
import { calculateBurden, BurdenResult } from '@/lib/payroll-calc';
import { exportSalaryReview, ExportHotel, BenchmarkData } from '@/lib/excel-export';

const GRADE_OPTIONS = ['All Grades', 'ANO', 'FTC', 'DNQ', 'Frontline', 'Supervisory', 'Management', 'Executive', 'Flexible'];

interface Override {
  pct: string;
  flat: string;
}

interface HotelSettings {
  pct: string;
  flat: string;
  excludedGrades: Set<string>;
  threshold: string;
  belowPct: string;
  belowFlat: string;
  abovePct: string;
  aboveFlat: string;
  overrides: Map<string, Override>;
  excluded: Set<string>;
}

interface ForecastRow {
  employee: Employee;
  hotel: Hotel;
  currentGross: number;     // total_earnings — the base on which % increase is applied
  currentBasic: number;
  newBasic: number;
  newTotalEarnings: number;
  increaseAmount: number;
  currentCtc: number;
  newCtc: number;
  effectivePct: number;
  effectiveFlat: number;
  hasOverride: boolean;
  isExcluded: boolean;
  burden: BurdenResult;
}

function computeRows(
  hotelId: string,
  settings: HotelSettings,
  employees: Employee[],
  hotelMap: Map<string, Hotel>,
  latestSalary: Map<string, SalaryRecord>,
): ForecastRow[] {
  const gPct         = parseFloat(settings.pct) / 100;
  const gFlat        = parseFloat(settings.flat) || 0;
  const hasGlobalPct = !isNaN(gPct) && parseFloat(settings.pct) > 0;
  const thresh       = parseFloat(settings.threshold) || 0;
  const hasThreshold = thresh > 0;

  if (!hasGlobalPct && gFlat === 0 && !hasThreshold && settings.overrides.size === 0 && settings.excluded.size === 0) return [];

  return employees
    .filter(e => e.hotel_id === hotelId)
    .map(e => {
      const sal   = latestSalary.get(e.id);
      const hotel = hotelMap.get(e.hotel_id);
      if (!sal || !hotel) return null;

      const currentBasic = sal.basic_salary;
      const currentGross = sal.total_earnings;   // Gross = base on which % increase is calculated
      const currentCtc   = sal.ctc;
      const isExcluded   = settings.excluded.has(e.id) || settings.excludedGrades.has(e.grade_label ?? '');
      const ov           = settings.overrides.get(e.id);

      // Threshold compares against basic salary (the threshold field is labelled "Threshold Basic")
      const inLower  = hasThreshold && currentBasic < thresh;
      const belowPctVal  = settings.belowPct  !== '' ? parseFloat(settings.belowPct)  / 100 || 0 : 0;
      const belowFlatVal = settings.belowFlat !== '' ? parseFloat(settings.belowFlat) || 0        : 0;
      const abovePctVal  = settings.abovePct  !== '' ? parseFloat(settings.abovePct)  / 100 || 0 : (hasGlobalPct ? gPct : 0);
      const aboveFlatVal = settings.aboveFlat !== '' ? parseFloat(settings.aboveFlat) || 0        : gFlat;
      const basePct  = hasThreshold ? (inLower ? belowPctVal  : abovePctVal)  : (hasGlobalPct ? gPct : 0);
      const baseFlat = hasThreshold ? (inLower ? belowFlatVal : aboveFlatVal) : gFlat;

      const effectivePct  = isExcluded ? 0 : (ov && ov.pct  !== '' ? (parseFloat(ov.pct)  || 0) / 100 : basePct);
      const effectiveFlat = isExcluded ? 0 : (ov && ov.flat !== '' ? (parseFloat(ov.flat) || 0)        : baseFlat);

      // Increase is calculated on Gross (total_earnings) and added to basic_salary
      const increaseOnGross  = currentGross * effectivePct + effectiveFlat;
      const newBasic         = isExcluded ? currentBasic : Math.round((currentBasic + increaseOnGross) / 10) * 10;
      const newTotalEarnings = currentGross + (newBasic - currentBasic);

      const empYrs = e.employment_date
        ? Math.floor((Date.now() - new Date(e.employment_date).getTime()) / (1000 * 60 * 60 * 24 * 365.25))
        : 0;

      const burden = calculateBurden({
        basic: newBasic, totalEarnings: newTotalEarnings,
        jobTitle: e.job_title, country: hotel.country,
        wcaRate: hotel.wca_rate ?? 0, hotelShortCode: hotel.short_code,
        yearsOfService: empYrs,
        severanceApplicable: e.severance_applicable,
        incentiveApplicable: e.incentive_applicable,
        incentiveMultiplier: e.incentive_multiplier,
        gratuityApplicable:  e.gratuity_applicable,
        gratuityRate:        e.gratuity_rate,
        taxPaye: sal.tax_paye, medicalEmployee: sal.medical_employee,
        medicalCompany: sal.medical_company, ancillaEmployee: sal.ancilla_employee,
        ancillaCompany: sal.ancilla_company, leaveProvision: sal.leave_provision,
        otherCompanyContrib: sal.other_company_contrib, mgmtIncentive: sal.mgmt_incentive,
        bonusAccrualDec: sal.bonus_accrual_dec, bonusAccrualJuly: sal.bonus_accrual_july,
        providentEeRate:       hotel.provident_ee_rate        ?? undefined,
        providentErRate:       hotel.provident_er_rate        ?? undefined,
        providentErRateSenior: hotel.provident_er_rate_senior ?? undefined,
        uifRate:               hotel.uif_rate                 ?? undefined,
        uifCap:                hotel.uif_cap                  ?? undefined,
        sdlRate:               hotel.sdl_rate                 ?? undefined,
        mealsStandard:         hotel.meals_standard           ?? undefined,
        mealsManager:          hotel.meals_manager            ?? undefined,
        leaveDays:             hotel.leave_days               ?? undefined,
        bonusDays:             hotel.bonus_days               ?? undefined,
        ctcProvidentEr:        hotel.ctc_provident_er         ?? undefined,
        ctcUifEr:              hotel.ctc_uif_er               ?? undefined,
        ctcSdl:                hotel.ctc_sdl                  ?? undefined,
        ctcWca:                hotel.ctc_wca                  ?? undefined,
        ctcMeals:              hotel.ctc_meals                ?? undefined,
        ctcLeaveAccrual:       hotel.ctc_leave_accrual        ?? undefined,
        ctcBonus:              hotel.ctc_bonus                ?? undefined,
        leaveAccrualPct:       hotel.leave_accrual_pct        ?? undefined,
        bonusProvisionPct:     hotel.bonus_provision_pct      ?? undefined,
      });

      return {
        employee: e, hotel, currentGross, currentBasic, newBasic, newTotalEarnings,
        increaseAmount: newBasic - currentBasic, currentCtc,
        newCtc: burden.ctc,
        effectivePct, effectiveFlat, hasOverride: !!ov && !isExcluded, isExcluded, burden,
      };
    })
    .filter((r): r is ForecastRow => r !== null && r.currentBasic > 0)
    .sort((a, b) =>
      a.employee.surname.localeCompare(b.employee.surname) ||
      a.employee.first_name.localeCompare(b.employee.first_name));
}

export default function SalaryReviewPage() {
  const sb = createClient();

  const [hotels, setHotels]             = useState<Hotel[]>([]);
  const [employees, setEmployees]       = useState<Employee[]>([]);
  const [latestSalary, setLatestSalary] = useState<Map<string, SalaryRecord>>(new Map());

  const [hotelFilter, setHotelFilter] = useState('');

  const [pct,       setPct]       = useState('');
  const [flat,      setFlat]      = useState('');
  const [excludedGrades, setExcludedGrades] = useState<Set<string>>(new Set());
  const [gradeDropdownOpen, setGradeDropdownOpen] = useState(false);
  const gradeDropdownRef = useRef<HTMLDivElement>(null);
  const [threshold, setThreshold] = useState('');
  const [belowPct,  setBelowPct]  = useState('');
  const [belowFlat, setBelowFlat] = useState('');
  const [abovePct,  setAbovePct]  = useState('');
  const [aboveFlat, setAboveFlat] = useState('');
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const [excluded,  setExcluded]  = useState<Set<string>>(new Set());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Override>({ pct: '', flat: '' });

  const [hotelSettings, setHotelSettings] = useState<Map<string, HotelSettings>>(new Map());
  const hotelSettingsRef = useRef<Map<string, HotelSettings>>(new Map());

  // Per-hotel draft scenario IDs (from DB)
  const [hotelDraftIds, setHotelDraftIds] = useState<Map<string, string>>(new Map());
  const hotelDraftIdsRef = useRef<Map<string, string>>(new Map());

  const [saving,     setSaving]     = useState(false);
  const [saveFlash,  setSaveFlash]  = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed,  setCommitted]  = useState(false);
  const [commitMonth, setCommitMonth] = useState(() => new Date().getMonth() + 1);
  const [commitYear,  setCommitYear]  = useState(() => new Date().getFullYear());
  const [exporting,  setExporting]  = useState(false);

  useEffect(() => {
    async function load() {
      const [{ data: h }, { data: e }, { data: s }, { data: drafts }] = await Promise.all([
        sb.from('hotels').select('*'),
        sb.from('employees').select('*').eq('status', 'active'),
        sb.from('salary_records').select('*'),
        sb.from('increase_scenarios').select('id, hotel_id, settings_json').eq('status', 'draft').not('hotel_id', 'is', null),
      ]);
      const hotelList = sortHotels((h ?? []) as Hotel[]);
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

      // Reconstruct per-hotel settings from drafts
      const settingsMap = new Map<string, HotelSettings>();
      const draftIds    = new Map<string, string>();
      for (const draft of (drafts ?? [])) {
        if (!draft.hotel_id || !draft.settings_json) continue;
        const s2 = draft.settings_json as Record<string, unknown>;
        settingsMap.set(draft.hotel_id, {
          pct:       (s2.pct       as string) ?? '',
          flat:      (s2.flat      as string) ?? '',
          excludedGrades: new Set<string>((s2.excludedGrades as string[]) ?? []),
          threshold: (s2.threshold as string) ?? '',
          belowPct:  (s2.belowPct  as string) ?? '',
          belowFlat: (s2.belowFlat as string) ?? '',
          abovePct:  (s2.abovePct  as string) ?? '',
          aboveFlat: (s2.aboveFlat as string) ?? '',
          overrides: new Map(Object.entries((s2.overrides as Record<string, Override>) ?? {})),
          excluded:  new Set<string>((s2.excluded as string[]) ?? []),
        });
        draftIds.set(draft.hotel_id, draft.id as string);
      }

      // Set refs before any state setter so the hotelFilter effect sees populated refs
      hotelSettingsRef.current = settingsMap;
      hotelDraftIdsRef.current = draftIds;

      setHotels(hotelList);
      setEmployees(empList);
      setLatestSalary(salMap);
      setHotelSettings(settingsMap);
      setHotelDraftIds(draftIds);
      if (hotelList.length > 0) setHotelFilter(prev => prev || hotelList[0].id);
    }
    load();
  }, []);

  // When the selected hotel changes, load its saved settings (or clear)
  useEffect(() => {
    if (!hotelFilter) return;
    const saved = hotelSettingsRef.current.get(hotelFilter);
    setPct(saved?.pct ?? '');
    setFlat(saved?.flat ?? '');
    setExcludedGrades(new Set(saved?.excludedGrades ?? []));
    setThreshold(saved?.threshold ?? '');
    setBelowPct(saved?.belowPct  ?? '');
    setBelowFlat(saved?.belowFlat ?? '');
    setAbovePct(saved?.abovePct  ?? '');
    setAboveFlat(saved?.aboveFlat ?? '');
    setOverrides(new Map(saved?.overrides ?? []));
    setExcluded(new Set(saved?.excluded ?? []));
    setEditingId(null);
    setCommitted(false);
  }, [hotelFilter]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (gradeDropdownRef.current && !gradeDropdownRef.current.contains(e.target as Node)) {
        setGradeDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const hotelMap = useMemo(() => new Map(hotels.map(h => [h.id, h])), [hotels]);

  const forecastRows = useMemo((): ForecastRow[] => {
    if (!hotelFilter) return [];
    const liveSetting: HotelSettings = { pct, flat, excludedGrades, threshold, belowPct, belowFlat, abovePct, aboveFlat, overrides, excluded };
    return computeRows(hotelFilter, liveSetting, employees, hotelMap, latestSalary);
  }, [hotelFilter, pct, flat, excludedGrades, threshold, belowPct, belowFlat, abovePct, aboveFlat, overrides, excluded, employees, hotelMap, latestSalary]);

  const totals = useMemo(() => ({
    currentGross:   forecastRows.reduce((s, r) => s + r.currentGross,    0),
    newGross:       forecastRows.reduce((s, r) => s + r.newTotalEarnings, 0),
    currentBasic:   forecastRows.reduce((s, r) => s + r.currentBasic,    0),
    newBasic:       forecastRows.reduce((s, r) => s + r.newBasic,         0),
    increaseAmount: forecastRows.reduce((s, r) => s + r.increaseAmount,   0),
    totalFlat:      forecastRows.reduce((s, r) => s + r.effectiveFlat,    0),
    currentCtc:     forecastRows.reduce((s, r) => s + r.currentCtc,       0),
    newCtc:         forecastRows.reduce((s, r) => s + r.newCtc,           0),
    count:          forecastRows.length,
    excludedCount:  forecastRows.filter(r => r.isExcluded).length,
  }), [forecastRows]);

  const savedSummary = useMemo(() =>
    hotels
      .filter(h => hotelSettings.has(h.id))
      .map(h => {
        const s    = hotelSettings.get(h.id)!;
        const rows = computeRows(h.id, s, employees, hotelMap, latestSalary);
        return {
          hotel:     h,
          pct:       s.pct,
          flat:      s.flat,
          excludedGrades: s.excludedGrades ?? new Set<string>(),
          threshold: s.threshold ?? '',
          // Only employees genuinely affected by this increase — not excluded
          // AND actually receiving a nonzero adjustment. A threshold scenario
          // can leave an included employee at 0 (e.g. below-threshold band
          // set to 0%), and those shouldn't count as "effected" here.
          count:     rows.filter(r => !r.isExcluded && r.increaseAmount > 0).length,
          currentBasic:   rows.reduce((a, r) => a + r.currentBasic,   0),
          newBasic:       rows.reduce((a, r) => a + r.newBasic,        0),
          increaseAmount: rows.reduce((a, r) => a + r.increaseAmount,  0),
        };
      }),
    [hotels, hotelSettings, employees, hotelMap, latestSalary],
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
      const hotel = hotelMap.get(hotelFilter)!;
      const entry: HotelSettings = { pct, flat, excludedGrades: new Set(excludedGrades), threshold, belowPct, belowFlat, abovePct, aboveFlat, overrides: new Map(overrides), excluded: new Set(excluded) };

      const settingsJson = {
        pct, flat, excludedGrades: [...excludedGrades], threshold, belowPct, belowFlat, abovePct, aboveFlat,
        overrides: Object.fromEntries([...overrides.entries()]),
        excluded:  [...excluded],
      };

      const rows = computeRows(hotelFilter, entry, employees, hotelMap, latestSalary);
      let scenarioId: string = hotelDraftIdsRef.current.get(hotelFilter) ?? '';

      if (scenarioId) {
        // Update existing draft
        await sb.from('increase_scenarios').update({
          name:           `Draft — ${hotel.name}`,
          settings_json:  settingsJson,
          effective_date: new Date().toISOString().split('T')[0],
        }).eq('id', scenarioId);
        await sb.from('scenario_lines').delete().eq('scenario_id', scenarioId);
      } else {
        // Create new draft for this hotel
        const { data: newScenario } = await sb.from('increase_scenarios').insert({
          name:           `Draft — ${hotel.name}`,
          hotel_id:       hotelFilter,
          status:         'draft',
          effective_date: new Date().toISOString().split('T')[0],
          settings_json:  settingsJson,
        }).select('id').single();
        scenarioId = (newScenario as { id: string }).id;
      }

      // Insert scenario_lines for non-excluded employees
      const lines = rows.filter(r => !r.isExcluded).map(r => ({
        scenario_id:     scenarioId,
        employee_id:     r.employee.id,
        hotel_id:        hotelFilter,
        increase_pct:    r.effectivePct,
        current_basic:   r.currentBasic,
        new_basic:       r.newBasic,
        increase_amount: r.increaseAmount,
        current_ctc:     r.currentCtc,
        new_ctc:         r.newCtc,
      }));
      if (lines.length > 0) await sb.from('scenario_lines').insert(lines);

      // Update in-memory state
      const nextSettings = new Map(hotelSettingsRef.current).set(hotelFilter, entry);
      hotelSettingsRef.current = nextSettings;
      setHotelSettings(nextSettings);

      const nextDraftIds = new Map(hotelDraftIdsRef.current).set(hotelFilter, scenarioId);
      hotelDraftIdsRef.current = nextDraftIds;
      setHotelDraftIds(nextDraftIds);

      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  // ── Delete a hotel's draft from DB ────────────────────────────────────────

  async function deleteDraft(hotelId: string) {
    const scenarioId = hotelDraftIdsRef.current.get(hotelId);
    if (!scenarioId) return;

    await sb.from('scenario_lines').delete().eq('scenario_id', scenarioId);
    await sb.from('increase_scenarios').delete().eq('id', scenarioId);

    const nextSettings = new Map(hotelSettingsRef.current);
    nextSettings.delete(hotelId);
    hotelSettingsRef.current = nextSettings;
    setHotelSettings(nextSettings);

    const nextDraftIds = new Map(hotelDraftIdsRef.current);
    nextDraftIds.delete(hotelId);
    hotelDraftIdsRef.current = nextDraftIds;
    setHotelDraftIds(nextDraftIds);

    // If we're on this hotel's tab, clear the form
    if (hotelFilter === hotelId) {
      setPct(''); setFlat(''); setExcludedGrades(new Set());
      setThreshold(''); setBelowPct(''); setBelowFlat(''); setAbovePct(''); setAboveFlat('');
      setOverrides(new Map()); setExcluded(new Set());
    }
  }

  // ── Commit all saved hotels to payroll ────────────────────────────────────

  async function commitAll() {
    if (hotelSettings.size === 0) return;
    setCommitting(true);
    const now = new Date();

    for (const [hotelId, settings] of hotelSettings) {
      const hotel = hotelMap.get(hotelId);
      const rows  = computeRows(hotelId, settings, employees, hotelMap, latestSalary);

      for (const r of rows) {
        if (r.isExcluded) continue;
        const sal = latestSalary.get(r.employee.id);
        if (!sal) continue;

        await sb.from('salary_records').upsert({
          employee_id:           r.employee.id,
          import_id:             null,
          period_month:          commitMonth,
          period_year:           commitYear,
          basic_salary:          r.newBasic,
          allowances:            sal.allowances,
          total_earnings:        r.newTotalEarnings,
          tax_paye:              sal.tax_paye,
          uif_employee:          sal.uif_employee,
          provident_employee:    sal.provident_employee,
          medical_employee:      sal.medical_employee,
          ancilla_employee:      sal.ancilla_employee,
          total_deductions:      sal.total_deductions,
          net_salary:            r.newTotalEarnings - sal.total_deductions,
          uif_company:           r.burden.uif_company,
          provident_company:     r.burden.provident_company,
          sdl_company:           r.burden.sdl_company,
          wca_company:           r.burden.wca_company,
          staff_meals:           r.burden.staff_meals,
          leave_days:            r.burden.leave_days,
          leave_accrual:         r.burden.leave_accrual,
          total_company_contrib: r.burden.total_company_contrib,
          total_payroll_burden:  r.burden.total_payroll_burden,
          total_cost:            r.burden.total_cost,
          medical_company:       sal.medical_company,
          ancilla_company:       sal.ancilla_company,
          other_company_contrib: sal.other_company_contrib,
          bonus_provision:       r.burden.bonus_provision,
          leave_provision:       sal.leave_provision,
          mgmt_incentive:        sal.mgmt_incentive,
          bonus_accrual_dec:     sal.bonus_accrual_dec,
          bonus_accrual_july:    sal.bonus_accrual_july,
          ctc:                   r.newCtc,
          increase_pct:          r.effectivePct * 100,
          increase_amount:       r.increaseAmount,
          adjustment:            r.effectiveFlat,
          new_basic:             r.newBasic,
          new_ctc:               r.newCtc,
        }, { onConflict: 'employee_id,period_year,period_month' });
      }

      // Promote the draft scenario to committed
      const scenarioId = hotelDraftIdsRef.current.get(hotelId);
      if (scenarioId) {
        await sb.from('increase_scenarios').update({
          status:          'committed',
          committed_at:    now.toISOString(),
          effective_month: commitMonth,
          effective_year:  commitYear,
          applied_at:      now.toISOString(),
          name:            `Salary Review — ${hotel?.name ?? ''} — ${MONTH_NAMES[commitMonth - 1]} ${commitYear}`,
        }).eq('id', scenarioId);
      }
    }

    // Persist committed increases to Inflation & Increase History (localStorage)
    try {
      const raw = localStorage.getItem('ihg-salary-increases');
      const stored: Record<string, Record<string, { pct: string; flat: string }>> =
        raw ? JSON.parse(raw) : {};
      for (const [hotelId, settings] of hotelSettings) {
        if (!stored[hotelId]) stored[hotelId] = {};
        stored[hotelId][String(commitYear)] = { pct: settings.pct, flat: settings.flat };
      }
      localStorage.setItem('ihg-salary-increases', JSON.stringify(stored));
    } catch {}

    // Clear all draft state after commit
    hotelSettingsRef.current = new Map();
    setHotelSettings(new Map());
    hotelDraftIdsRef.current = new Map();
    setHotelDraftIds(new Map());

    setCommitting(false);
    setCommitted(true);
  }

  // ── Excel export ───────────────────────────────────────────────────────────

  async function handleExport() {
    setExporting(true);
    try {
      const activeHotelIds = new Set(employees.map(e => e.hotel_id));

      const exportHotels: ExportHotel[] = hotels
        .filter(h => activeHotelIds.has(h.id))
        .map(h => {
          const settings = hotelSettings.get(h.id) ?? { pct: '', flat: '', excludedGrades: new Set<string>(), threshold: '', belowPct: '', belowFlat: '', abovePct: '', aboveFlat: '', overrides: new Map(), excluded: new Set<string>() };
          const rows     = computeRows(h.id, settings, employees, hotelMap, latestSalary);
          return {
            id:        h.id,
            name:      h.name,
            shortCode: h.short_code ?? h.name,
            country:   h.country,
            increase:  { pct: settings.pct, flat: settings.flat },
            rows: [...rows].sort((a, b) => {
              const s = a.employee.surname.localeCompare(b.employee.surname, undefined, { sensitivity: 'base' });
              return s !== 0 ? s : a.employee.first_name.localeCompare(b.employee.first_name, undefined, { sensitivity: 'base' });
            }).map(r => ({
              surname:       r.employee.surname,
              firstName:     r.employee.first_name,
              jobTitle:      r.employee.job_title ?? '',
              grade:         r.employee.grade_label ?? '',
              department:    r.employee.department_code ?? '',
              currentGross:  r.currentGross,
              currentBasic:  r.currentBasic,
              effectivePct:  r.effectivePct,
              effectiveFlat: r.effectiveFlat,
              newBasic:      r.newBasic,
              currentCtc:    r.currentCtc,
              newCtc:        r.newCtc,
            })),
          };
        });

      const unsaved = hotels
        .filter(h => activeHotelIds.has(h.id) && !hotelSettings.has(h.id))
        .map(h => h.name);

      if (unsaved.length > 0) {
        const proceed = window.confirm(
          `The following hotels have no saved increase:\n\n• ${unsaved.join('\n• ')}\n\nThey will appear with 0% in the export. Continue?`
        );
        if (!proceed) return;
      }

      const allEmployeesHaveData = exportHotels.some(h => h.rows.length > 0);
      if (!allEmployeesHaveData) {
        alert('No salary data found. Please import employee salary records before exporting.');
        return;
      }

      // Read benchmark data saved on the Dashboard page
      let benchmark: BenchmarkData | undefined;
      try {
        const rawCpi  = localStorage.getItem('ihg-salary-cpi');
        const rawInc  = localStorage.getItem('ihg-salary-increases');
        const rawNmw  = localStorage.getItem('ihg-salary-nmw');
        const notes   = localStorage.getItem('ihg-salary-increase-notes') ?? '';
        const month   = localStorage.getItem('ihg-salary-cpi-month') ?? 'July';
        if (rawCpi || rawInc) {
          // Migrate legacy string values to { pct, flat } shape
          const parsedInc = rawInc
            ? JSON.parse(rawInc) as Record<string, Record<string, unknown>>
            : {};
          const increases: BenchmarkData['increases'] = {};
          for (const [hid, years] of Object.entries(parsedInc)) {
            increases[hid] = {};
            for (const [yr, val] of Object.entries(years)) {
              increases[hid][yr] = (val && typeof val === 'object' && 'pct' in val)
                ? val as BenchmarkData['increases'][string][string]
                : { pct: typeof val === 'string' ? val : '', flat: '' };
            }
          }
          benchmark = {
            cpi:      rawCpi ? JSON.parse(rawCpi) as BenchmarkData['cpi'] : {},
            increases,
            nmw:      rawNmw ? JSON.parse(rawNmw) as BenchmarkData['nmw'] : {},
            notes,
            cpiMonth: month,
            hotels: hotels.map(h => ({ id: h.id, name: h.name })),
          };
        }
      } catch { /* skip benchmark if localStorage is unavailable */ }

      const date     = new Date().toISOString().slice(0, 10);
      const filename = `IHG_Salary_Review_${date}.xlsx`;
      await exportSalaryReview(exportHotels, filename, benchmark);
    } finally {
      setExporting(false);
    }
  }

  const currentHotel   = hotelMap.get(hotelFilter);
  const hasAnyInput    = (parseFloat(pct) > 0) || (parseFloat(flat) > 0) || (parseFloat(threshold) > 0) || overrides.size > 0;
  const isSaved        = hotelSettings.has(hotelFilter) && (() => {
    const s = hotelSettings.get(hotelFilter)!;
    return s.pct === pct && s.flat === flat &&
      s.excludedGrades.size === excludedGrades.size && [...s.excludedGrades].every(g => excludedGrades.has(g)) &&
      s.threshold === threshold && s.belowPct === belowPct && s.belowFlat === belowFlat &&
      s.abovePct === abovePct && s.aboveFlat === aboveFlat;
  })();
  const overrideCount  = forecastRows.filter(r => r.hasOverride).length;

  return (
    <div className="p-8">
      <div className="mb-8 flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Salary Review</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Set increases per hotel, save each one, then export or commit to payroll
          </p>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          {/* Export — always available */}
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 rounded-md border border-input bg-white px-5 py-2.5 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {exporting ? 'Building Excel…' : 'Export to Excel'}
          </button>

          {/* Commit — only when scenarios are saved */}
          {savedSummary.length > 0 && (
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Effective Month</label>
                <select
                  value={commitMonth}
                  onChange={e => { setCommitMonth(Number(e.target.value)); setCommitted(false); }}
                  className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
                >
                  {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Year</label>
                <input
                  type="number" min="2020" max="2099"
                  value={commitYear}
                  onChange={e => { setCommitYear(Number(e.target.value)); setCommitted(false); }}
                  className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-28 font-mono"
                />
              </div>
              {!committed ? (
                <button
                  onClick={commitAll}
                  disabled={committing}
                  className="flex items-center gap-2 rounded-md bg-green-700 text-white px-5 py-2.5 text-sm font-medium hover:bg-green-800 disabled:opacity-50 transition-colors"
                >
                  <TrendingUp className="h-4 w-4" />
                  {committing ? 'Committing…' : `Commit to Payroll — ${MONTH_NAMES[commitMonth - 1]} ${commitYear}`}
                </button>
              ) : (
                <div className="flex items-center gap-2 text-green-700 font-medium text-sm pb-2">
                  <CheckCircle className="h-5 w-5" />
                  Salary records updated for {MONTH_NAMES[commitMonth - 1]} {commitYear}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Saved hotels summary ── */}
      {savedSummary.length > 0 && (
        <div className="mb-6 bg-white rounded-xl border p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Saved Increases
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 font-medium text-muted-foreground">Hotel</th>
                <th className="text-right py-2 font-medium text-muted-foreground">%</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Flat</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Threshold</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Grade</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Employees</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Monthly Increase</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Annual Increase</th>
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
                  <td className="py-2 text-right font-mono text-xs text-muted-foreground">
                    {s.threshold ? fmtCurrency(parseFloat(s.threshold), s.hotel.country) : '—'}
                  </td>
                  <td className="py-2 text-right text-muted-foreground text-xs">
                    {s.excludedGrades.size === 0 ? 'All' : `Excl. ${[...s.excludedGrades].join(', ')}`}
                  </td>
                  <td className="py-2 text-right tabular-nums">{s.count}</td>
                  <td className="py-2 text-right font-mono text-amber-700">
                    {s.increaseAmount > 0 ? `+${fmtCurrency(s.increaseAmount, s.hotel.country)}` : '—'}
                  </td>
                  <td className="py-2 text-right font-mono text-amber-700">
                    {s.increaseAmount > 0 ? `+${fmtCurrency(s.increaseAmount * 12, s.hotel.country)}` : '—'}
                  </td>
                  <td className="py-2 text-center">
                    <div className="flex items-center justify-center gap-3">
                      <button
                        onClick={() => setHotelFilter(s.hotel.id)}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteDraft(s.hotel.id)}
                        title="Delete this hotel's saved increase"
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

          <div className="relative" ref={gradeDropdownRef}>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Exclude Grades</label>
            <button
              type="button"
              onClick={() => setGradeDropdownOpen(v => !v)}
              className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white flex items-center gap-2 min-w-[160px] justify-between"
            >
              <span>{excludedGrades.size === 0 ? 'None excluded' : `${excludedGrades.size} grade${excludedGrades.size > 1 ? 's' : ''} excluded`}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            </button>
            {gradeDropdownOpen && (
              <div className="absolute z-20 mt-1 bg-white border rounded-lg shadow-lg py-1.5 min-w-[180px]">
                {GRADE_OPTIONS.slice(1).map(g => (
                  <label key={g} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted/30 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={excludedGrades.has(g)}
                      onChange={() => setExcludedGrades(prev => {
                        const next = new Set(prev);
                        next.has(g) ? next.delete(g) : next.add(g);
                        return next;
                      })}
                      className="rounded accent-primary"
                    />
                    {g}
                  </label>
                ))}
                {excludedGrades.size > 0 && (
                  <button
                    onClick={() => setExcludedGrades(new Set())}
                    className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border-t mt-1 pt-2"
                  >
                    Clear exclusions
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="h-px w-px mx-1 self-stretch" aria-hidden />

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">% Increase</label>
            <div className="relative">
              <input
                type="number" min="0" max="100" step="0.1"
                value={pct}
                onChange={e => setPct(e.target.value)}
                placeholder="e.g. 6"
                className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-28 pr-7"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Flat Adjustment</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                {currentHotel?.country.toLowerCase().includes('botswana') ? 'P' : 'R'}
              </span>
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

        {/* ── Threshold section ── */}
        <div className="mt-4 pt-4 border-t flex gap-4 items-end flex-wrap">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Threshold Basic</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                {currentHotel?.country.toLowerCase().includes('botswana') ? 'P' : 'R'}
              </span>
              <input
                type="number" min="0" step="1"
                value={threshold}
                onChange={e => setThreshold(e.target.value)}
                placeholder="e.g. 7000"
                className="rounded-md border border-input pl-7 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-36"
              />
            </div>
          </div>

          {threshold && (
            <>
              <div className="self-end pb-2.5 text-xs font-semibold text-blue-700 whitespace-nowrap">
                Below &lt; {threshold}
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">% Increase</label>
                <div className="relative">
                  <input
                    type="number" min="0" max="100" step="0.1"
                    value={belowPct}
                    onChange={e => setBelowPct(e.target.value)}
                    placeholder="e.g. 5.5"
                    className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-28 pr-7"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Flat Adjustment</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    {currentHotel?.country.toLowerCase().includes('botswana') ? 'P' : 'R'}
                  </span>
                  <input
                    type="number" min="0" step="1"
                    value={belowFlat}
                    onChange={e => setBelowFlat(e.target.value)}
                    placeholder="e.g. 200"
                    className="rounded-md border border-input pl-7 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-32"
                  />
                </div>
              </div>

              <div className="self-end pb-2.5 text-xs font-semibold text-amber-700 whitespace-nowrap">
                Above ≥ {threshold}
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">% Increase</label>
                <div className="relative">
                  <input
                    type="number" min="0" max="100" step="0.1"
                    value={abovePct}
                    onChange={e => setAbovePct(e.target.value)}
                    placeholder="e.g. 5.5"
                    className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-28 pr-7"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Flat Adjustment</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    {currentHotel?.country.toLowerCase().includes('botswana') ? 'P' : 'R'}
                  </span>
                  <input
                    type="number" min="0" step="1"
                    value={aboveFlat}
                    onChange={e => setAboveFlat(e.target.value)}
                    placeholder="e.g. 350"
                    className="rounded-md border border-input pl-7 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring w-32"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {threshold && (belowPct || belowFlat || abovePct || aboveFlat) && (
          <p className="mt-3 text-xs text-muted-foreground">
            Threshold rule (applied to gross):
            <span className="font-mono ml-1 text-foreground">
              Basic &lt; {threshold} → {belowPct ? `${belowPct}%` : '0%'}{belowFlat ? ` + ${belowFlat} flat` : ''} of gross
              {' · '}
              Basic ≥ {threshold} → {abovePct ? `${abovePct}%` : (pct ? `${pct}% (global)` : '—')}{aboveFlat ? ` + ${aboveFlat} flat` : (!aboveFlat && flat ? ` + ${flat} flat (global)` : '')} of gross
            </span>
          </p>
        )}

        {!threshold && (pct || flat) && (
          <p className="mt-3 text-xs text-muted-foreground">
            Formula per employee:
            <span className="font-mono ml-1 text-foreground">
              increase = gross{pct ? ` × ${pct}%` : ''}{flat ? ` + ${flat} flat` : ''} → new gross = round(gross + increase)
            </span>
          </p>
        )}
      </div>

      {/* ── Impact summary ── */}
      {forecastRows.length > 0 && (
        <>
          <div className="grid grid-cols-5 gap-4 mb-6">
            <ImpactCard label="Employees"             value={totals.count.toString()} />
            <ImpactCard label="Current Gross / mo"    value={fmtCurrency(totals.currentGross, currentHotel?.country ?? '')} />
            <ImpactCard label="New Gross / mo"        value={fmtCurrency(totals.newGross, currentHotel?.country ?? '')}           highlight />
            <ImpactCard label="Monthly Increase"      value={fmtCurrency(totals.increaseAmount, currentHotel?.country ?? '')}     highlight />
            <ImpactCard label="Annual Increase"       value={fmtCurrency(totals.increaseAmount * 12, currentHotel?.country ?? '')} highlight />
          </div>

          {overrideCount > 0 && (
            <div className="flex items-center gap-2 mb-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 w-fit">
              <span className="h-2 w-2 rounded-full bg-amber-400 inline-block" />
              {overrideCount} employee{overrideCount > 1 ? 's' : ''} with individual overrides
              <button
                onClick={() => setOverrides(new Map())}
                className="ml-2 underline hover:no-underline"
              >
                Clear all
              </button>
            </div>
          )}

          {/* ── Line-by-line table ── */}
          <div className="bg-white rounded-xl border overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="px-4 py-3 w-10" title="Exclude from increase" />
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Employee</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Grade</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current Gross</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">% Inc.</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Flat Adj.</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">New Gross</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current CTC</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">New CTC</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actual %</th>
                  <th className="px-4 py-3 w-10" />
                </tr>
              </thead>
              <tbody>
                {forecastRows.map((r, i) => (
                  <React.Fragment key={r.employee.id}>
                    <tr
                      className={`border-b ${r.isExcluded ? 'opacity-45' : editingId === r.employee.id ? 'bg-amber-50' : i % 2 === 1 ? 'bg-muted/10' : ''}`}
                    >
                      <td className="px-4 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={r.isExcluded}
                          onChange={() => setExcluded(prev => {
                            const n = new Set(prev);
                            n.has(r.employee.id) ? n.delete(r.employee.id) : n.add(r.employee.id);
                            return n;
                          })}
                          title="Exclude from increase"
                          className="rounded cursor-pointer"
                        />
                      </td>

                      <td className="px-4 py-2.5 font-medium">
                        <div className="flex items-center gap-2">
                          {r.employee.surname}, {r.employee.first_name}
                          {r.isExcluded && (
                            <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs font-medium">
                              excluded
                            </span>
                          )}
                          {r.hasOverride && !r.isExcluded && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-medium">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                              custom
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.employee.grade_label ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCurrency(r.currentGross, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-700">
                        {r.isExcluded ? <span className="text-muted-foreground">—</span> : `${(r.effectivePct * 100).toFixed(1)}%`}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{r.effectiveFlat > 0 && !r.isExcluded ? fmtCurrency(r.effectiveFlat, r.hotel.country) : '—'}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold">{fmtCurrency(r.newTotalEarnings, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmtCurrency(r.currentCtc, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCurrency(r.newCtc, r.hotel.country)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">
                        {r.isExcluded || r.currentGross === 0
                          ? <span className="text-muted-foreground">—</span>
                          : <span className="text-green-700">{((r.newTotalEarnings - r.currentGross) / r.currentGross * 100).toFixed(2)}%</span>
                        }
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
                      <tr key={`${r.employee.id}-edit`} className="border-b bg-amber-50">
                        <td colSpan={10} className="px-4 py-3">
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
                                  type="number" min="0" max="200" step="0.1"
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
                  <td className="px-4 py-3" colSpan={3}>Totals ({totals.count} employees{totals.excludedCount > 0 ? `, ${totals.excludedCount} excluded` : ''})</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtCurrency(totals.currentGross, currentHotel?.country ?? '')}</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-right font-mono">{totals.totalFlat > 0 ? fmtCurrency(totals.totalFlat, currentHotel?.country ?? '') : '—'}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtCurrency(totals.newGross, currentHotel?.country ?? '')}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtCurrency(totals.currentCtc, currentHotel?.country ?? '')}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtCurrency(totals.newCtc, currentHotel?.country ?? '')}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-green-700">
                    {totals.currentGross > 0 ? `${((totals.newGross - totals.currentGross) / totals.currentGross * 100).toFixed(2)}%` : '—'}
                  </td>
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {forecastRows.length === 0 && hasAnyInput && (
        <p className="text-muted-foreground text-sm mb-6">
          No employees match the selected filters, or no salary data has been imported yet.
        </p>
      )}

      {!hasAnyInput && !isSaved && (
        <p className="text-muted-foreground text-sm mb-6">
          Enter a % increase, flat adjustment, or threshold above to see the forecast for this hotel.
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
