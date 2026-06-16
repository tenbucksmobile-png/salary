'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Hotel, Employee, SalaryRecord } from '@/types/database';
import { sortHotels, MONTH_NAMES } from '@/lib/utils';
import { ChevronDown, ChevronRight, FileSpreadsheet, FileText } from 'lucide-react';
import { exportReport, exportPdf, ReportSheet, PdfRow } from '@/lib/reports-export';

// ── Types ─────────────────────────────────────────────────────────────────────

type FieldGroup = 'employee' | 'earnings' | 'deductions' | 'contributions' | 'provisions' | 'totals';

interface FieldDef {
  id: string;
  label: string;
  group: FieldGroup;
  isNumeric: boolean;
  isSummaryKey: boolean;
  defaultOn: boolean;
}

interface PreviewRow {
  cells: Array<string | number | null>;
  isTotals?: boolean;
}

interface PreviewData {
  headers: string[];
  rows: PreviewRow[];
  empCount: number;
  summaryLine: string;
}

// ── Field definitions ─────────────────────────────────────────────────────────

const FIELD_GROUPS: { id: FieldGroup; label: string }[] = [
  { id: 'employee',      label: 'Employee' },
  { id: 'earnings',      label: 'Earnings' },
  { id: 'deductions',    label: 'Deductions (EE)' },
  { id: 'contributions', label: 'Contributions (Co)' },
  { id: 'provisions',    label: 'Provisions' },
  { id: 'totals',        label: 'Totals' },
];

const ALL_FIELDS: FieldDef[] = [
  // Employee
  { id: 'employee_code',    label: 'Emp Code',       group: 'employee',       isNumeric: false, isSummaryKey: false, defaultOn: false },
  { id: 'surname',          label: 'Surname',        group: 'employee',       isNumeric: false, isSummaryKey: false, defaultOn: true  },
  { id: 'first_name',       label: 'First Name',     group: 'employee',       isNumeric: false, isSummaryKey: false, defaultOn: true  },
  { id: 'hotel',            label: 'Hotel',          group: 'employee',       isNumeric: false, isSummaryKey: true,  defaultOn: true  },
  { id: 'department_code',  label: 'Department',     group: 'employee',       isNumeric: false, isSummaryKey: true,  defaultOn: false },
  { id: 'job_title',        label: 'Job Title',      group: 'employee',       isNumeric: false, isSummaryKey: false, defaultOn: false },
  { id: 'grade_label',      label: 'Grade',          group: 'employee',       isNumeric: false, isSummaryKey: true,  defaultOn: true  },
  { id: 'status',           label: 'Status',         group: 'employee',       isNumeric: false, isSummaryKey: true,  defaultOn: false },
  { id: 'employment_date',  label: 'Start Date',     group: 'employee',       isNumeric: false, isSummaryKey: false, defaultOn: false },
  { id: 'years_service',    label: 'Yrs Service',    group: 'employee',       isNumeric: true,  isSummaryKey: false, defaultOn: false },
  // Earnings
  { id: 'basic_salary',     label: 'Basic Salary',   group: 'earnings',       isNumeric: true,  isSummaryKey: false, defaultOn: true  },
  { id: 'allowances',       label: 'Allowances',     group: 'earnings',       isNumeric: true,  isSummaryKey: false, defaultOn: false },
  { id: 'total_earnings',   label: 'Gross Salary',   group: 'earnings',       isNumeric: true,  isSummaryKey: false, defaultOn: false },
  { id: 'net_salary',       label: 'Net Pay',        group: 'earnings',       isNumeric: true,  isSummaryKey: false, defaultOn: false },
  // Deductions (EE)
  { id: 'tax_paye',           label: 'Tax (PAYE)',    group: 'deductions',    isNumeric: true,  isSummaryKey: false, defaultOn: false },
  { id: 'uif_employee',       label: 'UIF (EE)',      group: 'deductions',    isNumeric: true,  isSummaryKey: false, defaultOn: false },
  { id: 'provident_employee', label: 'PF (EE)',       group: 'deductions',    isNumeric: true,  isSummaryKey: false, defaultOn: false },
  { id: 'medical_employee',   label: 'Medical (EE)',  group: 'deductions',    isNumeric: true,  isSummaryKey: false, defaultOn: false },
  { id: 'ancilla_employee',   label: 'Ancilla (EE)', group: 'deductions',    isNumeric: true,  isSummaryKey: false, defaultOn: false },
  { id: 'total_deductions',   label: 'Total Deduct.', group: 'deductions',   isNumeric: true,  isSummaryKey: false, defaultOn: false },
  // Contributions (Co)
  { id: 'uif_company',          label: 'UIF (Co)',        group: 'contributions', isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'medical_company',      label: 'Medical (Co)',    group: 'contributions', isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'provident_company',    label: 'PF (Co)',         group: 'contributions', isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'sdl_company',          label: 'SDL',             group: 'contributions', isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'wca_company',          label: 'WCA',             group: 'contributions', isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'ancilla_company',      label: 'Ancilla (Co)',    group: 'contributions', isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'other_company_contrib',label: 'Other (Co)',      group: 'contributions', isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'total_company_contrib',label: 'Total Contrib.',  group: 'contributions', isNumeric: true, isSummaryKey: false, defaultOn: false },
  // Provisions
  { id: 'staff_meals',          label: 'Staff Meals',     group: 'provisions',    isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'leave_provision',      label: 'Leave Prov.',     group: 'provisions',    isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'leave_accrual',        label: 'Leave Accrual',   group: 'provisions',    isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'bonus_provision',      label: 'Bonus Prov.',     group: 'provisions',    isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'incentive',            label: 'Incentive',       group: 'provisions',    isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'severance',            label: 'Severance',       group: 'provisions',    isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'gratuity',             label: 'Gratuity',        group: 'provisions',    isNumeric: true, isSummaryKey: false, defaultOn: false },
  { id: 'total_payroll_burden', label: 'Total Burden',    group: 'provisions',    isNumeric: true, isSummaryKey: false, defaultOn: false },
  // Totals
  { id: 'ctc',                  label: 'CTC',             group: 'totals',        isNumeric: true, isSummaryKey: false, defaultOn: true  },
  { id: 'total_cost',           label: 'Total Cost',      group: 'totals',        isNumeric: true, isSummaryKey: false, defaultOn: false },
];

const DEFAULT_FIELD_IDS = ALL_FIELDS.filter(f => f.defaultOn).map(f => f.id);

// ── Helpers ───────────────────────────────────────────────────────────────────

function latestRecord(records: SalaryRecord[], empId: string): SalaryRecord | undefined {
  return records
    .filter(r => r.employee_id === empId)
    .sort((a, b) => b.period_year !== a.period_year ? b.period_year - a.period_year : b.period_month - a.period_month)[0];
}

function yos(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (365.25 * 24 * 60 * 60 * 1000) * 10) / 10;
}

function sumN(vals: number[]): number {
  return Math.round(vals.reduce((s, v) => s + (v || 0), 0));
}

function avgN(vals: number[]): number {
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
}

function pLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function allowancesTotal(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  return Object.values(raw as Record<string, unknown>)
    .reduce<number>((s, v) => s + (typeof v === 'number' ? v : 0), 0);
}

function getVal(
  id: string,
  emp: Employee,
  sr: SalaryRecord | undefined,
  hotel: Hotel | undefined,
): string | number | null {
  switch (id) {
    case 'employee_code':        return emp.employee_code ?? '';
    case 'surname':              return emp.surname;
    case 'first_name':           return emp.first_name;
    case 'hotel':                return hotel?.name ?? '';
    case 'department_code':      return emp.department_code ?? '';
    case 'job_title':            return emp.job_title ?? '';
    case 'grade_label':          return emp.grade_label ?? 'Unclassified';
    case 'status':               return ({ active: 'Active', terminated: 'Terminated', on_leave: 'On Leave' })[emp.status] ?? emp.status;
    case 'employment_date':      return emp.employment_date ?? '';
    case 'years_service':        return emp.employment_date ? +yos(emp.employment_date).toFixed(1) : null;
    case 'basic_salary':         return sr?.basic_salary ?? null;
    case 'allowances':           return sr ? allowancesTotal(sr.allowances) : null;
    case 'total_earnings':       return sr?.total_earnings ?? null;
    case 'net_salary':           return sr?.net_salary ?? null;
    case 'tax_paye':             return sr?.tax_paye ?? null;
    case 'uif_employee':         return sr?.uif_employee ?? null;
    case 'provident_employee':   return sr?.provident_employee ?? null;
    case 'medical_employee':     return sr?.medical_employee ?? null;
    case 'ancilla_employee':     return sr?.ancilla_employee ?? null;
    case 'total_deductions':     return sr?.total_deductions ?? null;
    case 'uif_company':          return sr?.uif_company ?? null;
    case 'medical_company':      return sr?.medical_company ?? null;
    case 'provident_company':    return sr?.provident_company ?? null;
    case 'sdl_company':          return sr?.sdl_company ?? null;
    case 'wca_company':          return sr?.wca_company ?? null;
    case 'ancilla_company':      return sr?.ancilla_company ?? null;
    case 'other_company_contrib':return sr?.other_company_contrib ?? null;
    case 'total_company_contrib':return sr?.total_company_contrib ?? null;
    case 'staff_meals':          return sr?.staff_meals ?? null;
    case 'leave_provision':      return sr?.leave_provision ?? null;
    case 'leave_accrual':        return sr?.leave_accrual ?? null;
    case 'bonus_provision':      return sr?.bonus_provision ?? null;
    case 'incentive':            return sr?.incentive ?? null;
    case 'severance':            return sr?.severance ?? null;
    case 'gratuity':             return sr?.gratuity ?? null;
    case 'total_payroll_burden': return sr?.total_payroll_burden ?? null;
    case 'ctc':                  return sr?.ctc ?? null;
    case 'total_cost':           return sr?.total_cost ?? null;
    default:                     return null;
  }
}

// ── Compute ───────────────────────────────────────────────────────────────────

function computeData(
  hotelIds: string[],
  fieldIds: string[],
  viewMode: 'individual' | 'summary',
  statuses: ('active' | 'terminated')[],
  useLatest: boolean,
  periodYear: number,
  periodMonth: number,
  employees: Employee[],
  salaryRecords: SalaryRecord[],
  hotelMap: Map<string, Hotel>,
  sortedHotelIds: string[],
): PreviewData {
  if (!fieldIds.length) {
    return { headers: [], rows: [], empCount: 0, summaryLine: 'Select fields to build your report.' };
  }

  const emps = employees.filter(e =>
    (hotelIds.length === 0 || hotelIds.includes(e.hotel_id)) &&
    (statuses.length  === 0 || statuses.includes(e.status))
  );

  type EmpRec = { emp: Employee; sr: SalaryRecord | undefined };
  const data: EmpRec[] = emps.map(emp => ({
    emp,
    sr: useLatest
      ? latestRecord(salaryRecords, emp.id)
      : salaryRecords.find(r =>
          r.employee_id === emp.id &&
          r.period_year === periodYear &&
          r.period_month === periodMonth),
  }));

  const fields      = ALL_FIELDS.filter(f => fieldIds.includes(f.id));
  const periodNote  = useLatest ? 'Latest available' : pLabel(periodYear, periodMonth);
  const hotelOrder  = new Map(sortedHotelIds.map((id, i) => [id, i]));

  if (viewMode === 'individual') {
    const sorted = [...data].sort((a, b) => {
      const ha = hotelOrder.get(a.emp.hotel_id) ?? 999;
      const hb = hotelOrder.get(b.emp.hotel_id) ?? 999;
      return ha !== hb ? ha - hb : a.emp.surname.localeCompare(b.emp.surname);
    });

    const headers = fields.map(f => f.label);
    const rows: PreviewRow[] = sorted.map(({ emp, sr }) => ({
      cells: fields.map(f => getVal(f.id, emp, sr, hotelMap.get(emp.hotel_id))),
    }));

    const totCells: Array<string | number | null> = fields.map((f, i) => {
      if (!f.isNumeric) return i === 0 ? `Total (${sorted.length})` : '';
      if (f.id === 'years_service') {
        const vals = rows.flatMap(r => (typeof r.cells[i] === 'number' ? [r.cells[i] as number] : []));
        return vals.length ? +avgN(vals).toFixed(1) : null;
      }
      return sumN(rows.map(r => (typeof r.cells[i] === 'number' ? (r.cells[i] as number) : 0)));
    });
    rows.push({ isTotals: true, cells: totCells });

    return { headers, rows, empCount: sorted.length, summaryLine: `${sorted.length} employees · ${periodNote}` };
  }

  // Summary mode
  const keyFields    = fields.filter(f => f.isSummaryKey);
  const numFields    = fields.filter(f => f.isNumeric && f.id !== 'years_service');
  const excludedCnt  = fields.filter(f => !f.isSummaryKey && !f.isNumeric).length;

  const groups = new Map<string, EmpRec[]>();
  for (const rec of data) {
    const hotel = hotelMap.get(rec.emp.hotel_id);
    const key   = keyFields.map(f => String(getVal(f.id, rec.emp, rec.sr, hotel) ?? '')).join('\x00');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(rec);
  }

  const sortedKeys = [...groups.keys()].sort((ka, kb) => {
    const ha = hotelOrder.get(groups.get(ka)![0].emp.hotel_id) ?? 999;
    const hb = hotelOrder.get(groups.get(kb)![0].emp.hotel_id) ?? 999;
    return ha !== hb ? ha - hb : ka.localeCompare(kb);
  });

  const headers = [...keyFields.map(f => f.label), 'Count', ...numFields.map(f => f.label)];
  const rows: PreviewRow[] = sortedKeys.map(key => {
    const list  = groups.get(key)!;
    const hotel = hotelMap.get(list[0].emp.hotel_id);
    const keyVals = keyFields.map(f => getVal(f.id, list[0].emp, list[0].sr, hotel));
    const numVals = numFields.map(f =>
      sumN(list.map(({ emp, sr }) => {
        const v = getVal(f.id, emp, sr, hotelMap.get(emp.hotel_id));
        return typeof v === 'number' ? v : 0;
      }))
    );
    return { cells: [...keyVals, list.length, ...numVals] };
  });

  if (rows.length > 1) {
    const numTots = numFields.map((_, ni) =>
      sumN(rows.map(r => { const v = r.cells[keyFields.length + 1 + ni]; return typeof v === 'number' ? v : 0; }))
    );
    rows.push({ isTotals: true, cells: [...keyFields.map((_, i) => i === 0 ? 'TOTAL' : ''), data.length, ...numTots] });
  }

  const excNote = excludedCnt ? ` · ${excludedCnt} individual field${excludedCnt > 1 ? 's' : ''} excluded` : '';
  return {
    headers, rows, empCount: data.length,
    summaryLine: `${groups.size} group${groups.size !== 1 ? 's' : ''} · ${data.length} employees · ${periodNote}${excNote}`,
  };
}

// ── Accordion section ─────────────────────────────────────────────────────────

function Section({ title, open, onToggle, children }: {
  title: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border last:border-0">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-foreground hover:bg-muted/30 transition-colors"
      >
        <span>{title}</span>
        {open
          ? <ChevronDown  className="h-4 w-4 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const NOW           = new Date();
const CURRENT_YEAR  = NOW.getFullYear();
const CURRENT_MONTH = NOW.getMonth() + 1;
const YEAR_OPTIONS  = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - 5 + i);

export default function ReportsPage() {
  const [hotels,        setHotels]        = useState<Hotel[]>([]);
  const [employees,     setEmployees]     = useState<Employee[]>([]);
  const [salaryRecords, setSalaryRecords] = useState<SalaryRecord[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [exporting,     setExporting]     = useState<'excel' | 'pdf' | null>(null);

  const [selectedHotels, setSelectedHotels] = useState<string[]>([]);
  const [selectedFields, setSelectedFields] = useState<string[]>(DEFAULT_FIELD_IDS);
  const [viewMode,       setViewMode]       = useState<'individual' | 'summary'>('individual');
  const [statuses,       setStatuses]       = useState<('active' | 'terminated')[]>(['active']);
  const [useLatest,      setUseLatest]      = useState(true);
  const [periodYear,     setPeriodYear]     = useState(CURRENT_YEAR);
  const [periodMonth,    setPeriodMonth]    = useState(CURRENT_MONTH);

  const [openSections, setOpenSections] = useState(() => new Set(['hotels', 'fields', 'view', 'status', 'date']));
  const [openGroups,   setOpenGroups]   = useState(() => new Set<FieldGroup>(['employee', 'earnings', 'totals']));

  function toggleSection(id: string) {
    setOpenSections(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleGroup(id: FieldGroup) {
    setOpenGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from('hotels').select('*'),
      sb.from('employees').select('*'),
      sb.from('salary_records').select('*'),
    ]).then(([h, e, s]) => {
      const sorted = sortHotels(h.data ?? []);
      setHotels(sorted);
      setSelectedHotels(sorted.map(x => x.id));
      setEmployees(e.data ?? []);
      setSalaryRecords(s.data ?? []);
      setLoading(false);
    });
  }, []);

  const hotelMap       = useMemo(() => new Map(hotels.map(h => [h.id, h])), [hotels]);
  const sortedHotelIds = useMemo(() => hotels.map(h => h.id), [hotels]);

  const preview = useMemo(() => {
    if (loading) return null;
    return computeData(
      selectedHotels, selectedFields, viewMode, statuses,
      useLatest, periodYear, periodMonth,
      employees, salaryRecords, hotelMap, sortedHotelIds,
    );
  }, [loading, selectedHotels, selectedFields, viewMode, statuses, useLatest, periodYear, periodMonth, employees, salaryRecords, hotelMap, sortedHotelIds]);

  function toggleHotel(id: string) {
    setSelectedHotels(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  }
  function allHotels(on: boolean) { setSelectedHotels(on ? hotels.map(h => h.id) : []); }

  function toggleField(id: string) {
    setSelectedFields(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  }
  function toggleGroupFields(group: FieldGroup, on: boolean) {
    const ids = ALL_FIELDS.filter(f => f.group === group).map(f => f.id);
    if (on) setSelectedFields(p => [...new Set([...p, ...ids])]);
    else    setSelectedFields(p => p.filter(id => !ids.includes(id)));
  }

  function toggleStatus(s: 'active' | 'terminated') {
    setStatuses(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  }

  async function handleExport(type: 'excel' | 'pdf') {
    if (!preview?.headers.length) return;
    setExporting(type);
    try {
      const dataRows  = preview.rows.filter(r => !r.isTotals);
      const totalsRow = preview.rows.find(r => r.isTotals);
      const allRows   = [...dataRows, ...(totalsRow ? [totalsRow] : [])];
      const ts        = new Date().toISOString().slice(0, 10).replace(/-/g, '');

      if (type === 'excel') {
        const sheet: ReportSheet = {
          name: 'Report',
          headers: preview.headers,
          rows: allRows.map(r => r.cells),
          isTotalsRow: allRows.map(r => r.isTotals ?? false),
        };
        await exportReport('IHG Salary Report', `IHG_Report_${ts}.xlsx`, [sheet]);
      } else {
        exportPdf('IHG Salary Report', preview.summaryLine, preview.headers, allRows as PdfRow[]);
      }
    } finally {
      setExporting(null);
    }
  }

  const isSummary = viewMode === 'summary';

  return (
    <div className="flex overflow-hidden" style={{ height: 'calc(100vh - 56px)' }}>

      {/* ── Builder panel ── */}
      <aside className="w-80 shrink-0 border-r bg-white flex flex-col overflow-hidden">
        <div className="px-4 py-4 border-b shrink-0">
          <h1 className="text-sm font-bold text-foreground">Report Builder</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Tick your requirements to generate a report</p>
        </div>

        <div className="flex-1 overflow-y-auto">

          {/* 1. Hotels */}
          <Section title="Hotels" open={openSections.has('hotels')} onToggle={() => toggleSection('hotels')}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">{selectedHotels.length} of {hotels.length} selected</span>
              <div className="flex gap-3 text-xs">
                <button onClick={() => allHotels(true)}  className="text-primary hover:underline">All</button>
                <button onClick={() => allHotels(false)} className="text-primary hover:underline">None</button>
              </div>
            </div>
            <div className="space-y-1.5">
              {hotels.map(h => (
                <label key={h.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedHotels.includes(h.id)}
                    onChange={() => toggleHotel(h.id)}
                    className="rounded border-border shrink-0"
                  />
                  <span className="text-xs font-semibold text-foreground">{h.short_code}</span>
                  <span className="text-xs text-muted-foreground truncate">{h.name}</span>
                </label>
              ))}
            </div>
          </Section>

          {/* 2. Fields / Detail */}
          <Section
            title={
              <span>
                Fields / Detail{' '}
                <span className="text-xs font-normal text-muted-foreground">({selectedFields.length} selected)</span>
              </span>
            }
            open={openSections.has('fields')}
            onToggle={() => toggleSection('fields')}
          >
            {isSummary && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-3">
                In Summary view, individual fields (name, code, etc.) are excluded from output.
                Fields tagged <em>group by</em> define aggregation dimensions.
              </p>
            )}
            <div className="space-y-1.5">
              {FIELD_GROUPS.map(g => {
                const gFields  = ALL_FIELDS.filter(f => f.group === g.id);
                const selCount = gFields.filter(f => selectedFields.includes(f.id)).length;
                const allOn    = selCount === gFields.length;
                const isOpen   = openGroups.has(g.id);
                return (
                  <div key={g.id} className="border border-border rounded overflow-hidden">
                    <div className="flex items-stretch">
                      <button
                        onClick={() => toggleGroup(g.id)}
                        className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted/30 transition-colors"
                      >
                        {isOpen
                          ? <ChevronDown  className="h-3 w-3 shrink-0 text-muted-foreground" />
                          : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                        {g.label}
                        <span className="ml-auto text-[11px] text-muted-foreground font-normal">{selCount}/{gFields.length}</span>
                      </button>
                      <button
                        onClick={() => toggleGroupFields(g.id, !allOn)}
                        className={`px-2.5 text-xs border-l border-border hover:bg-muted/30 transition-colors ${allOn ? 'text-primary font-semibold' : 'text-muted-foreground'}`}
                        title={allOn ? 'Deselect all in group' : 'Select all in group'}
                      >
                        {allOn ? '✓ All' : 'All'}
                      </button>
                    </div>
                    {isOpen && (
                      <div className="border-t border-border px-3 py-2 space-y-1 bg-muted/10">
                        {gFields.map(f => {
                          const dimmed = isSummary && !f.isSummaryKey && !f.isNumeric;
                          return (
                            <label
                              key={f.id}
                              className={`flex items-center gap-2 cursor-pointer ${dimmed ? 'opacity-35 pointer-events-none' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={selectedFields.includes(f.id)}
                                onChange={() => toggleField(f.id)}
                                disabled={dimmed}
                                className="rounded border-border shrink-0"
                              />
                              <span className="text-xs text-foreground">{f.label}</span>
                              {f.isSummaryKey && (
                                <span className="ml-auto text-[10px] text-muted-foreground italic">group by</span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          {/* 3. Individual or Summary */}
          <Section title="Individual or Summary" open={openSections.has('view')} onToggle={() => toggleSection('view')}>
            <div className="space-y-3">
              {([
                ['individual', 'Individual', 'One row per employee with all selected fields'],
                ['summary',    'Summary',    'Totals aggregated by grouping fields (Hotel, Grade, etc.)'],
              ] as const).map(([val, label, desc]) => (
                <label key={val} className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="radio"
                    name="viewMode"
                    value={val}
                    checked={viewMode === val}
                    onChange={() => setViewMode(val)}
                    className="mt-0.5 shrink-0"
                  />
                  <div>
                    <p className="text-sm font-medium text-foreground">{label}</p>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </Section>

          {/* 4. Status */}
          <Section title="Status Filter" open={openSections.has('status')} onToggle={() => toggleSection('status')}>
            <div className="space-y-1.5">
              {([
                ['active',     'Active'],
                ['terminated', 'Terminated'],
              ] as const).map(([val, label]) => (
                <label key={val} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statuses.includes(val)}
                    onChange={() => toggleStatus(val)}
                    className="rounded border-border"
                  />
                  <span className="text-sm text-foreground">{label}</span>
                </label>
              ))}
            </div>
          </Section>

          {/* 5. Date */}
          <Section title="Date" open={openSections.has('date')} onToggle={() => toggleSection('date')}>
            <div className="space-y-3">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="dateSel"
                  checked={useLatest}
                  onChange={() => setUseLatest(true)}
                  className="mt-0.5 shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-foreground">Latest available</p>
                  <p className="text-xs text-muted-foreground">Most recent record per employee</p>
                </div>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="dateSel"
                  checked={!useLatest}
                  onChange={() => setUseLatest(false)}
                  className="mt-0.5 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Specific period</p>
                  {!useLatest && (
                    <div className="flex gap-2 mt-1.5">
                      <select
                        value={periodMonth}
                        onChange={e => setPeriodMonth(+e.target.value)}
                        className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
                      >
                        {MONTH_NAMES.map((m, i) => (
                          <option key={m} value={i + 1}>{m}</option>
                        ))}
                      </select>
                      <select
                        value={periodYear}
                        onChange={e => setPeriodYear(+e.target.value)}
                        className="w-20 rounded border border-border bg-background px-2 py-1.5 text-xs"
                      >
                        {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              </label>
            </div>
          </Section>

        </div>

        {/* Export buttons */}
        <div className="p-4 border-t shrink-0 space-y-2 bg-white">
          <button
            onClick={() => handleExport('excel')}
            disabled={!preview?.headers.length || !!exporting}
            className="w-full flex items-center justify-center gap-2 rounded-md bg-[#15623A] text-white px-4 py-2.5 text-sm font-semibold hover:bg-[#124d2e] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FileSpreadsheet className="h-4 w-4 shrink-0" />
            {exporting === 'excel' ? 'Exporting…' : 'Export Excel'}
          </button>
          <button
            onClick={() => handleExport('pdf')}
            disabled={!preview?.headers.length || !!exporting}
            className="w-full flex items-center justify-center gap-2 rounded-md border border-border bg-white text-foreground px-4 py-2.5 text-sm font-semibold hover:bg-muted/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FileText className="h-4 w-4 shrink-0" />
            {exporting === 'pdf' ? 'Opening…' : 'Export PDF'}
          </button>
        </div>
      </aside>

      {/* ── Preview panel ── */}
      <main className="flex-1 flex flex-col overflow-hidden bg-muted/10">
        <div className="px-6 py-3.5 border-b bg-white shrink-0">
          <span className="text-sm font-semibold text-foreground">Preview</span>
          {preview && (
            <span className="ml-3 text-xs text-muted-foreground">{preview.summaryLine}</span>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Loading data…
            </div>
          ) : !preview || !preview.headers.length ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <FileSpreadsheet className="h-12 w-12 opacity-15" />
              <p className="text-sm">Select hotels and fields to see a preview</p>
            </div>
          ) : preview.empCount === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              No employees match the current filters
            </div>
          ) : (
            <table className="w-full text-xs border-collapse min-w-max">
              <thead className="sticky top-0 z-10">
                <tr>
                  {preview.headers.map((h, i) => (
                    <th
                      key={i}
                      className="bg-[#1B3A5C] text-white font-semibold px-3 py-2.5 text-left whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, ri) => (
                  <tr
                    key={ri}
                    className={
                      row.isTotals
                        ? 'bg-muted/60 font-semibold'
                        : ri % 2 === 0 ? 'bg-white hover:bg-muted/20' : 'bg-muted/20 hover:bg-muted/30'
                    }
                  >
                    {row.cells.map((c, ci) => (
                      <td
                        key={ci}
                        className={`px-3 py-2 border-b border-border/40 whitespace-nowrap ${typeof c === 'number' ? 'text-right tabular-nums' : ''}`}
                      >
                        {c === null || c === '' ? (
                          <span className="text-muted-foreground/30">—</span>
                        ) : typeof c === 'number' ? (
                          c.toLocaleString('en-ZA')
                        ) : (
                          c
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
