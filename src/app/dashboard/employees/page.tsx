'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Employee, Hotel, SalaryRecord } from '@/types/database';
import { fmtZAR, fmtCurrency, sortHotels, MONTH_NAMES } from '@/lib/utils';
import Link from 'next/link';
import { Search, SlidersHorizontal, X, Calculator, CheckCircle, Download, Trash2, UserPlus } from 'lucide-react';
import { calculateBurden, BurdenResult } from '@/lib/payroll-calc';
import { buildEmployeeCsv } from '@/lib/employee-csv';

// ── Column definitions ────────────────────────────────────────────────────────

type ColId =
  | 'employee_code' | 'surname' | 'name' | 'hotel' | 'department' | 'title'
  | 'employment_date' | 'years_service' | 'structure'
  | 'basic' | 'structure_sal' | 'gross_salary' | 'ctc'
  | 'medical_co' | 'provident_co'
  | 'uif_co' | 'sdl' | 'wca'
  | 'staff_meals' | 'bonus_provision' | 'incentive' | 'gratuity' | 'severance'
  | 'leave_accrual';

interface ColDef {
  id: ColId;
  label: string;
  group: string;
  defaultVisible: boolean;
  align?: 'right';
}

const ALL_COLUMNS: ColDef[] = [
  // Employee info
  { id: 'employee_code',   label: 'Emp Code',          group: 'Employee',    defaultVisible: true },
  { id: 'surname',         label: 'Surname',           group: 'Employee',    defaultVisible: true },
  { id: 'name',            label: 'First Name',        group: 'Employee',    defaultVisible: true },
  { id: 'hotel',           label: 'Hotel',             group: 'Employee',    defaultVisible: true },
  { id: 'department',      label: 'Department',        group: 'Employee',    defaultVisible: true },
  { id: 'title',           label: 'Job Title',         group: 'Employee',    defaultVisible: true },
  { id: 'employment_date', label: 'Start Date',        group: 'Employee',    defaultVisible: false },
  { id: 'years_service',   label: 'Yrs Service',       group: 'Employee',    defaultVisible: false, align: 'right' },
  { id: 'structure',       label: 'Grade',             group: 'Employee',    defaultVisible: true },
  // Core salary
  { id: 'basic',           label: 'Basic Salary',      group: 'Salary',      defaultVisible: true,  align: 'right' },
  { id: 'structure_sal',   label: 'Structure',         group: 'Salary',      defaultVisible: true },
  { id: 'gross_salary',    label: 'Gross Salary',      group: 'Salary',      defaultVisible: true,  align: 'right' },
  { id: 'ctc',             label: 'CTC',               group: 'Salary',      defaultVisible: true,  align: 'right' },
  // Company benefits
  { id: 'medical_co',      label: 'Medical (Co)',      group: 'Benefits',    defaultVisible: false, align: 'right' },
  { id: 'provident_co',    label: 'Prov Fund (Co)',    group: 'Benefits',    defaultVisible: false, align: 'right' },
  // Legislative contributions
  { id: 'uif_co',          label: 'UIF (Co)',          group: 'Legislative', defaultVisible: false, align: 'right' },
  { id: 'sdl',             label: 'SDL',               group: 'Legislative', defaultVisible: false, align: 'right' },
  { id: 'wca',             label: 'WCA',               group: 'Legislative', defaultVisible: false, align: 'right' },
  // Payroll burden / provisions
  { id: 'staff_meals',     label: 'Staff Meals',       group: 'Provisions',  defaultVisible: false, align: 'right' },
  { id: 'bonus_provision', label: 'Bonus',             group: 'Provisions',  defaultVisible: false, align: 'right' },
  { id: 'incentive',       label: 'Incentive',         group: 'Provisions',  defaultVisible: false, align: 'right' },
  { id: 'gratuity',        label: 'Gratuity',          group: 'Provisions',  defaultVisible: false, align: 'right' },
  { id: 'severance',       label: 'Severance',         group: 'Provisions',  defaultVisible: false, align: 'right' },
  // Accruals
  { id: 'leave_accrual',   label: 'Leave',             group: 'Provisions',  defaultVisible: false, align: 'right' },
];



const STORAGE_KEY        = 'ihg-salary-emp-cols';
const HOTEL_FILTER_KEY   = 'ihg-salary-emp-hotel';

const DEFAULT_VISIBLE = new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.id));

const GRADE_OPTIONS  = ['ANO', 'FTC', 'DNQ', 'Frontline', 'Supervisory', 'Management', 'Executive', 'Flexible'];
const STATUS_OPTIONS = ['active', 'terminated'] as const;

// Some hotels split their employee list into "Permanent" + a second grade-based
// tab. Keyed by hotel short_code.
interface SecondaryGradeTab {
  tabLabel:   string;      // toggle button text
  countLabel: string;      // header summary text (e.g. "5 FTC employees")
  suffix:     string;      // CSV filename suffix
  grades:     Set<string>; // grade_label values that belong in this tab
}
const SECONDARY_GRADE_TABS: Record<string, SecondaryGradeTab> = {
  CSL:  { tabLabel: 'Fixed Term', countLabel: 'FTC',      suffix: 'ftc',      grades: new Set(['FTC']) },
  NL:   { tabLabel: 'Fixed Term', countLabel: 'FTC',      suffix: 'ftc',      grades: new Set(['FTC']) },
  ILRB: { tabLabel: 'Flexible',   countLabel: 'Flexible', suffix: 'flexible', grades: new Set(['Flexible']) },
};

// Maps each display ColId to its CSV column name. ColIds with no direct CSV
// column (hotel, years_service, structure_sal) are omitted — they are skipped
// when building the filtered export.
const COL_TO_CSV: Partial<Record<ColId, string>> = {
  employee_code:   'employee_code',
  surname:         'surname',
  name:            'first_name',
  department:      'department',
  title:           'job_title',
  structure:       'grade_label',
  employment_date: 'employment_date',
  basic:           'basic_salary',
  gross_salary:    'total_earnings',
  ctc:             'ctc',
  medical_co:      'medical_company',
  provident_co:    'provident_company',
  uif_co:          'uif_company',
  sdl:             'sdl_company',
  wca:             'wca_company',
  staff_meals:     'staff_meals',
  bonus_provision: 'bonus_provision',
  incentive:       'incentive',
  gratuity:        'gratuity',
  severance:       'severance',
  leave_accrual:   'leave_accrual',
};

interface AddForm {
  hotel_id: string;
  employee_code: string;
  surname: string;
  first_name: string;
  job_title: string;
  department_code: string;
  grade_label: string;
  status: 'active' | 'terminated';
  employment_date: string;
  basic_salary: number;
  total_earnings: number;
  period_month: number;
  period_year: number;
}

function emptyAddForm(hotelId = ''): AddForm {
  const d = new Date();
  return {
    hotel_id: hotelId,
    employee_code: '',
    surname: '',
    first_name: '',
    job_title: '',
    department_code: '',
    grade_label: '',
    status: 'active',
    employment_date: '',
    basic_salary: 0,
    total_earnings: 0,
    period_month: d.getMonth() + 1,
    period_year: d.getFullYear(),
  };
}

function colKey(hotelId: string) { return `${STORAGE_KEY}-${hotelId}`; }

function loadVisibleCols(hotelId: string): Set<ColId> {
  try {
    const raw = localStorage.getItem(colKey(hotelId));
    if (raw) return new Set(JSON.parse(raw) as ColId[]);
  } catch {}
  return new Set(DEFAULT_VISIBLE);
}

function yearsOfService(date: string | null): number | null {
  if (!date) return null;
  const ms = Date.now() - new Date(date).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25) * 10) / 10;
}

function numericValue(col: ColId, e: Employee, sal: SalaryRecord | undefined): number | null {
  switch (col) {
    case 'years_service':     return yearsOfService(e.employment_date);
    case 'basic':             return sal?.basic_salary ?? null;
    case 'gross_salary':      return sal?.total_earnings ?? null;
    case 'ctc':               return sal?.ctc ?? null;
    case 'uif_co':            return sal?.uif_company ?? null;
    case 'medical_co':        return sal?.medical_company ?? null;
    case 'provident_co':      return sal?.provident_company ?? null;
    case 'sdl':               return sal?.sdl_company ?? null;
    case 'wca':               return sal?.wca_company ?? null;
    case 'staff_meals':       return sal?.staff_meals ?? null;
    case 'bonus_provision':   return sal?.bonus_provision ?? null;
    case 'incentive':         return sal?.incentive ?? null;
    case 'gratuity':          return sal?.gratuity ?? null;
    case 'severance':         return sal?.severance ?? null;
    case 'leave_accrual':     return sal?.leave_accrual ?? null;
    default:                  return null;
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeesPage() {
  const sb = createClient();
  const [hotels, setHotels]   = useState<Hotel[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [salaries, setSalaries]   = useState<SalaryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [hotelFilter,  setHotelFilter]  = useState('');
  const [search,       setSearch]       = useState('');
  const [gradeTabFilter, setGradeTabFilter] = useState<'permanent' | 'secondary'>('permanent');

  const [visibleCols, setVisibleCols] = useState<Set<ColId>>(DEFAULT_VISIBLE);
  const [draftCols,   setDraftCols]   = useState<Set<ColId>>(DEFAULT_VISIBLE);
  const [showColPicker, setShowColPicker] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [calcDone, setCalcDone] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm,      setAddForm]      = useState<AddForm>(emptyAddForm());
  const [adding,       setAdding]       = useState(false);
  const [addError,     setAddError]     = useState('');

  // Load persisted column visibility whenever the active hotel changes
  useEffect(() => {
    if (hotelFilter) setVisibleCols(loadVisibleCols(hotelFilter));
  }, [hotelFilter]);


  // Persist hotel filter selection; reset secondary grade tab on hotel change
  useEffect(() => {
    if (hotelFilter) {
      try { localStorage.setItem(HOTEL_FILTER_KEY, hotelFilter); } catch {}
      setGradeTabFilter('permanent');
    }
  }, [hotelFilter]);

  async function load() {
    const [{ data: h }, { data: e }, { data: s }, meRes] = await Promise.all([
      sb.from('hotels').select('*'),
      sb.from('employees').select('*').order('surname'),
      sb.from('salary_records').select('*'),
      fetch('/api/auth/me').then(r => r.ok ? r.json() : null),
    ]);
    const me = meRes as { role: string; hotelIds: string[] | null } | null;
    let hotelList = sortHotels((h ?? []) as Hotel[]);
    if (me?.role === 'sub' && me.hotelIds?.length) {
      hotelList = hotelList.filter(h => me.hotelIds!.includes(h.id));
    }
    setHotels(hotelList);
    setEmployees((e ?? []) as Employee[]);
    setSalaries((s ?? []) as SalaryRecord[]);
    // Resolve hotel filter: prefer localStorage value if it matches a real hotel,
    // otherwise fall back to the first hotel in the list.
    if (hotelList.length > 0) {
      setHotelFilter(prev => {
        if (prev && hotelList.some(h => h.id === prev)) return prev;
        try {
          const saved = localStorage.getItem(HOTEL_FILTER_KEY);
          if (saved && saved !== 'all' && hotelList.some(h => h.id === saved)) return saved;
        } catch {}
        return hotelList[0].id;
      });
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openAddModal() {
    const defaultGrade = secondaryTab && gradeTabFilter === 'secondary' ? [...secondaryTab.grades][0] : '';
    setAddForm({ ...emptyAddForm(hotelFilter), grade_label: defaultGrade });
    setAddError('');
    setShowAddModal(true);
  }

  async function handleAdd() {
    if (!addForm.surname.trim() || !addForm.first_name.trim()) {
      setAddError('Surname and First Name are required.');
      return;
    }
    if (!addForm.hotel_id) {
      setAddError('Please select a hotel.');
      return;
    }
    setAdding(true);
    setAddError('');

    const { data: emp, error: empErr } = await sb.from('employees').insert({
      hotel_id:             addForm.hotel_id,
      employee_code:        addForm.employee_code || null,
      surname:              addForm.surname.trim(),
      first_name:           addForm.first_name.trim(),
      job_title:            addForm.job_title || null,
      department_code:      addForm.department_code || null,
      grade_label:          addForm.grade_label || null,
      status:               addForm.status,
      employment_date:      addForm.employment_date || null,
      nmw_applicable:       false,
      severance_applicable: false,
      incentive_applicable: false,
      incentive_multiplier: 2,
      gratuity_applicable:  false,
      gratuity_rate:        0,
    }).select().single();

    if (empErr || !emp) {
      setAddError(empErr?.message ?? 'Failed to create employee.');
      setAdding(false);
      return;
    }

    const hotel         = hotelMap.get(addForm.hotel_id);
    const totalEarnings = addForm.total_earnings || addForm.basic_salary;
    let burden: BurdenResult | null = null;

    if (hotel && addForm.basic_salary > 0) {
      burden = calculateBurden({
        basic:                 addForm.basic_salary,
        totalEarnings:         totalEarnings,
        jobTitle:              addForm.job_title || null,
        country:               hotel.country,
        wcaRate:               hotel.wca_rate ?? 0,
        hotelShortCode:        hotel.short_code,
        yearsOfService:        yearsOfService(addForm.employment_date) ?? 0,
        severanceApplicable:   false,
        incentiveApplicable:   false,
        incentiveMultiplier:   2,
        gratuityApplicable:    false,
        gratuityRate:          0,
        taxPaye:               0,
        medicalEmployee:       0,
        medicalCompany:        0,
        ancillaEmployee:       0,
        ancillaCompany:        0,
        leaveProvision:        0,
        otherCompanyContrib:   0,
        mgmtIncentive:         0,
        bonusAccrualDec:       0,
        bonusAccrualJuly:      0,
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
    }

    const { error: salErr } = await sb.from('salary_records').insert({
      employee_id:           (emp as any).id,
      period_month:          addForm.period_month,
      period_year:           addForm.period_year,
      basic_salary:          addForm.basic_salary,
      total_earnings:        totalEarnings,
      allowances:            {},
      tax_paye:              0,
      uif_employee:          burden?.uif_employee          ?? 0,
      medical_employee:      0,
      ancilla_employee:      0,
      provident_employee:    burden?.provident_employee    ?? 0,
      total_deductions:      burden?.total_deductions      ?? 0,
      uif_company:           burden?.uif_company           ?? 0,
      medical_company:       0,
      provident_company:     burden?.provident_company     ?? 0,
      sdl_company:           burden?.sdl_company           ?? 0,
      ancilla_company:       0,
      total_company_contrib: burden?.total_company_contrib ?? 0,
      wca_company:           burden?.wca_company           ?? 0,
      staff_meals:           burden?.staff_meals           ?? 0,
      bonus_provision:       burden?.bonus_provision       ?? 0,
      incentive:             0,
      leave_provision:       0,
      other_company_contrib: 0,
      total_payroll_burden:  burden?.total_payroll_burden  ?? 0,
      total_cost:            burden?.total_cost            ?? totalEarnings,
      leave_days:            burden?.leave_days            ?? 0,
      leave_accrual:         burden?.leave_accrual         ?? 0,
      bonus_payout_factor:   0,
      bonus_accrual_dec:     0,
      bonus_accrual_july:    0,
      mgmt_incentive:        0,
      severance:             0,
      gratuity:              0,
      increase_amount:       0,
      adjustment:            0,
      increase_pct:          0,
      new_basic:             0,
      new_ctc:               0,
      net_salary:            burden?.net_salary            ?? totalEarnings,
      ctc:                   burden?.ctc                   ?? totalEarnings,
    });

    setAdding(false);
    if (salErr) {
      setAddError(`Employee created but salary record failed: ${salErr.message}`);
      await load();
      return;
    }
    setShowAddModal(false);
    await load();
  }

  const hotelMap = useMemo(() => new Map((hotels).map(h => [h.id, h])), [hotels]);

  const selectedHotel  = useMemo(() => hotels.find(h => h.id === hotelFilter), [hotels, hotelFilter]);
  const secondaryTab    = selectedHotel ? SECONDARY_GRADE_TABS[selectedHotel.short_code] : undefined;

  const latestSalary = useMemo(() => {
    const map = new Map<string, SalaryRecord>();
    for (const sr of salaries) {
      const ex = map.get(sr.employee_id);
      if (!ex || sr.period_year > ex.period_year ||
        (sr.period_year === ex.period_year && sr.period_month > ex.period_month)) {
        map.set(sr.employee_id, sr);
      }
    }
    return map;
  }, [salaries]);

  const filtered = useMemo(() => employees
    .filter(e => !hotelFilter || e.hotel_id === hotelFilter)
    .filter(e => {
      if (!secondaryTab) return true;
      const isSecondary = secondaryTab.grades.has(e.grade_label ?? '');
      return gradeTabFilter === 'secondary' ? isSecondary : !isSecondary;
    })
    .filter(e => !search || `${e.surname} ${e.first_name} ${e.employee_code ?? ''} ${e.job_title ?? ''}`.toLowerCase().includes(search.toLowerCase())),
    [employees, hotelFilter, search, gradeTabFilter, secondaryTab]);

  // Flags employees missing from the most recent roster import (CSL Payroll
  // Schedule / HR List) — likely no longer employed. Compared within each
  // Permanent/FTC segment separately (for CSL/NL) since those are uploaded
  // as separate files; segments with no tracked import yet are left alone.
  const staleIds = useMemo(() => {
    const stale = new Set<string>();
    if (!hotelFilter) return stale;
    const hotelEmps = employees.filter(e => e.hotel_id === hotelFilter);
    const groups = secondaryTab
      ? [
          hotelEmps.filter(e => secondaryTab.grades.has(e.grade_label ?? '')),
          hotelEmps.filter(e => !secondaryTab.grades.has(e.grade_label ?? '')),
        ]
      : [hotelEmps];

    for (const group of groups) {
      let maxSeen: string | null = null;
      for (const e of group) {
        if (e.last_seen_at && (!maxSeen || e.last_seen_at > maxSeen)) maxSeen = e.last_seen_at;
      }
      if (!maxSeen) continue; // nobody in this segment tracked yet — nothing to compare against
      for (const e of group) {
        if (!e.last_seen_at || e.last_seen_at < maxSeen) stale.add(e.id);
      }
    }
    return stale;
  }, [employees, hotelFilter, secondaryTab]);

  useEffect(() => { setSelected(new Set()); }, [hotelFilter, search]);

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(prev =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map(e => e.id))
    );
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    const names = employees
      .filter(e => ids.includes(e.id))
      .map(e => `${e.first_name} ${e.surname}`)
      .join(', ');
    if (!window.confirm(`Delete ${ids.length} employee${ids.length > 1 ? 's' : ''} (${names})?\n\nThis will permanently remove them and all their salary records.`)) return;
    await Promise.all(ids.map(id => sb.from('salary_records').delete().eq('employee_id', id)));
    await sb.from('employees').delete().in('id', ids);
    setEmployees(prev => prev.filter(e => !ids.includes(e.id)));
    setSalaries(prev => prev.filter(s => !ids.includes(s.employee_id)));
    setSelected(new Set());
  }

  function openColPicker() {
    setDraftCols(new Set(visibleCols));
    setShowColPicker(true);
  }

  function toggleDraft(id: ColId) {
    setDraftCols(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function applyDraft() {
    setVisibleCols(new Set(draftCols));
    if (hotelFilter) localStorage.setItem(colKey(hotelFilter), JSON.stringify([...draftCols]));
    setShowColPicker(false);
  }

  function resetDraft() {
    setDraftCols(new Set(DEFAULT_VISIBLE));
  }

  function resetCols() {
    setVisibleCols(new Set(DEFAULT_VISIBLE));
    if (hotelFilter) localStorage.removeItem(colKey(hotelFilter));
  }

  function handleExportCSV() {
    const hotel = hotelMap.get(hotelFilter);
    if (!hotel) return;
    const hotelEmployees = employees
      .filter(e => e.hotel_id === hotelFilter)
      .filter(e => {
        if (!secondaryTab) return true;
        const isSecondary = secondaryTab.grades.has(e.grade_label ?? '');
        return gradeTabFilter === 'secondary' ? isSecondary : !isSecondary;
      });

    // Resolve which CSV columns to emit — use the saved column picker selection
    // for the export hotel, mapped through COL_TO_CSV. Columns with no CSV
    // equivalent (hotel, years_service, structure_sal) are silently skipped.
    const savedCols = loadVisibleCols(hotelFilter);
    const csvCols = ALL_COLUMNS
      .filter(c => savedCols.has(c.id))
      .map(c => COL_TO_CSV[c.id])
      .filter((c): c is string => !!c);

    const csv = buildEmployeeCsv(hotelEmployees, latestSalary, csvCols.length ? csvCols : undefined);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const firstSal = hotelEmployees.map(e => latestSalary.get(e.id)).find(Boolean);
    const ym = firstSal
      ? `${firstSal.period_year}${String(firstSal.period_month).padStart(2, '0')}`
      : new Date().toISOString().slice(0, 7).replace('-', '');
    a.href = url;
    const tabSuffix = secondaryTab ? (gradeTabFilter === 'secondary' ? `_${secondaryTab.suffix}` : '_permanent') : '';
    a.download = `${hotel.short_code}${tabSuffix}_employees_${ym}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function runCalculateBurden() {
    if (!filtered.length) return;
    setCalculating(true);
    await Promise.all(
      filtered.map(async emp => {
        const hotel = hotelMap.get(emp.hotel_id);
        const sal   = latestSalary.get(emp.id);
        if (!hotel || !sal) return;

        const burden = calculateBurden({
          basic:               sal.basic_salary,
          totalEarnings:       sal.total_earnings,
          jobTitle:            emp.job_title,
          country:             hotel.country,
          wcaRate:             hotel.wca_rate ?? 0,
          hotelShortCode:      hotel.short_code,
          yearsOfService:      yearsOfService(emp.employment_date) ?? 0,
          severanceApplicable:  emp.severance_applicable,
          incentiveApplicable:  emp.incentive_applicable,
          incentiveMultiplier:  emp.incentive_multiplier,
          gratuityApplicable:   emp.gratuity_applicable,
          gratuityRate:         emp.gratuity_rate,
          taxPaye:            sal.tax_paye,
          medicalEmployee:    sal.medical_employee,
          medicalCompany:     sal.medical_company,
          ancillaEmployee:    sal.ancilla_employee,
          ancillaCompany:     sal.ancilla_company,
          leaveProvision:     sal.leave_provision,
          otherCompanyContrib:sal.other_company_contrib,
          mgmtIncentive:      sal.mgmt_incentive,
          bonusAccrualDec:    sal.bonus_accrual_dec,
          bonusAccrualJuly:   sal.bonus_accrual_july,
          // Configurable rates from hotel methods
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

        await sb.from('salary_records').update({
          provident_employee:   burden.provident_employee,
          uif_employee:         burden.uif_employee,
          total_deductions:     burden.total_deductions,
          net_salary:           burden.net_salary,
          provident_company:    burden.provident_company,
          uif_company:          burden.uif_company,
          sdl_company:          burden.sdl_company,
          wca_company:          burden.wca_company,
          staff_meals:          burden.staff_meals,
          bonus_provision:      burden.bonus_provision,
          leave_days:           burden.leave_days,
          leave_accrual:        burden.leave_accrual,
          severance:            burden.severance,
          incentive:            burden.incentive,
          gratuity:             burden.gratuity,
          total_company_contrib:burden.total_company_contrib,
          total_payroll_burden: burden.total_payroll_burden,
          total_cost:           burden.total_cost,
          ctc:                  burden.ctc,
        }).eq('id', sal.id);
      })
    );

    await load();
    setCalculating(false);
    setCalcDone(true);
    setTimeout(() => setCalcDone(false), 3000);
  }

  const visibleDefs = useMemo(() => ALL_COLUMNS.filter(c => visibleCols.has(c.id)), [visibleCols]);

  // Cell renderer per column
  function cellValue(col: ColId, e: Employee, sal: SalaryRecord | undefined, isStale: boolean): React.ReactNode {
    const yrs     = yearsOfService(e.employment_date);
    const country = hotelMap.get(e.hotel_id)?.country ?? '';
    const fmt     = (n: number) => fmtCurrency(n, country);
    switch (col) {
      case 'employee_code':   return <span className="font-mono text-muted-foreground">{e.employee_code ?? '—'}</span>;
      case 'surname':
        return (
          <span className={`font-medium inline-flex items-center gap-1.5 ${isStale ? 'text-red-700' : ''}`}>
            {e.surname}
            {isStale && (
              <span
                className="inline-flex items-center rounded-full bg-red-100 text-red-700 px-2 py-0.5 text-xs font-medium"
                title="Not present in the most recent roster import — may have left"
              >
                not in last import
              </span>
            )}
          </span>
        );
      case 'name':            return e.first_name;
      case 'hotel':           return hotelMap.get(e.hotel_id)?.short_code ?? '—';
      case 'department':      return e.department_code ?? '—';
      case 'title':           return e.job_title ?? '—';
      case 'employment_date': return e.employment_date ? new Date(e.employment_date).toLocaleDateString('en-ZA') : '—';
      case 'years_service':   return yrs != null ? `${yrs}` : '—';
      // Salary fields
      case 'structure':       return e.grade_label ?? '—';
      case 'structure_sal': { const s = (sal?.allowances as Record<string, number>)?.structure; return s ? fmt(s) : '—'; }
      case 'basic':           return sal?.basic_salary    ? fmt(sal.basic_salary)    : '—';
      case 'gross_salary':    return sal?.total_earnings  ? fmt(sal.total_earnings)  : '—';
      case 'ctc':             return sal?.ctc             ? fmt(sal.ctc)             : '—';
      case 'uif_co':          return sal?.uif_company     ? fmt(sal.uif_company)     : '—';
      case 'medical_co':      return sal?.medical_company ? fmt(sal.medical_company) : '—';
      case 'provident_co':    return sal?.provident_company ? fmt(sal.provident_company) : '—';
      case 'sdl':             return sal?.sdl_company     ? fmt(sal.sdl_company)     : '—';
      case 'wca':             return sal?.wca_company     ? fmt(sal.wca_company)     : '—';
      case 'staff_meals':     return sal?.staff_meals     ? fmt(sal.staff_meals)     : '—';
      case 'bonus_provision': return sal?.bonus_provision ? fmt(sal.bonus_provision) : '—';
      case 'incentive':       return sal?.incentive       ? fmt(sal.incentive)       : '—';
      case 'gratuity':        return sal?.gratuity        ? fmt(sal.gratuity)        : '—';
      case 'severance':       return sal?.severance       ? fmt(sal.severance)       : '—';
      case 'leave_accrual':   return sal?.leave_accrual   ? fmt(sal.leave_accrual)   : '—';
    }
  }

  const groups = [...new Set(ALL_COLUMNS.map(c => c.group))];

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Employees</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {filtered.length} {secondaryTab ? (gradeTabFilter === 'secondary' ? secondaryTab.countLabel : 'permanent') + ' ' : ''}employee{filtered.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Batch delete */}
          {selected.size > 0 && (
            <button
              onClick={deleteSelected}
              className="flex items-center gap-2 rounded-md bg-red-500 text-white px-4 py-2 text-sm font-medium hover:bg-red-600 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
              Delete {selected.size} selected
            </button>
          )}
          {/* Export CSV */}
          <button
            onClick={handleExportCSV}
            disabled={loading || !hotelFilter}
            className="flex items-center gap-2 rounded-md border border-input bg-white px-3 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
            title="Export all employees for the selected hotel as a CSV that can be edited and re-imported"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
          {/* Calculate Burden */}
          <button
            onClick={runCalculateBurden}
            disabled={calculating || loading || filtered.length === 0}
            className="flex items-center gap-2 rounded-md border border-input bg-white px-4 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            {calcDone
              ? <><CheckCircle className="h-4 w-4 text-green-500" /> Done</>
              : calculating
              ? <><Calculator className="h-4 w-4 animate-pulse" /> Calculating…</>
              : <><Calculator className="h-4 w-4" /> Calculate Burden</>}
          </button>
          {/* Add Employee */}
          <button
            onClick={openAddModal}
            className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            Add Employee
          </button>
        </div>
      </div>

      {/* Filters + column picker */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, code, title…"
            className="w-full rounded-md border border-input pl-9 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <select
          value={hotelFilter}
          onChange={e => setHotelFilter(e.target.value)}
          className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
        >
          {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>

        {/* Permanent / secondary grade toggle — hotels in SECONDARY_GRADE_TABS only */}
        {secondaryTab && (
          <div className="flex rounded-md border border-input overflow-hidden">
            <button
              onClick={() => setGradeTabFilter('permanent')}
              className={`px-3 py-2 text-sm font-medium transition-colors ${gradeTabFilter === 'permanent' ? 'bg-primary text-primary-foreground' : 'bg-white text-muted-foreground hover:bg-muted'}`}
            >
              Permanent
            </button>
            <button
              onClick={() => setGradeTabFilter('secondary')}
              className={`px-3 py-2 text-sm font-medium border-l border-input transition-colors ${gradeTabFilter === 'secondary' ? 'bg-primary text-primary-foreground' : 'bg-white text-muted-foreground hover:bg-muted'}`}
            >
              {secondaryTab.tabLabel}
            </button>
          </div>
        )}

        {/* Column picker trigger */}
        <div className="relative">
          <button
            onClick={openColPicker}
            className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm font-medium hover:bg-muted transition-colors"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Columns ({visibleCols.size})
          </button>

          {showColPicker && (
            <div className="absolute right-0 top-10 z-50 w-72 bg-white rounded-xl border shadow-lg flex flex-col max-h-[75vh]">
              {/* Header */}
              <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b shrink-0">
                <span className="text-sm font-semibold">Visible Columns</span>
                <div className="flex gap-2 items-center">
                  <button onClick={resetDraft} className="text-xs text-muted-foreground hover:text-foreground">Reset</button>
                  <button onClick={() => setShowColPicker(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
                </div>
              </div>

              {/* Scrollable group list */}
              <div className="overflow-y-auto flex-1 px-4 py-3">
                {groups.map(group => (
                  <div key={group} className="mb-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{group}</p>
                    <div className="space-y-1">
                      {ALL_COLUMNS.filter(c => c.group === group).map(col => (
                        <label key={col.id} className="flex items-center gap-2 cursor-pointer hover:bg-muted/30 rounded px-1 py-0.5">
                          <input
                            type="checkbox"
                            checked={draftCols.has(col.id)}
                            onChange={() => toggleDraft(col.id)}
                            className="rounded"
                          />
                          <span className="text-sm">{col.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* OK footer */}
              <div className="px-4 py-3 border-t shrink-0">
                <button
                  onClick={applyDraft}
                  className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  OK — Apply {draftCols.size} column{draftCols.size === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add Employee Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowAddModal(false)} />
          <div className="relative bg-white rounded-xl border shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
              <h2 className="text-base font-semibold">Add Employee</h2>
              <button onClick={() => setShowAddModal(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
              <AddField label="Hotel">
                <select
                  value={addForm.hotel_id}
                  onChange={e => setAddForm(f => ({ ...f, hotel_id: e.target.value }))}
                  className="w-full rounded-md border border-input px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">— Select hotel —</option>
                  {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
              </AddField>

              <div className="grid grid-cols-2 gap-4">
                <AddField label="Surname *">
                  <input
                    value={addForm.surname}
                    onChange={e => setAddForm(f => ({ ...f, surname: e.target.value }))}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder="e.g. Smith"
                  />
                </AddField>
                <AddField label="First Name *">
                  <input
                    value={addForm.first_name}
                    onChange={e => setAddForm(f => ({ ...f, first_name: e.target.value }))}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder="e.g. John"
                  />
                </AddField>
              </div>

              <AddField label="Employee Code">
                <input
                  value={addForm.employee_code}
                  onChange={e => setAddForm(f => ({ ...f, employee_code: e.target.value }))}
                  className="w-full rounded-md border border-input px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Optional — leave blank for ANO positions"
                />
              </AddField>

              <div className="grid grid-cols-2 gap-4">
                <AddField label="Job Title">
                  <input
                    value={addForm.job_title}
                    onChange={e => setAddForm(f => ({ ...f, job_title: e.target.value }))}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </AddField>
                <AddField label="Department Code">
                  <input
                    value={addForm.department_code}
                    onChange={e => setAddForm(f => ({ ...f, department_code: e.target.value }))}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </AddField>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <AddField label="Grade">
                  <select
                    value={addForm.grade_label}
                    onChange={e => setAddForm(f => ({ ...f, grade_label: e.target.value }))}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">— Not set —</option>
                    {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </AddField>
                <AddField label="Status">
                  <select
                    value={addForm.status}
                    onChange={e => setAddForm(f => ({ ...f, status: e.target.value as AddForm['status'] }))}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-ring"
                  >
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </AddField>
              </div>

              <AddField label="Employment Date">
                <input
                  type="date"
                  value={addForm.employment_date}
                  onChange={e => setAddForm(f => ({ ...f, employment_date: e.target.value }))}
                  className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </AddField>

              <div className="border-t pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Initial Salary</p>
                <div className="grid grid-cols-2 gap-4 mb-3">
                  <AddField label="Basic Salary">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={addForm.basic_salary || ''}
                      onChange={e => setAddForm(f => ({ ...f, basic_salary: parseFloat(e.target.value) || 0 }))}
                      className="w-full rounded-md border border-input px-3 py-2 text-sm text-right font-mono outline-none focus:ring-2 focus:ring-ring"
                      placeholder="0"
                    />
                  </AddField>
                  <AddField label="Gross Salary">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={addForm.total_earnings || ''}
                      onChange={e => setAddForm(f => ({ ...f, total_earnings: parseFloat(e.target.value) || 0 }))}
                      className="w-full rounded-md border border-input px-3 py-2 text-sm text-right font-mono outline-none focus:ring-2 focus:ring-ring"
                      placeholder="Same as basic if no allowances"
                    />
                  </AddField>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-12 shrink-0">Period</span>
                  <select
                    value={addForm.period_month}
                    onChange={e => setAddForm(f => ({ ...f, period_month: Number(e.target.value) }))}
                    className="rounded-md border border-input px-2 py-1.5 text-sm bg-white outline-none focus:ring-2 focus:ring-ring"
                  >
                    {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                  <input
                    type="number"
                    value={addForm.period_year}
                    onChange={e => setAddForm(f => ({ ...f, period_year: Number(e.target.value) }))}
                    className="w-24 rounded-md border border-input px-2 py-1.5 text-sm text-right font-mono outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              {addError && <p className="text-xs text-red-600">{addError}</p>}
            </div>

            <div className="px-6 py-4 border-t shrink-0 flex justify-end gap-3">
              <button
                onClick={() => setShowAddModal(false)}
                className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={adding}
                className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                <UserPlus className="h-4 w-4" />
                {adding ? 'Adding…' : 'Add Employee'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-4 py-3 w-8">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
                  checked={filtered.length > 0 && selected.size === filtered.length}
                  onChange={toggleSelectAll}
                />
              </th>
              {visibleDefs.map(col => (
                <th key={col.id} className={`px-4 py-3 font-medium text-muted-foreground ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {col.label}
                </th>
              ))}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={visibleDefs.length + 2} className="text-center py-12 text-muted-foreground">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={visibleDefs.length + 2} className="text-center py-12 text-muted-foreground">No employees found. Import a payroll file to get started.</td></tr>
            ) : (
              filtered.map((e, i) => {
                const sal = latestSalary.get(e.id);
                const isSelected = selected.has(e.id);
                const isStale = staleIds.has(e.id);
                return (
                  <tr key={e.id} className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${isSelected ? 'bg-red-50/60' : isStale ? 'bg-red-50/40' : i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
                        checked={isSelected}
                        onChange={() => toggleSelect(e.id)}
                      />
                    </td>
                    {visibleDefs.map(col => (
                      <td key={col.id} className={`px-4 py-2.5 text-sm ${col.align === 'right' ? 'text-right font-mono' : ''}`}>
                        {cellValue(col.id, e, sal, isStale)}
                      </td>
                    ))}
                    <td className="px-4 py-2.5">
                      <Link href={`/dashboard/employees/${e.id}`} className="text-xs text-primary hover:underline font-medium">Edit</Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground block mb-1">{label}</label>
      {children}
    </div>
  );
}
