'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Hotel, Employee, SalaryRecord, IncreaseScenario, ScenarioLine } from '@/types/database';
import { sortHotels, MONTH_NAMES } from '@/lib/utils';
import { isBotswana } from '@/lib/payroll-calc';
import { Download } from 'lucide-react';
import { exportReport, ReportSheet } from '@/lib/reports-export';

// ── Types ─────────────────────────────────────────────────────────────────────

type ReportCategory = 'headcount' | 'payroll' | 'salary' | 'increases';

type ReportType =
  | 'headcount_summary'
  | 'employee_roster'
  | 'tenure_analysis'
  | 'payroll_cost_summary'
  | 'payroll_burden_breakdown'
  | 'department_cost'
  | 'salary_distribution'
  | 'individual_salary'
  | 'nmw_proximity'
  | 'committed_increases'
  | 'before_after_detail';

interface Filters {
  hotelIds: string[];
  statuses: ('active' | 'terminated' | 'on_leave')[];
  grades: string[];
  periodYear: number;
  periodMonth: number;
  periodToYear: number;
  periodToMonth: number;
  nmwMonthly: string;
  nmwThreshold: string;
  scenarioId: string;
  rosterCols: string[];
}

interface PreviewRow {
  cells: Array<string | number | null>;
  isTotals?: boolean;
}

interface PreviewData {
  headers: string[];
  rows: PreviewRow[];
  totalRows: number;
  summaryLine?: string;
}

// ── Report catalog ────────────────────────────────────────────────────────────

const REPORT_CATALOG: { id: ReportType; label: string; category: ReportCategory; desc: string }[] = [
  { id: 'headcount_summary',        category: 'headcount', label: 'Headcount Summary',       desc: 'Counts by hotel and grade, split by employment status.' },
  { id: 'employee_roster',          category: 'headcount', label: 'Employee Roster',          desc: 'Configurable employee listing with salary data.' },
  { id: 'tenure_analysis',          category: 'headcount', label: 'Tenure Analysis',          desc: 'Years-of-service distribution across tenure bands.' },
  { id: 'payroll_cost_summary',     category: 'payroll',   label: 'Payroll Cost Summary',     desc: 'Monthly cost totals by hotel across a date range.' },
  { id: 'payroll_burden_breakdown', category: 'payroll',   label: 'Burden Breakdown',         desc: 'All statutory and provision components for a selected period.' },
  { id: 'department_cost',          category: 'payroll',   label: 'Department Cost',          desc: 'Cost grouped by department for a selected period.' },
  { id: 'salary_distribution',      category: 'salary',    label: 'Salary Distribution',      desc: 'Min / avg / max basic and CTC per grade.' },
  { id: 'individual_salary',        category: 'salary',    label: 'Individual Salary Detail', desc: 'Full salary record per employee for a selected period.' },
  { id: 'nmw_proximity',            category: 'salary',    label: 'NMW Proximity',            desc: 'Flags SA employees within a threshold of the National Minimum Wage.' },
  { id: 'committed_increases',      category: 'increases', label: 'Committed Increases',      desc: 'Summary of all committed salary scenarios.' },
  { id: 'before_after_detail',      category: 'increases', label: 'Before / After Detail',    desc: 'Per-employee results for a selected committed scenario.' },
];

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  headcount: 'Headcount',
  payroll:   'Payroll Cost',
  salary:    'Salary Analysis',
  increases: 'Increases & Reviews',
};

interface FilterConfig {
  hotels: boolean; status: boolean; grade: boolean;
  periodSingle: boolean; periodRange: boolean;
  nmw: boolean; scenario: boolean; rosterCols: boolean;
}

const FILTER_CFG: Record<ReportType, FilterConfig> = {
  headcount_summary:        { hotels: true,  status: true,  grade: true,  periodSingle: false, periodRange: false, nmw: false, scenario: false, rosterCols: false },
  employee_roster:          { hotels: true,  status: true,  grade: true,  periodSingle: false, periodRange: false, nmw: false, scenario: false, rosterCols: true  },
  tenure_analysis:          { hotels: true,  status: true,  grade: false, periodSingle: false, periodRange: false, nmw: false, scenario: false, rosterCols: false },
  payroll_cost_summary:     { hotels: true,  status: false, grade: false, periodSingle: false, periodRange: true,  nmw: false, scenario: false, rosterCols: false },
  payroll_burden_breakdown: { hotels: true,  status: false, grade: false, periodSingle: true,  periodRange: false, nmw: false, scenario: false, rosterCols: false },
  department_cost:          { hotels: true,  status: false, grade: false, periodSingle: true,  periodRange: false, nmw: false, scenario: false, rosterCols: false },
  salary_distribution:      { hotels: true,  status: false, grade: true,  periodSingle: false, periodRange: false, nmw: false, scenario: false, rosterCols: false },
  individual_salary:        { hotels: true,  status: true,  grade: false, periodSingle: true,  periodRange: false, nmw: false, scenario: false, rosterCols: false },
  nmw_proximity:            { hotels: true,  status: true,  grade: false, periodSingle: false, periodRange: false, nmw: true,  scenario: false, rosterCols: false },
  committed_increases:      { hotels: true,  status: false, grade: false, periodSingle: false, periodRange: false, nmw: false, scenario: false, rosterCols: false },
  before_after_detail:      { hotels: false, status: false, grade: false, periodSingle: false, periodRange: false, nmw: false, scenario: true,  rosterCols: false },
};

const ROSTER_COLS: { id: string; label: string; default: boolean }[] = [
  { id: 'employee_code',        label: 'Emp Code',       default: true  },
  { id: 'surname',              label: 'Surname',        default: true  },
  { id: 'first_name',           label: 'First Name',     default: true  },
  { id: 'hotel',                label: 'Hotel',          default: true  },
  { id: 'department_code',      label: 'Department',     default: true  },
  { id: 'job_title',            label: 'Job Title',      default: true  },
  { id: 'grade_label',          label: 'Grade',          default: true  },
  { id: 'status',               label: 'Status',         default: false },
  { id: 'employment_date',      label: 'Start Date',     default: false },
  { id: 'years_service',        label: 'Yrs Service',    default: false },
  { id: 'basic_salary',         label: 'Basic Salary',   default: true  },
  { id: 'total_earnings',       label: 'Gross Salary',   default: false },
  { id: 'ctc',                  label: 'CTC',            default: true  },
  { id: 'net_salary',           label: 'Net Pay',        default: false },
  { id: 'tax_paye',             label: 'Tax (PAYE)',     default: false },
  { id: 'uif_employee',         label: 'UIF (EE)',       default: false },
  { id: 'provident_employee',   label: 'PF (EE)',        default: false },
  { id: 'medical_company',      label: 'Medical (Co)',   default: false },
  { id: 'provident_company',    label: 'PF (Co)',        default: false },
  { id: 'sdl_company',          label: 'SDL',            default: false },
  { id: 'wca_company',          label: 'WCA',            default: false },
  { id: 'staff_meals',          label: 'Staff Meals',    default: false },
  { id: 'leave_accrual',        label: 'Leave Accrual',  default: false },
  { id: 'bonus_provision',      label: 'Bonus Prov.',    default: false },
  { id: 'total_payroll_burden', label: 'Total Burden',   default: false },
  { id: 'comments',             label: 'Comments',       default: false },
];

const GRADE_ORDER = ['ANO', 'FTC', 'DNQ', 'Frontline', 'Supervisory', 'Management', 'Executive'];
const TENURE_ORDER = ['< 1 yr', '1–3 yrs', '3–5 yrs', '5–10 yrs', '10+ yrs'];
const STATUS_LABELS: Record<string, string> = { active: 'Active', terminated: 'Terminated', on_leave: 'On Leave' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function latestRecord(records: SalaryRecord[], empId: string): SalaryRecord | undefined {
  return records
    .filter(r => r.employee_id === empId)
    .sort((a, b) => b.period_year !== a.period_year ? b.period_year - a.period_year : b.period_month - a.period_month)[0];
}

function pKey(y: number, m: number) { return y * 100 + m; }

function inRange(r: SalaryRecord, fy: number, fm: number, ty: number, tm: number) {
  const k = pKey(r.period_year, r.period_month);
  return k >= pKey(fy, fm) && k <= pKey(ty, tm);
}

function yos(d: string | null): number {
  if (!d) return 0;
  return Math.floor((Date.now() - new Date(d).getTime()) / (365.25 * 86400000) * 10) / 10;
}

function tenureBand(y: number): string {
  if (y < 1)  return '< 1 yr';
  if (y < 3)  return '1–3 yrs';
  if (y < 5)  return '3–5 yrs';
  if (y < 10) return '5–10 yrs';
  return '10+ yrs';
}

function sumN(arr: number[]): number { return arr.reduce((s, v) => s + v, 0); }
function avgN(arr: number[]): number { return arr.length ? sumN(arr) / arr.length : 0; }
function pLabel(y: number, m: number): string { return `${MONTH_NAMES[m - 1]} ${y}`; }

function sortGrades(grades: string[]): string[] {
  return [...grades].sort((a, b) => {
    const ia = GRADE_ORDER.indexOf(a) === -1 ? 999 : GRADE_ORDER.indexOf(a);
    const ib = GRADE_ORDER.indexOf(b) === -1 ? 999 : GRADE_ORDER.indexOf(b);
    return ia - ib;
  });
}

function filterEmps(employees: Employee[], f: Filters): Employee[] {
  return employees.filter(e =>
    (f.hotelIds.length === 0 || f.hotelIds.includes(e.hotel_id)) &&
    (f.statuses.length === 0 || f.statuses.includes(e.status)) &&
    (f.grades.length   === 0 || f.grades.includes(e.grade_label ?? 'Unclassified'))
  );
}

function filterRecordsPeriod(
  records: SalaryRecord[], f: Filters, empHotelMap: Map<string, string>,
): SalaryRecord[] {
  return records.filter(r => {
    const hid = empHotelMap.get(r.employee_id);
    return hid &&
      (f.hotelIds.length === 0 || f.hotelIds.includes(hid)) &&
      r.period_year === f.periodYear && r.period_month === f.periodMonth;
  });
}

function filterRecordsRange(
  records: SalaryRecord[], f: Filters, empHotelMap: Map<string, string>,
): SalaryRecord[] {
  return records.filter(r => {
    const hid = empHotelMap.get(r.employee_id);
    return hid &&
      (f.hotelIds.length === 0 || f.hotelIds.includes(hid)) &&
      inRange(r, f.periodYear, f.periodMonth, f.periodToYear, f.periodToMonth);
  });
}

// ── Compute functions ─────────────────────────────────────────────────────────

function computeHeadcountSummary(employees: Employee[], hotels: Hotel[], f: Filters): PreviewData {
  const emps = employees.filter(e =>
    (f.hotelIds.length === 0 || f.hotelIds.includes(e.hotel_id)) &&
    (f.statuses.length === 0 || f.statuses.includes(e.status))
  );

  const tree = new Map<string, Map<string, Employee[]>>();
  for (const e of emps) {
    if (!tree.has(e.hotel_id)) tree.set(e.hotel_id, new Map());
    const g = e.grade_label ?? 'Unclassified';
    const gm = tree.get(e.hotel_id)!;
    if (!gm.has(g)) gm.set(g, []);
    gm.get(g)!.push(e);
  }

  const headers = ['Hotel', 'Grade', 'Active', 'On Leave', 'Terminated', 'Total'];
  const rows: PreviewRow[] = [];
  const sortedH = sortHotels(hotels.filter(h => tree.has(h.id)));

  for (const hotel of sortedH) {
    const gm = tree.get(hotel.id)!;
    for (const g of sortGrades([...gm.keys()])) {
      const list = gm.get(g)!;
      rows.push({ cells: [
        hotel.name, g,
        list.filter(e => e.status === 'active').length,
        list.filter(e => e.status === 'on_leave').length,
        list.filter(e => e.status === 'terminated').length,
        list.length,
      ]});
    }
    const all = [...gm.values()].flat();
    rows.push({ isTotals: true, cells: [
      `${hotel.name} — Total`, '',
      all.filter(e => e.status === 'active').length,
      all.filter(e => e.status === 'on_leave').length,
      all.filter(e => e.status === 'terminated').length,
      all.length,
    ]});
  }

  const active = emps.filter(e => e.status === 'active').length;
  const leave  = emps.filter(e => e.status === 'on_leave').length;
  const term   = emps.filter(e => e.status === 'terminated').length;
  rows.push({ isTotals: true, cells: ['GRAND TOTAL', '', active, leave, term, emps.length] });

  return {
    headers, rows, totalRows: rows.length,
    summaryLine: `${emps.length} employees across ${sortedH.length} hotels`,
  };
}

function computeEmployeeRoster(
  employees: Employee[], hotels: Hotel[], records: SalaryRecord[],
  f: Filters, hotelMap: Map<string, Hotel>,
): PreviewData {
  const colDefs = ROSTER_COLS.filter(c => f.rosterCols.includes(c.id));
  const emps = filterEmps(employees, f)
    .sort((a, b) => {
      const ha = hotelMap.get(a.hotel_id)?.name ?? '';
      const hb = hotelMap.get(b.hotel_id)?.name ?? '';
      return ha !== hb ? ha.localeCompare(hb) : a.surname.localeCompare(b.surname);
    });

  const rows: PreviewRow[] = emps.map(e => {
    const sr    = latestRecord(records, e.id);
    const hotel = hotelMap.get(e.hotel_id);
    return {
      cells: colDefs.map(col => {
        switch (col.id) {
          case 'employee_code':        return e.employee_code ?? '';
          case 'surname':              return e.surname;
          case 'first_name':           return e.first_name;
          case 'hotel':                return hotel?.name ?? '';
          case 'department_code':      return e.department_code ?? '';
          case 'job_title':            return e.job_title ?? '';
          case 'grade_label':          return e.grade_label ?? 'Unclassified';
          case 'status':               return STATUS_LABELS[e.status] ?? e.status;
          case 'employment_date':      return e.employment_date ?? '';
          case 'years_service':        return +yos(e.employment_date).toFixed(1);
          case 'basic_salary':         return sr?.basic_salary ?? null;
          case 'total_earnings':       return sr?.total_earnings ?? null;
          case 'ctc':                  return sr?.ctc ?? null;
          case 'net_salary':           return sr?.net_salary ?? null;
          case 'tax_paye':             return sr?.tax_paye ?? null;
          case 'uif_employee':         return sr?.uif_employee ?? null;
          case 'provident_employee':   return sr?.provident_employee ?? null;
          case 'medical_company':      return sr?.medical_company ?? null;
          case 'provident_company':    return sr?.provident_company ?? null;
          case 'sdl_company':          return sr?.sdl_company ?? null;
          case 'wca_company':          return sr?.wca_company ?? null;
          case 'staff_meals':          return sr?.staff_meals ?? null;
          case 'leave_accrual':        return sr?.leave_accrual ?? null;
          case 'bonus_provision':      return sr?.bonus_provision ?? null;
          case 'total_payroll_burden': return sr?.total_payroll_burden ?? null;
          case 'comments':             return e.comments ?? '';
          default:                     return null;
        }
      }),
    };
  });

  return {
    headers: colDefs.map(c => c.label), rows, totalRows: rows.length,
    summaryLine: `${emps.length} employees`,
  };
}

function computeTenureAnalysis(
  employees: Employee[], hotels: Hotel[], records: SalaryRecord[],
  f: Filters, hotelMap: Map<string, Hotel>,
): PreviewData {
  const emps = employees.filter(e =>
    (f.hotelIds.length === 0 || f.hotelIds.includes(e.hotel_id)) &&
    (f.statuses.length === 0 || f.statuses.includes(e.status))
  );

  const tree = new Map<string, Map<string, Array<{ emp: Employee; y: number }>>>();
  for (const e of emps) {
    if (!tree.has(e.hotel_id)) tree.set(e.hotel_id, new Map());
    const tm   = tree.get(e.hotel_id)!;
    const y    = yos(e.employment_date);
    const band = tenureBand(y);
    if (!tm.has(band)) tm.set(band, []);
    tm.get(band)!.push({ emp: e, y });
  }

  const headers = ['Hotel', 'Tenure Band', 'Count', 'Avg Years', 'Avg Basic', 'Total Basic'];
  const rows: PreviewRow[] = [];
  const sortedH = sortHotels(hotels.filter(h => tree.has(h.id)));

  for (const hotel of sortedH) {
    const tm = tree.get(hotel.id)!;
    for (const band of TENURE_ORDER.filter(b => tm.has(b))) {
      const list   = tm.get(band)!;
      const basics = list.map(x => latestRecord(records, x.emp.id)?.basic_salary ?? 0);
      rows.push({ cells: [
        hotel.name, band, list.length,
        +avgN(list.map(x => x.y)).toFixed(1),
        Math.round(avgN(basics.filter(b => b > 0))),
        sumN(basics),
      ]});
    }
    const all      = [...tm.values()].flat();
    const allBasic = all.map(x => latestRecord(records, x.emp.id)?.basic_salary ?? 0);
    rows.push({ isTotals: true, cells: [
      `${hotel.name} — Total`, '', all.length,
      +avgN(all.map(x => x.y)).toFixed(1),
      Math.round(avgN(allBasic.filter(b => b > 0))),
      sumN(allBasic),
    ]});
  }

  return { headers, rows, totalRows: rows.length, summaryLine: `${emps.length} employees` };
}

function computePayrollCostSummary(
  records: SalaryRecord[], hotels: Hotel[], f: Filters, empHotelMap: Map<string, string>,
): PreviewData {
  const filtered = filterRecordsRange(records, f, empHotelMap);

  // hotel → periodKey → records
  const tree = new Map<string, Map<number, SalaryRecord[]>>();
  for (const r of filtered) {
    const hid = empHotelMap.get(r.employee_id)!;
    if (!tree.has(hid)) tree.set(hid, new Map());
    const pm = tree.get(hid)!;
    const pk = pKey(r.period_year, r.period_month);
    if (!pm.has(pk)) pm.set(pk, []);
    pm.get(pk)!.push(r);
  }

  const headers = ['Hotel', 'Period', 'Headcount', 'Total Basic', 'Total Gross', 'Total CTC', 'Total Burden'];
  const rows: PreviewRow[] = [];
  const sortedH = sortHotels(hotels.filter(h => tree.has(h.id)));

  for (const hotel of sortedH) {
    const pm         = tree.get(hotel.id)!;
    const sortedPks  = [...pm.keys()].sort((a, b) => a - b);
    for (const pk of sortedPks) {
      const rs = pm.get(pk)!;
      const y  = Math.floor(pk / 100);
      const m  = pk % 100;
      rows.push({ cells: [
        hotel.name, pLabel(y, m), rs.length,
        sumN(rs.map(r => r.basic_salary)),
        sumN(rs.map(r => r.total_earnings)),
        sumN(rs.map(r => r.ctc)),
        sumN(rs.map(r => r.total_payroll_burden)),
      ]});
    }
    const allRs = [...pm.values()].flat();
    rows.push({ isTotals: true, cells: [
      `${hotel.name} — Total`, `${pm.size} period(s)`, '—',
      sumN(allRs.map(r => r.basic_salary)),
      sumN(allRs.map(r => r.total_earnings)),
      sumN(allRs.map(r => r.ctc)),
      sumN(allRs.map(r => r.total_payroll_burden)),
    ]});
  }

  return {
    headers, rows, totalRows: rows.length,
    summaryLine: `${filtered.length} salary records — ${pLabel(f.periodYear, f.periodMonth)} to ${pLabel(f.periodToYear, f.periodToMonth)}`,
  };
}

function computePayrollBurdenBreakdown(
  records: SalaryRecord[], hotels: Hotel[], f: Filters, empHotelMap: Map<string, string>,
): PreviewData {
  const filtered = filterRecordsPeriod(records, f, empHotelMap);

  const byHotel = new Map<string, SalaryRecord[]>();
  for (const r of filtered) {
    const hid = empHotelMap.get(r.employee_id)!;
    if (!byHotel.has(hid)) byHotel.set(hid, []);
    byHotel.get(hid)!.push(r);
  }

  const headers = [
    'Hotel', 'Count', 'Basic',
    'UIF (EE)', 'UIF (Co)', 'SDL', 'WCA',
    'PF (EE)', 'PF (Co)', 'Medical (Co)',
    'Staff Meals', 'Leave Accrual', 'Bonus Prov.', 'Incentive', 'Severance', 'Gratuity',
    'Total Burden',
  ];
  const rows: PreviewRow[] = [];
  const sortedH = sortHotels(hotels.filter(h => byHotel.has(h.id)));

  const colSums = new Array(headers.length - 1).fill(0);

  for (const hotel of sortedH) {
    const rs   = byHotel.get(hotel.id)!;
    const cols = [
      rs.length,
      sumN(rs.map(r => r.basic_salary)),
      sumN(rs.map(r => r.uif_employee)),
      sumN(rs.map(r => r.uif_company)),
      sumN(rs.map(r => r.sdl_company)),
      sumN(rs.map(r => r.wca_company)),
      sumN(rs.map(r => r.provident_employee)),
      sumN(rs.map(r => r.provident_company)),
      sumN(rs.map(r => r.medical_company)),
      sumN(rs.map(r => r.staff_meals)),
      sumN(rs.map(r => r.leave_accrual)),
      sumN(rs.map(r => r.bonus_provision)),
      sumN(rs.map(r => r.incentive)),
      sumN(rs.map(r => r.severance)),
      sumN(rs.map(r => r.gratuity)),
      sumN(rs.map(r => r.total_payroll_burden)),
    ];
    cols.forEach((v, i) => { if (typeof v === 'number') colSums[i] += v; });
    rows.push({ cells: [hotel.name, ...cols] });
  }

  if (sortedH.length > 1) {
    rows.push({ isTotals: true, cells: ['GRAND TOTAL', ...colSums] });
  }

  return {
    headers, rows, totalRows: rows.length,
    summaryLine: `${filtered.length} employees — ${pLabel(f.periodYear, f.periodMonth)}`,
  };
}

function computeDepartmentCost(
  records: SalaryRecord[], employees: Employee[], hotels: Hotel[],
  f: Filters, empMap: Map<string, Employee>, empHotelMap: Map<string, string>,
): PreviewData {
  const filtered = filterRecordsPeriod(records, f, empHotelMap);

  const tree = new Map<string, SalaryRecord[]>(); // key = hotelId||dept
  for (const r of filtered) {
    const hid  = empHotelMap.get(r.employee_id)!;
    const dept = empMap.get(r.employee_id)?.department_code ?? 'Unassigned';
    const key  = `${hid}||${dept}`;
    if (!tree.has(key)) tree.set(key, []);
    tree.get(key)!.push(r);
  }

  const headers = ['Hotel', 'Department', 'Headcount', 'Total Basic', 'Total Gross', 'Total CTC', 'Total Burden'];
  const rows: PreviewRow[] = [];
  const sortedH = sortHotels(hotels);

  for (const hotel of sortedH) {
    const hotelKeys = [...tree.keys()].filter(k => k.startsWith(hotel.id + '||'));
    if (!hotelKeys.length) continue;
    const depts = hotelKeys.map(k => k.split('||')[1]).sort();
    for (const dept of depts) {
      const rs = tree.get(`${hotel.id}||${dept}`)!;
      rows.push({ cells: [
        hotel.name, dept, rs.length,
        sumN(rs.map(r => r.basic_salary)),
        sumN(rs.map(r => r.total_earnings)),
        sumN(rs.map(r => r.ctc)),
        sumN(rs.map(r => r.total_payroll_burden)),
      ]});
    }
    const allRs = hotelKeys.flatMap(k => tree.get(k)!);
    rows.push({ isTotals: true, cells: [
      `${hotel.name} — Total`, `${hotelKeys.length} depts`, allRs.length,
      sumN(allRs.map(r => r.basic_salary)),
      sumN(allRs.map(r => r.total_earnings)),
      sumN(allRs.map(r => r.ctc)),
      sumN(allRs.map(r => r.total_payroll_burden)),
    ]});
  }

  return {
    headers, rows, totalRows: rows.length,
    summaryLine: `${filtered.length} employees — ${pLabel(f.periodYear, f.periodMonth)}`,
  };
}

function computeSalaryDistribution(
  employees: Employee[], hotels: Hotel[], records: SalaryRecord[],
  f: Filters, hotelMap: Map<string, Hotel>,
): PreviewData {
  const emps = employees.filter(e =>
    e.status === 'active' &&
    (f.hotelIds.length === 0 || f.hotelIds.includes(e.hotel_id)) &&
    (f.grades.length   === 0 || f.grades.includes(e.grade_label ?? 'Unclassified'))
  );

  const tree = new Map<string, Map<string, Employee[]>>();
  for (const e of emps) {
    if (!tree.has(e.hotel_id)) tree.set(e.hotel_id, new Map());
    const g  = e.grade_label ?? 'Unclassified';
    const gm = tree.get(e.hotel_id)!;
    if (!gm.has(g)) gm.set(g, []);
    gm.get(g)!.push(e);
  }

  const headers = ['Hotel', 'Grade', 'Count', 'Min Basic', 'Avg Basic', 'Max Basic', 'Min CTC', 'Avg CTC', 'Max CTC'];
  const rows: PreviewRow[] = [];
  const sortedH = sortHotels(hotels.filter(h => tree.has(h.id)));

  for (const hotel of sortedH) {
    const gm = tree.get(hotel.id)!;
    for (const g of sortGrades([...gm.keys()])) {
      const list   = gm.get(g)!;
      const basics = list.map(e => latestRecord(records, e.id)?.basic_salary ?? 0).filter(v => v > 0);
      const ctcs   = list.map(e => latestRecord(records, e.id)?.ctc ?? 0).filter(v => v > 0);
      rows.push({ cells: [
        hotel.name, g, list.length,
        basics.length ? Math.min(...basics) : null,
        basics.length ? Math.round(avgN(basics)) : null,
        basics.length ? Math.max(...basics) : null,
        ctcs.length ? Math.min(...ctcs) : null,
        ctcs.length ? Math.round(avgN(ctcs)) : null,
        ctcs.length ? Math.max(...ctcs) : null,
      ]});
    }
  }

  return { headers, rows, totalRows: rows.length, summaryLine: `${emps.length} active employees` };
}

function computeIndividualSalary(
  employees: Employee[], hotels: Hotel[], records: SalaryRecord[],
  f: Filters, hotelMap: Map<string, Hotel>,
): PreviewData {
  const emps = filterEmps(employees, { ...f, grades: [] })
    .sort((a, b) => {
      const ha = hotelMap.get(a.hotel_id)?.name ?? '';
      const hb = hotelMap.get(b.hotel_id)?.name ?? '';
      return ha !== hb ? ha.localeCompare(hb) : a.surname.localeCompare(b.surname);
    });

  const headers = [
    'Hotel', 'Emp Code', 'Surname', 'First Name', 'Grade', 'Period',
    'Basic', 'Gross', 'CTC', 'Net Pay', 'Tax (PAYE)',
    'UIF (EE)', 'UIF (Co)', 'PF (EE)', 'PF (Co)', 'Medical (Co)',
    'SDL', 'WCA', 'Staff Meals', 'Leave Accrual', 'Bonus Prov.',
    'Incentive', 'Severance', 'Gratuity', 'Total Burden',
  ];
  const rows: PreviewRow[] = [];

  for (const e of emps) {
    const sr = records.find(r =>
      r.employee_id === e.id &&
      r.period_year === f.periodYear && r.period_month === f.periodMonth
    ) ?? latestRecord(records, e.id);
    if (!sr) continue;

    const hotel = hotelMap.get(e.hotel_id);
    rows.push({ cells: [
      hotel?.name ?? '', e.employee_code ?? '', e.surname, e.first_name,
      e.grade_label ?? 'Unclassified', pLabel(sr.period_year, sr.period_month),
      sr.basic_salary, sr.total_earnings, sr.ctc, sr.net_salary, sr.tax_paye,
      sr.uif_employee, sr.uif_company, sr.provident_employee, sr.provident_company, sr.medical_company,
      sr.sdl_company, sr.wca_company, sr.staff_meals, sr.leave_accrual, sr.bonus_provision,
      sr.incentive, sr.severance, sr.gratuity, sr.total_payroll_burden,
    ]});
  }

  return { headers, rows, totalRows: rows.length, summaryLine: `${rows.length} employees with records` };
}

function computeNmwProximity(
  employees: Employee[], hotels: Hotel[], records: SalaryRecord[],
  f: Filters, hotelMap: Map<string, Hotel>,
): PreviewData {
  const nmw       = parseFloat(f.nmwMonthly) || 0;
  const threshold = (parseFloat(f.nmwThreshold) || 20) / 100;

  const saEmps = employees.filter(e => {
    const hotel = hotelMap.get(e.hotel_id);
    return hotel &&
      !isBotswana(hotel.country) &&
      hotel.short_code !== 'APA' &&
      (f.hotelIds.length === 0 || f.hotelIds.includes(e.hotel_id)) &&
      (f.statuses.length === 0 || f.statuses.includes(e.status));
  });

  const headers = ['Hotel', 'Emp Code', 'Surname', 'First Name', 'Job Title', 'Basic', 'NMW Ref', 'R Above NMW', '% Above NMW', 'Status'];

  type NmwRow = { emp: Employee; hotel: Hotel | undefined; basic: number; aboveR: number; abovePct: number | null; atRisk: boolean };

  const computed: NmwRow[] = saEmps.map(e => {
    const basic   = latestRecord(records, e.id)?.basic_salary ?? 0;
    const hotel   = hotelMap.get(e.hotel_id);
    const aboveR  = basic - nmw;
    const abovePct = nmw > 0 ? (aboveR / nmw) * 100 : null;
    const atRisk  = nmw > 0 && aboveR < nmw * threshold;
    return { emp: e, hotel, basic, aboveR, abovePct, atRisk };
  });

  computed.sort((a, b) => (a.abovePct ?? 999) - (b.abovePct ?? 999));

  const rows: PreviewRow[] = computed.map(({ emp, hotel, basic, aboveR, abovePct, atRisk }) => ({
    cells: [
      hotel?.name ?? '', emp.employee_code ?? '', emp.surname, emp.first_name, emp.job_title ?? '',
      basic || null, nmw || null,
      nmw > 0 ? Math.round(aboveR) : null,
      abovePct !== null ? +abovePct.toFixed(1) : null,
      nmw > 0 ? (atRisk ? 'AT RISK' : 'OK') : '—',
    ],
  }));

  const atRiskCount = nmw > 0 ? computed.filter(r => r.atRisk).length : 0;
  return {
    headers, rows, totalRows: rows.length,
    summaryLine: nmw > 0
      ? `${saEmps.length} SA employees — ${atRiskCount} at risk (within ${f.nmwThreshold}% of NMW)`
      : `${saEmps.length} SA employees — enter an NMW reference amount to check proximity`,
  };
}

function computeCommittedIncreases(
  scenarios: IncreaseScenario[], lines: ScenarioLine[], hotels: Hotel[],
  f: Filters, hotelMap: Map<string, Hotel>,
): PreviewData {
  const filtered = scenarios.filter(s =>
    f.hotelIds.length === 0 || !s.hotel_id || f.hotelIds.includes(s.hotel_id)
  );

  const headers = ['Hotel', 'Effective Period', 'Scenario', 'Employees', 'Avg Increase %', 'Current Basic', 'New Basic', 'Basic Delta', 'Current CTC', 'New CTC', 'CTC Delta'];
  const rows: PreviewRow[] = filtered.map(s => {
    const sl       = lines.filter(l => l.scenario_id === s.id);
    const hotel    = s.hotel_id ? hotelMap.get(s.hotel_id) : null;
    const curBasic = sumN(sl.map(l => l.current_basic));
    const newBasic = sumN(sl.map(l => l.new_basic));
    const curCtc   = sumN(sl.map(l => l.current_ctc));
    const newCtc   = sumN(sl.map(l => l.new_ctc));
    const avgPct   = curBasic > 0 ? (newBasic - curBasic) / curBasic * 100 : 0;
    const period   = s.effective_month && s.effective_year ? pLabel(s.effective_year, s.effective_month) : '—';
    return { cells: [
      hotel?.name ?? 'All Hotels', period, s.name ?? '—', sl.length,
      +avgPct.toFixed(1), curBasic, newBasic, newBasic - curBasic,
      curCtc, newCtc, newCtc - curCtc,
    ]};
  });

  return { headers, rows, totalRows: rows.length, summaryLine: `${filtered.length} committed scenarios` };
}

function computeBeforeAfterDetail(
  scenarios: IncreaseScenario[], lines: ScenarioLine[],
  employees: Employee[], hotels: Hotel[], f: Filters,
): PreviewData {
  const scenario = scenarios.find(s => s.id === f.scenarioId);
  if (!scenario) {
    return { headers: ['Select a committed scenario in the Filters panel'], rows: [], totalRows: 0 };
  }

  const sl      = lines.filter(l => l.scenario_id === f.scenarioId);
  const empMap  = new Map(employees.map(e => [e.id, e]));
  const hotelMap = new Map(hotels.map(h => [h.id, h]));
  const sortedH  = sortHotels(hotels);
  const hotelIdx = new Map(sortedH.map((h, i) => [h.id, i]));

  const sortedLines = [...sl].sort((a, b) => {
    const ha = hotelIdx.get(a.hotel_id) ?? 999;
    const hb = hotelIdx.get(b.hotel_id) ?? 999;
    if (ha !== hb) return ha - hb;
    return (empMap.get(a.employee_id)?.surname ?? '').localeCompare(empMap.get(b.employee_id)?.surname ?? '');
  });

  const headers = [
    'Hotel', 'Emp Code', 'Surname', 'First Name', 'Grade', 'Department',
    'Before Basic', 'Increase %', 'After Basic', 'Monthly Inc',
    'Before CTC', 'After CTC', 'CTC Delta', 'Annual CTC Δ',
  ];

  const rows: PreviewRow[] = sortedLines.map(l => {
    const emp   = empMap.get(l.employee_id);
    const hotel = hotelMap.get(l.hotel_id);
    const pct   = l.current_basic > 0 ? (l.new_basic - l.current_basic) / l.current_basic * 100 : 0;
    return { cells: [
      hotel?.name ?? '', emp?.employee_code ?? '', emp?.surname ?? '', emp?.first_name ?? '',
      emp?.grade_label ?? 'Unclassified', emp?.department_code ?? '',
      l.current_basic, +pct.toFixed(1), l.new_basic, l.new_basic - l.current_basic,
      l.current_ctc, l.new_ctc, l.new_ctc - l.current_ctc, (l.new_ctc - l.current_ctc) * 12,
    ]};
  });

  const curBasic = sumN(sl.map(l => l.current_basic));
  const newBasic = sumN(sl.map(l => l.new_basic));
  const curCtc   = sumN(sl.map(l => l.current_ctc));
  const newCtc   = sumN(sl.map(l => l.new_ctc));
  const avgPct   = curBasic > 0 ? (newBasic - curBasic) / curBasic * 100 : 0;
  rows.push({ isTotals: true, cells: [
    'TOTAL', '', `${sl.length} employees`, '', '', '',
    curBasic, +avgPct.toFixed(1), newBasic, newBasic - curBasic,
    curCtc, newCtc, newCtc - curCtc, (newCtc - curCtc) * 12,
  ]});

  const period = scenario.effective_month && scenario.effective_year
    ? ` — Effective ${pLabel(scenario.effective_year, scenario.effective_month)}`
    : '';
  return { headers, rows, totalRows: rows.length, summaryLine: `${sl.length} employees${period}` };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function computeReport(
  type: ReportType, f: Filters,
  employees: Employee[], hotels: Hotel[], records: SalaryRecord[],
  scenarios: IncreaseScenario[], lines: ScenarioLine[],
  empMap: Map<string, Employee>, hotelMap: Map<string, Hotel>, empHotelMap: Map<string, string>,
): PreviewData {
  switch (type) {
    case 'headcount_summary':        return computeHeadcountSummary(employees, hotels, f);
    case 'employee_roster':          return computeEmployeeRoster(employees, hotels, records, f, hotelMap);
    case 'tenure_analysis':          return computeTenureAnalysis(employees, hotels, records, f, hotelMap);
    case 'payroll_cost_summary':     return computePayrollCostSummary(records, hotels, f, empHotelMap);
    case 'payroll_burden_breakdown': return computePayrollBurdenBreakdown(records, hotels, f, empHotelMap);
    case 'department_cost':          return computeDepartmentCost(records, employees, hotels, f, empMap, empHotelMap);
    case 'salary_distribution':      return computeSalaryDistribution(employees, hotels, records, f, hotelMap);
    case 'individual_salary':        return computeIndividualSalary(employees, hotels, records, f, hotelMap);
    case 'nmw_proximity':            return computeNmwProximity(employees, hotels, records, f, hotelMap);
    case 'committed_increases':      return computeCommittedIncreases(scenarios, lines, hotels, f, hotelMap);
    case 'before_after_detail':      return computeBeforeAfterDetail(scenarios, lines, employees, hotels, f);
  }
}

// ── FilterPanel ───────────────────────────────────────────────────────────────

interface FilterPanelProps {
  reportType: ReportType;
  filters: Filters;
  onChange: (p: Partial<Filters>) => void;
  hotels: Hotel[];
  salaryRecords: SalaryRecord[];
  scenarios: IncreaseScenario[];
}

function FilterPanel({ reportType, filters, onChange, hotels, salaryRecords, scenarios }: FilterPanelProps) {
  const cfg = FILTER_CFG[reportType];

  const years = useMemo(() => {
    const ys  = new Set(salaryRecords.map(r => r.period_year));
    const cur = new Date().getFullYear();
    ys.add(cur);
    return [...ys].sort((a, b) => a - b);
  }, [salaryRecords]);

  const chk = 'h-3.5 w-3.5 rounded border-gray-300 text-primary';
  const lbl = 'flex items-center gap-2 cursor-pointer text-sm';
  const sel = 'rounded border bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary';

  function toggleArr<T>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val];
  }

  return (
    <div className="space-y-5 text-sm">

      {/* Hotels */}
      {cfg.hotels && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Hotels</p>
          <div className="space-y-1.5">
            <label className={lbl}>
              <input type="checkbox" className={chk}
                checked={filters.hotelIds.length === 0}
                onChange={() => onChange({ hotelIds: [] })}
              />
              <span className="text-muted-foreground">All hotels</span>
            </label>
            {hotels.map(h => (
              <label key={h.id} className={lbl}>
                <input type="checkbox" className={chk}
                  checked={filters.hotelIds.includes(h.id)}
                  onChange={() => onChange({ hotelIds: toggleArr(filters.hotelIds, h.id) })}
                />
                <span>{h.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Status */}
      {cfg.status && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Status</p>
          <div className="space-y-1.5">
            {(['active', 'on_leave', 'terminated'] as const).map(s => (
              <label key={s} className={lbl}>
                <input type="checkbox" className={chk}
                  checked={filters.statuses.includes(s)}
                  onChange={() => onChange({ statuses: toggleArr(filters.statuses, s) })}
                />
                <span>{STATUS_LABELS[s]}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Grade */}
      {cfg.grade && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Grade</p>
          <div className="space-y-1.5">
            <label className={lbl}>
              <input type="checkbox" className={chk}
                checked={filters.grades.length === 0}
                onChange={() => onChange({ grades: [] })}
              />
              <span className="text-muted-foreground">All grades</span>
            </label>
            {[...GRADE_ORDER, 'Unclassified'].map(g => (
              <label key={g} className={lbl}>
                <input type="checkbox" className={chk}
                  checked={filters.grades.includes(g)}
                  onChange={() => onChange({ grades: toggleArr(filters.grades, g) })}
                />
                <span>{g}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Period — single */}
      {cfg.periodSingle && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Period</p>
          <div className="flex gap-1.5">
            <select className={`flex-1 ${sel}`} value={filters.periodMonth}
              onChange={e => onChange({ periodMonth: +e.target.value })}>
              {MONTH_NAMES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
            <select className={sel} value={filters.periodYear}
              onChange={e => onChange({ periodYear: +e.target.value })}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Period — range */}
      {cfg.periodRange && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Period Range</p>
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground w-7 shrink-0">From</span>
              <select className={`flex-1 ${sel}`} value={filters.periodMonth}
                onChange={e => onChange({ periodMonth: +e.target.value })}>
                {MONTH_NAMES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
              <select className={sel} value={filters.periodYear}
                onChange={e => onChange({ periodYear: +e.target.value })}>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground w-7 shrink-0">To</span>
              <select className={`flex-1 ${sel}`} value={filters.periodToMonth}
                onChange={e => onChange({ periodToMonth: +e.target.value })}>
                {MONTH_NAMES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
              <select className={sel} value={filters.periodToYear}
                onChange={e => onChange({ periodToYear: +e.target.value })}>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* NMW */}
      {cfg.nmw && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">NMW Reference</p>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Monthly equivalent (R)</label>
              <input type="number" value={filters.nmwMonthly} placeholder="e.g. 5620"
                onChange={e => onChange({ nmwMonthly: e.target.value })}
                className="w-full rounded border bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">At-risk threshold (%)</label>
              <input type="number" value={filters.nmwThreshold} placeholder="20"
                onChange={e => onChange({ nmwThreshold: e.target.value })}
                className="w-full rounded border bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </div>
      )}

      {/* Scenario */}
      {cfg.scenario && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Scenario</p>
          {scenarios.length === 0 ? (
            <p className="text-xs text-muted-foreground">No committed scenarios found.</p>
          ) : (
            <select className={`w-full ${sel}`} value={filters.scenarioId}
              onChange={e => onChange({ scenarioId: e.target.value })}>
              {scenarios.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name ?? 'Unnamed'}{s.effective_month && s.effective_year ? ` — ${pLabel(s.effective_year, s.effective_month)}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Roster columns */}
      {cfg.rosterCols && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Columns</p>
          <div className="space-y-1.5">
            {ROSTER_COLS.map(col => (
              <label key={col.id} className={lbl}>
                <input type="checkbox" className={chk}
                  checked={filters.rosterCols.includes(col.id)}
                  onChange={() => onChange({ rosterCols: toggleArr(filters.rosterCols, col.id) })}
                />
                <span>{col.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── PreviewTable ──────────────────────────────────────────────────────────────

const PREVIEW_LIMIT = 200;

function PreviewTable({ data }: { data: PreviewData | null }) {
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (data.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data for the selected filters.</p>;
  }

  const preview = data.rows.slice(0, PREVIEW_LIMIT);

  return (
    <div>
      {data.summaryLine && (
        <p className="text-sm text-muted-foreground mb-3">{data.summaryLine}</p>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-muted/40">
              {data.headers.map((h, i) => (
                <th key={i} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap border-b">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((row, ri) => (
              <tr key={ri} className={row.isTotals ? 'bg-muted/40' : 'hover:bg-muted/20'}>
                {row.cells.map((cell, ci) => {
                  const isNum = typeof cell === 'number';
                  const display = cell === null || cell === undefined
                    ? '—'
                    : isNum
                    ? cell.toLocaleString('en-ZA')
                    : String(cell);
                  return (
                    <td key={ci} className={[
                      'px-3 py-1.5 border-b border-border/40 tabular-nums',
                      isNum ? 'text-right' : 'text-left',
                      row.isTotals ? 'font-semibold' : '',
                      cell === 'AT RISK' ? 'text-red-600 font-semibold' : '',
                    ].join(' ')}>
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.totalRows > PREVIEW_LIMIT && (
        <p className="text-xs text-muted-foreground mt-2">
          Showing {PREVIEW_LIMIT} of {data.totalRows} rows. Export to Excel to see all data.
        </p>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const supabase = createClient();

  const now       = new Date();
  const thisYear  = now.getFullYear();
  const thisMonth = now.getMonth() + 1;

  const [hotels,        setHotels]        = useState<Hotel[]>([]);
  const [employees,     setEmployees]     = useState<Employee[]>([]);
  const [salaryRecords, setSalaryRecords] = useState<SalaryRecord[]>([]);
  const [scenarios,     setScenarios]     = useState<IncreaseScenario[]>([]);
  const [scenarioLines, setScenarioLines] = useState<ScenarioLine[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [exporting,     setExporting]     = useState(false);
  const [reportType,    setReportType]    = useState<ReportType>('headcount_summary');

  const [filters, setFilters] = useState<Filters>({
    hotelIds:     [],
    statuses:     ['active'],
    grades:       [],
    periodYear:   thisYear,
    periodMonth:  1,
    periodToYear: thisYear,
    periodToMonth: thisMonth,
    nmwMonthly:   '',
    nmwThreshold: '20',
    scenarioId:   '',
    rosterCols:   ROSTER_COLS.filter(c => c.default).map(c => c.id),
  });

  useEffect(() => {
    async function load() {
      const [
        { data: h }, { data: e }, { data: sr }, { data: sc }, { data: sl },
      ] = await Promise.all([
        supabase.from('hotels').select('*'),
        supabase.from('employees').select('*').order('surname'),
        supabase.from('salary_records').select('*'),
        supabase.from('increase_scenarios').select('*').eq('status', 'committed').order('created_at', { ascending: false }),
        supabase.from('scenario_lines').select('*'),
      ]);

      const sortedHotels = sortHotels(h ?? []);
      setHotels(sortedHotels);
      setEmployees(e ?? []);
      setSalaryRecords(sr ?? []);
      setScenarios(sc ?? []);
      setScenarioLines(sl ?? []);

      if (sc?.length) setFilters(prev => ({ ...prev, scenarioId: sc[0].id }));

      try {
        const nmwStore: Record<string, string> = JSON.parse(localStorage.getItem('ihg-salary-nmw') ?? '{}');
        const v = nmwStore[String(thisYear)] ?? nmwStore[String(thisYear - 1)] ?? '';
        if (v) setFilters(prev => ({ ...prev, nmwMonthly: v }));
      } catch { /* ignore */ }

      setLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const empMap      = useMemo(() => new Map(employees.map(e => [e.id, e])),          [employees]);
  const hotelMap    = useMemo(() => new Map(hotels.map(h => [h.id, h])),             [hotels]);
  const empHotelMap = useMemo(() => new Map(employees.map(e => [e.id, e.hotel_id])), [employees]);

  const previewData = useMemo((): PreviewData | null => {
    if (loading) return null;
    return computeReport(
      reportType, filters,
      employees, hotels, salaryRecords, scenarios, scenarioLines,
      empMap, hotelMap, empHotelMap,
    );
  }, [reportType, filters, employees, hotels, salaryRecords, scenarios, scenarioLines, loading, empMap, hotelMap, empHotelMap]);

  async function handleExport() {
    if (!previewData?.rows.length) return;
    setExporting(true);
    try {
      const def      = REPORT_CATALOG.find(r => r.id === reportType)!;
      const filename = `${def.label.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const sheet: ReportSheet = {
        name:        def.label,
        headers:     previewData.headers,
        rows:        previewData.rows.map(r => r.cells),
        isTotalsRow: previewData.rows.map(r => !!r.isTotals),
      };
      await exportReport(def.label, filename, [sheet]);
    } finally {
      setExporting(false);
    }
  }

  const def        = REPORT_CATALOG.find(r => r.id === reportType)!;
  const categories = ['headcount', 'payroll', 'salary', 'increases'] as ReportCategory[];

  return (
    <div className="flex min-h-screen bg-muted/30">

      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
      <aside className="w-72 shrink-0 border-r bg-white flex flex-col">

        {/* Report type picker */}
        <div className="p-4 border-b overflow-y-auto">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Report Type</p>
          <div className="space-y-3">
            {categories.map(cat => (
              <div key={cat}>
                <p className="text-xs font-medium text-muted-foreground/60 uppercase tracking-widest mb-1 px-1">
                  {CATEGORY_LABELS[cat]}
                </p>
                <div className="space-y-0.5">
                  {REPORT_CATALOG.filter(r => r.category === cat).map(r => (
                    <button
                      key={r.id}
                      onClick={() => setReportType(r.id)}
                      className={[
                        'w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors',
                        reportType === r.id
                          ? 'bg-primary text-primary-foreground font-medium'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      ].join(' ')}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Filters</p>
          <FilterPanel
            reportType={reportType}
            filters={filters}
            onChange={p => setFilters(prev => ({ ...prev, ...p }))}
            hotels={hotels}
            salaryRecords={salaryRecords}
            scenarios={scenarios}
          />
        </div>
      </aside>

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b bg-white">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold truncate">{def.label}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{def.desc}</p>
          </div>
          <button
            onClick={handleExport}
            disabled={!previewData?.rows.length || exporting}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            <Download className="h-4 w-4" />
            {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
        </div>

        {/* Preview */}
        <div className="flex-1 p-6 overflow-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading data…</p>
          ) : (
            <PreviewTable data={previewData} />
          )}
        </div>
      </div>
    </div>
  );
}
