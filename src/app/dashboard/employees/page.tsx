'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Employee, Hotel, SalaryRecord } from '@/types/database';
import { fmtZAR } from '@/lib/utils';
import Link from 'next/link';
import { Search, SlidersHorizontal, X, Calculator, CheckCircle } from 'lucide-react';
import { calculateBurden } from '@/lib/payroll-calc';

// ── Column definitions ────────────────────────────────────────────────────────

type ColId =
  | 'surname' | 'name' | 'hotel' | 'department' | 'title' | 'status'
  | 'employment_date' | 'years_service'
  | 'structure' | 'basic' | 'gross_salary' | 'ctc'
  | 'uif_emp' | 'medical_emp' | 'provident_emp'
  | 'uif_co' | 'medical_co' | 'provident_co' | 'sdl' | 'wca'
  | 'staff_meals' | 'bonus_provision' | 'incentive' | 'leave_provision'
  | 'leave_accrual' | 'bonus_accrual_dec' | 'mgmt_incentive';

interface ColDef {
  id: ColId;
  label: string;
  group: string;
  defaultVisible: boolean;
  align?: 'right';
}

const ALL_COLUMNS: ColDef[] = [
  // Employee info
  { id: 'surname',         label: 'Surname',           group: 'Employee',    defaultVisible: true },
  { id: 'name',            label: 'First Name',        group: 'Employee',    defaultVisible: true },
  { id: 'hotel',           label: 'Hotel',             group: 'Employee',    defaultVisible: true },
  { id: 'department',      label: 'Department',        group: 'Employee',    defaultVisible: true },
  { id: 'title',           label: 'Job Title',         group: 'Employee',    defaultVisible: true },
  { id: 'status',          label: 'Status',            group: 'Employee',    defaultVisible: true },
  { id: 'employment_date', label: 'Start Date',        group: 'Employee',    defaultVisible: false },
  { id: 'years_service',   label: 'Yrs Service',       group: 'Employee',    defaultVisible: false, align: 'right' },
  // Core salary
  { id: 'structure',       label: 'Structure',         group: 'Salary',      defaultVisible: true },
  { id: 'basic',           label: 'Basic Salary',      group: 'Salary',      defaultVisible: true,  align: 'right' },
  { id: 'gross_salary',    label: 'Gross Salary',      group: 'Salary',      defaultVisible: true,  align: 'right' },
  { id: 'ctc',             label: 'CTC',               group: 'Salary',      defaultVisible: true,  align: 'right' },
  // Employee deductions
  { id: 'uif_emp',         label: 'UIF (Emp)',         group: 'Deductions',  defaultVisible: false, align: 'right' },
  { id: 'medical_emp',     label: 'Medical (Emp)',     group: 'Deductions',  defaultVisible: false, align: 'right' },
  { id: 'provident_emp',   label: 'Prov Fund (Emp)',   group: 'Deductions',  defaultVisible: false, align: 'right' },
  // Company contributions
  { id: 'uif_co',          label: 'UIF (Co)',          group: 'Contributions', defaultVisible: false, align: 'right' },
  { id: 'medical_co',      label: 'Medical (Co)',      group: 'Contributions', defaultVisible: false, align: 'right' },
  { id: 'provident_co',    label: 'Prov Fund (Co)',    group: 'Contributions', defaultVisible: false, align: 'right' },
  { id: 'sdl',             label: 'SDL',               group: 'Contributions', defaultVisible: false, align: 'right' },
  { id: 'wca',             label: 'WCA',               group: 'Contributions', defaultVisible: false, align: 'right' },
  // Payroll burden / provisions
  { id: 'staff_meals',     label: 'Staff Meals',       group: 'Provisions',  defaultVisible: false, align: 'right' },
  { id: 'bonus_provision', label: 'Bonus',             group: 'Provisions',  defaultVisible: false, align: 'right' },
  { id: 'incentive',       label: 'Incentive',         group: 'Provisions',  defaultVisible: false, align: 'right' },
  { id: 'leave_provision', label: 'Leave',             group: 'Provisions',  defaultVisible: false, align: 'right' },
  // Accruals
  { id: 'leave_accrual',   label: 'Leave Accrual',     group: 'Accruals',    defaultVisible: false, align: 'right' },
  { id: 'bonus_accrual_dec', label: 'Bonus Dec',       group: 'Accruals',    defaultVisible: false, align: 'right' },
  { id: 'mgmt_incentive',  label: 'Mgmt Incentive',    group: 'Accruals',    defaultVisible: false, align: 'right' },
];


type CategoryView = 'all' | 'Deductions' | 'Contributions' | 'Provisions' | 'Accruals';
const ANCHOR_COLS: ColId[] = ['surname', 'name', 'hotel'];

const STORAGE_KEY = 'ihg-salary-emp-cols';
const DEFAULT_VISIBLE = new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.id));

function loadVisibleCols(): Set<ColId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
    case 'uif_emp':           return sal?.uif_employee ?? null;
    case 'medical_emp':       return sal?.medical_employee ?? null;
    case 'provident_emp':     return sal?.provident_employee ?? null;
    case 'uif_co':            return sal?.uif_company ?? null;
    case 'medical_co':        return sal?.medical_company ?? null;
    case 'provident_co':      return sal?.provident_company ?? null;
    case 'sdl':               return sal?.sdl_company ?? null;
    case 'wca':               return sal?.wca_company ?? null;
    case 'staff_meals':       return sal?.staff_meals ?? null;
    case 'bonus_provision':   return sal?.bonus_provision ?? null;
    case 'incentive':         return sal?.incentive ?? null;
    case 'leave_provision':   return sal?.leave_provision ?? null;
    case 'leave_accrual':     return sal?.leave_accrual ?? null;
    case 'bonus_accrual_dec': return sal?.bonus_accrual_dec ?? null;
    case 'mgmt_incentive':    return sal?.mgmt_incentive ?? null;
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

  const [hotelFilter,  setHotelFilter]  = useState('all');
  const [statusFilter, setStatusFilter] = useState('active');
  const [search,       setSearch]       = useState('');

  const [visibleCols, setVisibleCols] = useState<Set<ColId>>(DEFAULT_VISIBLE);
  const [draftCols,   setDraftCols]   = useState<Set<ColId>>(DEFAULT_VISIBLE);
  const [showColPicker, setShowColPicker] = useState(false);
  const [categoryView, setCategoryView] = useState<CategoryView>('all');
  const [calculating, setCalculating] = useState(false);
  const [calcDone, setCalcDone] = useState(false);

  // Load persisted column selection after mount (localStorage not available on server)
  useEffect(() => { setVisibleCols(loadVisibleCols()); }, []);

  async function load() {
    const [{ data: h }, { data: e }, { data: s }] = await Promise.all([
      sb.from('hotels').select('*').order('name'),
      sb.from('employees').select('*').order('surname'),
      sb.from('salary_records').select('*'),
    ]);
    setHotels((h ?? []) as Hotel[]);
    setEmployees((e ?? []) as Employee[]);
    setSalaries((s ?? []) as SalaryRecord[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const hotelMap = useMemo(() => new Map((hotels).map(h => [h.id, h])), [hotels]);

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
    .filter(e => hotelFilter === 'all' || e.hotel_id === hotelFilter)
    .filter(e => statusFilter === 'all' || e.status === statusFilter)
    .filter(e => !search || `${e.surname} ${e.first_name} ${e.employee_code} ${e.job_title ?? ''}`.toLowerCase().includes(search.toLowerCase())),
    [employees, hotelFilter, statusFilter, search]);

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...draftCols]));
    setShowColPicker(false);
  }

  function resetDraft() {
    setDraftCols(new Set(DEFAULT_VISIBLE));
  }

  function resetCols() {
    setVisibleCols(new Set(DEFAULT_VISIBLE));
    localStorage.removeItem(STORAGE_KEY);
  }

  async function runCalculateBurden() {
    if (!filtered.length) return;
    const confirmed = window.confirm(
      `Calculate burden for ${filtered.length} employee${filtered.length === 1 ? '' : 's'}?\n\nThis will update: Provident Fund (EE + ER), UIF, SDL, WCA, Staff Meals, and Leave Accrual for the latest salary period of each employee.`
    );
    if (!confirmed) return;

    setCalculating(true);
    await Promise.all(
      filtered.map(async emp => {
        const hotel = hotelMap.get(emp.hotel_id);
        const sal   = latestSalary.get(emp.id);
        if (!hotel || !sal) return;

        const burden = calculateBurden({
          basic:              sal.basic_salary,
          totalEarnings:      sal.total_earnings,
          jobTitle:           emp.job_title,
          country:            hotel.country,
          wcaRate:            hotel.wca_rate ?? 0,
          taxPaye:            sal.tax_paye,
          medicalEmployee:    sal.medical_employee,
          medicalCompany:     sal.medical_company,
          ancillaEmployee:    sal.ancilla_employee,
          ancillaCompany:     sal.ancilla_company,
          bonusProvision:     sal.bonus_provision,
          leaveProvision:     sal.leave_provision,
          otherCompanyContrib:sal.other_company_contrib,
          mgmtIncentive:      sal.mgmt_incentive,
          bonusAccrualDec:    sal.bonus_accrual_dec,
          bonusAccrualJuly:   sal.bonus_accrual_july,
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
          leave_days:           burden.leave_days,
          leave_accrual:        burden.leave_accrual,
          total_company_contrib:burden.total_company_contrib,
          total_payroll_burden: burden.total_payroll_burden,
          total_cost:           burden.total_cost,
        }).eq('id', sal.id);
      })
    );

    await load();
    setCalculating(false);
    setCalcDone(true);
    setTimeout(() => setCalcDone(false), 3000);
  }

  const visibleDefs = useMemo(() => {
    if (categoryView === 'all') return ALL_COLUMNS.filter(c => visibleCols.has(c.id));
    const anchorDefs = ALL_COLUMNS.filter(c => ANCHOR_COLS.includes(c.id));
    const catDefs = ALL_COLUMNS.filter(c => c.group === categoryView);
    return [...anchorDefs, ...catDefs];
  }, [categoryView, visibleCols]);

  const totals = useMemo(() => {
    const map: Partial<Record<ColId, number>> = {};
    for (const col of visibleDefs) {
      if (col.align !== 'right') continue;
      let sum = 0;
      for (const emp of filtered) {
        const sal = latestSalary.get(emp.id);
        const v = numericValue(col.id, emp, sal);
        if (v != null) sum += v;
      }
      map[col.id] = sum;
    }
    return map;
  }, [filtered, visibleDefs, latestSalary]);

  // Cell renderer per column
  function cellValue(col: ColId, e: Employee, sal: SalaryRecord | undefined): React.ReactNode {
    const yrs = yearsOfService(e.employment_date);
    switch (col) {
      case 'surname':         return <span className="font-medium">{e.surname}</span>;
      case 'name':            return e.first_name;
      case 'hotel':           return hotelMap.get(e.hotel_id)?.short_code ?? '—';
      case 'department':      return e.department_code ?? '—';
      case 'title':           return e.job_title ?? '—';
      case 'status':          return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${e.status === 'active' ? 'bg-green-50 text-green-700' : e.status === 'terminated' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
          {e.status}
        </span>);
      case 'employment_date': return e.employment_date ? new Date(e.employment_date).toLocaleDateString('en-ZA') : '—';
      case 'years_service':   return yrs != null ? `${yrs}` : '—';
      // Salary fields
      case 'structure':       return e.grade_label ?? '—';
      case 'basic':           return sal ? fmtZAR(sal.basic_salary) : '—';
      case 'gross_salary':    return sal ? fmtZAR(sal.total_earnings) : '—';
      case 'ctc':             return sal ? fmtZAR(sal.ctc) : '—';
      case 'uif_emp':         return sal ? fmtZAR(sal.uif_employee) : '—';
      case 'medical_emp':     return sal ? fmtZAR(sal.medical_employee) : '—';
      case 'provident_emp':   return sal ? fmtZAR(sal.provident_employee) : '—';
      case 'uif_co':          return sal ? fmtZAR(sal.uif_company) : '—';
      case 'medical_co':      return sal ? fmtZAR(sal.medical_company) : '—';
      case 'provident_co':    return sal ? fmtZAR(sal.provident_company) : '—';
      case 'sdl':             return sal ? fmtZAR(sal.sdl_company) : '—';
      case 'wca':             return sal ? fmtZAR(sal.wca_company) : '—';
      case 'staff_meals':     return sal ? fmtZAR(sal.staff_meals) : '—';
      case 'bonus_provision': return sal ? fmtZAR(sal.bonus_provision) : '—';
      case 'incentive':       return sal ? fmtZAR(sal.incentive) : '—';
      case 'leave_provision': return sal ? fmtZAR(sal.leave_provision) : '—';
      case 'leave_accrual':   return sal ? fmtZAR(sal.leave_accrual) : '—';
      case 'bonus_accrual_dec': return sal ? fmtZAR(sal.bonus_accrual_dec) : '—';
      case 'mgmt_incentive':  return sal ? fmtZAR(sal.mgmt_incentive) : '—';
    }
  }

  const groups = [...new Set(ALL_COLUMNS.map(c => c.group))];

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Employees</h1>
          <p className="text-muted-foreground text-sm mt-1">{filtered.length} records</p>
        </div>
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
          <option value="all">All Hotels</option>
          {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>

        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="terminated">Terminated</option>
          <option value="on_leave">On Leave</option>
        </select>

        {/* Category sum view */}
        <select
          value={categoryView}
          onChange={e => setCategoryView(e.target.value as CategoryView)}
          className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
        >
          <option value="all">All Columns</option>
          <option value="Deductions">Sum: Deductions</option>
          <option value="Contributions">Sum: Contributions</option>
          <option value="Provisions">Sum: Provisions</option>
          <option value="Accruals">Sum: Accruals</option>
        </select>

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

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b bg-muted/40">
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
              <tr><td colSpan={visibleDefs.length + 1} className="text-center py-12 text-muted-foreground">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={visibleDefs.length + 1} className="text-center py-12 text-muted-foreground">No employees found. Import a payroll file to get started.</td></tr>
            ) : (
              filtered.map((e, i) => {
                const sal = latestSalary.get(e.id);
                return (
                  <tr key={e.id} className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                    {visibleDefs.map(col => (
                      <td key={col.id} className={`px-4 py-2.5 text-sm ${col.align === 'right' ? 'text-right font-mono' : ''}`}>
                        {cellValue(col.id, e, sal)}
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
          {categoryView !== 'all' && filtered.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                {visibleDefs.map((col, i) => (
                  <td key={col.id} className={`px-4 py-2.5 text-sm ${col.align === 'right' ? 'text-right font-mono' : ''}`}>
                    {i === 0 ? `Total (${filtered.length})` : col.align === 'right' ? fmtZAR(totals[col.id] ?? 0) : ''}
                  </td>
                ))}
                <td className="px-4 py-2.5" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
