'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MONTH_NAMES, sortHotels, fmtCurrency } from '@/lib/utils';
import type { Hotel, Employee, SalaryRecord } from '@/types/database';
import type {
  ReconciliationPeriod,
  ReconUpload,
  ReconUploadType,
  ReconQuery,
} from '@/types/database';
import {
  parseAfritecXls,
  parseFurnmart,
  parseBodulo,
  parsePayrollXlsx,
  parseFtcPayrollXls,
  nameKey,
  type PayrollLine,
} from '@/lib/recon-parsers';
import type { ParsedStatement, ParsedPayroll, ReconLine } from '@/lib/recon-parsers';

// ── Config ────────────────────────────────────────────────────────────────────

interface UploadConfig {
  type: ReconUploadType;
  label: string;
  desc: string;
  accept: string;
  required: boolean;
  // which payroll column to cross-check against
  payrollKey: keyof import('@/lib/recon-parsers').PayrollLine | null;
}

const UPLOAD_CONFIGS: UploadConfig[] = [
  {
    type: 'payroll', label: 'Payroll Spreadsheet', required: true,
    accept: '.xlsx', desc: 'Monthly payroll export from VIP/HR system',
    payrollKey: null,
  },
  {
    type: 'ftc_payroll', label: 'Fixed Term Contract Payroll', required: false,
    accept: '.xls,.xlsx', desc: 'FTC / casual pay register (.xls or .xlsx)',
    payrollKey: null,
  },
  {
    type: 'twelve_months', label: '12 Months Payroll Report', required: false,
    accept: '.pdf', desc: '12-month monthly analysis report (PDF)',
    payrollKey: null,
  },
  {
    type: 'afritec', label: 'Afritec Loan Statement', required: false,
    accept: '.xls,.xlsx', desc: 'Monthly loan instalment schedule (.xls)',
    payrollKey: 'staffLoans',
  },
  {
    type: 'topline', label: 'Topline Deductions', required: false,
    accept: '.xls,.xlsx', desc: 'Monthly Topline deduction statement (.xls)',
    payrollKey: 'staffLoans',
  },
  {
    type: 'furnmart', label: 'Furnmart Deductions', required: false,
    accept: '.xlsx', desc: 'Staff purchase deduction statement (.xlsx)',
    payrollKey: 'furnmart',
  },
  {
    type: 'cbstores', label: 'CB Stores Deductions', required: false,
    accept: '.xls,.xlsx', desc: 'CB Stores monthly deductions (omit if none)',
    payrollKey: 'cbStores',
  },
  {
    type: 'bodulo', label: 'Bodulo Funeral Scheme', required: false,
    accept: '.xlsx', desc: 'Employee funeral scheme premium list (.xlsx)',
    payrollKey: 'bodulo',
  },
];


// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  submitted: 'Submitted',
  approved: 'Approved',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-yellow-100 text-yellow-800',
  submitted: 'bg-blue-100 text-blue-800',
  approved: 'bg-green-100 text-green-800',
};

function fmt(n: number | null | undefined, country: string) {
  if (n == null || n === 0) return '—';
  return fmtCurrency(n, country);
}

function diffClass(diff: number) {
  if (Math.abs(diff) < 0.01) return 'text-green-700';
  return diff > 0 ? 'text-red-600 font-semibold' : 'text-orange-600 font-semibold';
}

function fmtDiff(diff: number, country: string) {
  if (Math.abs(diff) < 0.01) return '✓';
  const sign = diff > 0 ? '+' : '';
  return sign + fmtCurrency(diff, country);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReconciliationPage() {
  const supabase = createClient();

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [hotelId, setHotelId] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [period, setPeriod] = useState<ReconciliationPeriod | null>(null);
  const [uploads, setUploads] = useState<ReconUpload[]>([]);
  const [queries, setQueries] = useState<ReconQuery[]>([]);
  const [tab, setTab] = useState<'upload' | 'deductions' | 'crossref' | 'changes' | 'queries'>('upload');
  const [dedFilter, setDedFilter] = useState<'all' | 'furnmart' | 'afritec' | 'topline' | 'cbstores' | 'bodulo'>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [newQuery, setNewQuery] = useState('');
  const [username, setUsername] = useState('admin');
  const [prevRecords, setPrevRecords] = useState<Array<{
    basic_salary: number;
    employees: { employee_code: string | null; surname: string; first_name: string };
  }>>([]);
  // prevPayrollLines: loaded from previous period's recon upload (preferred source);
  // null = no recon upload found for prev period → fall back to prevRecords from salary_records
  const [prevPayrollLines, setPrevPayrollLines] = useState<PayrollLine[] | null>(null);
  const [cfeEmployees, setCfeEmployees] = useState<Employee[]>([]);

  // DB cross-reference data — independent per hotel, not tied to the main hotel selector
  type HotelXRefData = {
    employees: Employee[];
    salaryRecords: Array<Pick<SalaryRecord, 'employee_id' | 'basic_salary' | 'period_year' | 'period_month'>>;
    payrollLines: PayrollLine[]; // deduplicated by nameKey
    loaded: boolean;
  };
  const emptyXRef: HotelXRefData = { employees: [], salaryRecords: [], payrollLines: [], loaded: false };
  const [cslXRef, setCslXRef] = useState<HotelXRefData>(emptyXRef);
  const [nlXRef,  setNlXRef]  = useState<HotelXRefData>(emptyXRef);
  const [crossRefSubTab, setCrossRefSubTab] = useState<'CSL' | 'NL'>('CSL');
  const [crossRefFilter, setCrossRefFilter] = useState<'all' | 'mismatch' | 'payonly' | 'dbonly'>('all');

  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => { if (d?.username) setUsername(d.username); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      supabase.from('hotels').select('*'),
      fetch('/api/auth/me').then(r => r.ok ? r.json() : null),
    ]).then(([{ data }, me]) => {
      if (data) {
        const RECON_CODES = ['CFE', 'CSL', 'NL'];
        let filtered = sortHotels(data as Hotel[]).filter(h => RECON_CODES.includes(h.short_code));
        const meData = me as { role: string; hotelIds: string[] | null } | null;
        if (meData?.role === 'sub' && meData.hotelIds?.length) {
          filtered = filtered.filter(h => meData.hotelIds!.includes(h.id));
        }
        setHotels(filtered);
        const csl = filtered.find(h => h.short_code === 'CSL') || filtered[0];
        if (csl) setHotelId(csl.id);

        // Load CFE employees for management cross-reference (all users, unfiltered)
        const cfeHotel = (data as Hotel[]).find(h => h.short_code === 'CFE');
        if (cfeHotel) {
          supabase.from('employees').select('*').eq('hotel_id', cfeHotel.id)
            .then(({ data: emps }) => setCfeEmployees((emps ?? []) as Employee[]));
        }
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!hotelId) return;
    setPrevRecords([]);
    setPrevPayrollLines(null);
    loadPeriod();
    loadPrevRecords();
  }, [hotelId, year, month]);

  // Load Employees cross-reference for both CSL and NL independently.
  // Triggered when the Employees tab is opened, or year/month/hotels changes.
  // Payroll lines come from each hotel's own recon upload (not the main hotel selector).
  useEffect(() => {
    if (tab !== 'crossref' || !hotels.length) return;

    async function loadXRef(shortCode: 'CSL' | 'NL'): Promise<HotelXRefData> {
      const hotel = hotels.find(h => h.short_code === shortCode);
      if (!hotel) return { ...emptyXRef, loaded: true };

      const { data: emps } = await supabase
        .from('employees').select('*').eq('hotel_id', hotel.id).eq('status', 'active');
      const employees = (emps ?? []) as Employee[];

      let salaryRecords: HotelXRefData['salaryRecords'] = [];
      if (employees.length > 0) {
        const { data: recs } = await supabase
          .from('salary_records')
          .select('employee_id, basic_salary, period_year, period_month')
          .in('employee_id', employees.map(e => e.id))
          .order('period_year', { ascending: false })
          .order('period_month', { ascending: false });
        salaryRecords = (recs ?? []) as HotelXRefData['salaryRecords'];
      }

      // Load payroll lines from this hotel's recon upload for year/month
      const { data: periodRow } = await supabase
        .from('reconciliation_periods')
        .select('id')
        .eq('hotel_id', hotel.id)
        .eq('period_year', year)
        .eq('period_month', month)
        .maybeSingle();

      let payrollLines: PayrollLine[] = [];
      if (periodRow) {
        const [{ data: payUp }, { data: ftcUp }] = await Promise.all([
          supabase.from('recon_uploads').select('parsed_data').eq('period_id', periodRow.id).eq('upload_type', 'payroll').maybeSingle(),
          supabase.from('recon_uploads').select('parsed_data').eq('period_id', periodRow.id).eq('upload_type', 'ftc_payroll').maybeSingle(),
        ]);
        const merged: PayrollLine[] = [
          ...((payUp?.parsed_data as any)?.lines ?? []),
          ...((ftcUp?.parsed_data as any)?.lines ?? []),
        ];
        // Deduplicate by nameKey — employee may appear in both permanent and FTC uploads
        const seen = new Set<string>();
        payrollLines = merged.filter(l => {
          const k = nameKey(l.name);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }

      return { employees, salaryRecords, payrollLines, loaded: true };
    }

    setCslXRef(prev => ({ ...prev, loaded: false }));
    setNlXRef(prev => ({ ...prev, loaded: false }));
    Promise.all([loadXRef('CSL'), loadXRef('NL')]).then(([csl, nl]) => {
      setCslXRef(csl);
      setNlXRef(nl);
    });
  }, [tab, year, month, hotels]);

  async function loadPeriod() {
    const { data } = await supabase
      .from('reconciliation_periods')
      .select('*')
      .eq('hotel_id', hotelId)
      .eq('period_year', year)
      .eq('period_month', month)
      .maybeSingle();

    setPeriod(data as ReconciliationPeriod | null);

    if (data) {
      const { data: ups } = await supabase
        .from('recon_uploads')
        .select('*')
        .eq('period_id', data.id)
        .order('uploaded_at');
      setUploads((ups || []) as ReconUpload[]);

      const { data: qs } = await supabase
        .from('recon_queries')
        .select('*')
        .eq('period_id', data.id)
        .order('created_at');
      setQueries((qs || []) as ReconQuery[]);
    } else {
      setUploads([]);
      setQueries([]);
    }
  }

  async function loadPrevRecords() {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    // Prefer the previous period's uploaded payroll — consistent empCode matching,
    // works for CSL/NL where salary_records have no employee_code
    const { data: prevPeriod } = await supabase
      .from('reconciliation_periods')
      .select('id')
      .eq('hotel_id', hotelId)
      .eq('period_year', prevYear)
      .eq('period_month', prevMonth)
      .maybeSingle();

    if (prevPeriod) {
      const [{ data: payUp }, { data: ftcUp }] = await Promise.all([
        supabase.from('recon_uploads').select('parsed_data').eq('period_id', prevPeriod.id).eq('upload_type', 'payroll').maybeSingle(),
        supabase.from('recon_uploads').select('parsed_data').eq('period_id', prevPeriod.id).eq('upload_type', 'ftc_payroll').maybeSingle(),
      ]);
      const lines: PayrollLine[] = [
        ...((payUp?.parsed_data as any)?.lines ?? []),
        ...((ftcUp?.parsed_data as any)?.lines ?? []),
      ];
      if (lines.length > 0) {
        setPrevPayrollLines(lines);
        return;
      }
    }

    // Fall back to salary_records in DB
    setPrevPayrollLines(null);
    const { data } = await supabase
      .from('salary_records')
      .select('basic_salary, employees!inner(employee_code, surname, first_name, hotel_id)')
      .eq('employees.hotel_id', hotelId)
      .eq('period_year', prevYear)
      .eq('period_month', prevMonth);
    setPrevRecords((data || []) as any[]);
  }

  // ── Period management ─────────────────────────────────────────────────────

  async function ensurePeriod(): Promise<string> {
    if (period) return period.id;
    const { data, error } = await supabase
      .from('reconciliation_periods')
      .insert({ hotel_id: hotelId, period_year: year, period_month: month, status: 'open' })
      .select()
      .single();
    if (error) throw error;
    setPeriod(data as ReconciliationPeriod);
    return data.id;
  }

  // ── File upload ───────────────────────────────────────────────────────────

  function viewPdf(upload: ReconUpload) {
    const b64 = upload.parsed_data?.base64 as string | undefined;
    if (!b64) return;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    window.open(url, '_blank');
  }

  async function handleUpload(type: ReconUploadType, file: File) {
    setUploading(type);
    try {
      const buf = await file.arrayBuffer();

      // PDF — store as base64, no parsing
      if (type === 'twelve_months') {
        const bytes = new Uint8Array(buf);
        let binary = '';
        bytes.forEach(b => { binary += String.fromCharCode(b); });
        const base64 = btoa(binary);
        const pid = await ensurePeriod();
        const { error } = await supabase.from('recon_uploads').upsert(
          { period_id: pid, upload_type: type, file_name: file.name,
            parsed_data: { base64 }, row_count: null, total_amount: null, uploaded_by: username },
          { onConflict: 'period_id,upload_type' },
        );
        if (error) throw error;
        const { data: ups } = await supabase.from('recon_uploads').select('*').eq('period_id', pid).order('uploaded_at');
        setUploads((ups || []) as ReconUpload[]);
        return;
      }

      let parsed: ParsedStatement | ParsedPayroll;

      const hotelCode = hotels.find(h => h.id === hotelId)?.short_code ?? '';
      if (type === 'payroll') parsed = await parsePayrollXlsx(buf, file.name);
      else if (type === 'ftc_payroll') parsed = await parseFtcPayrollXls(buf, file.name, month, year);
      else if (type === 'furnmart') parsed = await parseFurnmart(buf, file.name);
      else if (type === 'bodulo')   parsed = await parseBodulo(buf, file.name);
      else                          parsed = await parseAfritecXls(buf, file.name, type, hotelCode);

      const pid = await ensurePeriod();
      const isStmt = type !== 'payroll' && type !== 'ftc_payroll';
      const stmt = isStmt ? (parsed as ParsedStatement) : null;

      const { error } = await supabase
        .from('recon_uploads')
        .upsert(
          {
            period_id: pid,
            upload_type: type,
            file_name: file.name,
            parsed_data: parsed,
            row_count: isStmt ? stmt!.lines.length : (parsed as ParsedPayroll).lines.length,
            total_amount: isStmt ? stmt!.total : null,
            uploaded_by: username,
          },
          { onConflict: 'period_id,upload_type' },
        );

      if (error) throw error;
      // Reload uploads
      const { data: ups } = await supabase
        .from('recon_uploads')
        .select('*')
        .eq('period_id', pid)
        .order('uploaded_at');
      setUploads((ups || []) as ReconUpload[]);
    } catch (e: any) {
      alert('Upload failed: ' + e.message);
    } finally {
      setUploading(null);
      // Clear the file input
      if (fileRefs.current[type]) fileRefs.current[type]!.value = '';
    }
  }

  async function deleteUpload(id: string) {
    await supabase.from('recon_uploads').delete().eq('id', id);
    setUploads(u => u.filter(x => x.id !== id));
  }

  // ── Status actions ────────────────────────────────────────────────────────

  async function updateStatus(status: string) {
    if (!period) return;
    setSaving(true);
    const patch: Record<string, any> = { status };
    if (status === 'submitted') patch.submitted_at = new Date().toISOString();
    if (status === 'approved') { patch.approved_at = new Date().toISOString(); patch.approved_by = username; }
    const { data } = await supabase
      .from('reconciliation_periods')
      .update(patch)
      .eq('id', period.id)
      .select()
      .single();
    if (data) setPeriod(data as ReconciliationPeriod);
    setSaving(false);
  }

  async function saveNotes(notes: string) {
    if (!period) return;
    await supabase.from('reconciliation_periods').update({ notes }).eq('id', period.id);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async function addQuery() {
    if (!newQuery.trim()) return;
    const pid = await ensurePeriod();
    const { data } = await supabase
      .from('recon_queries')
      .insert({ period_id: pid, message: newQuery.trim(), author_name: username })
      .select()
      .single();
    if (data) { setQueries(q => [...q, data as ReconQuery]); setNewQuery(''); }
  }

  async function resolveQuery(id: string, msg: string) {
    const { data } = await supabase
      .from('recon_queries')
      .update({ resolved_at: new Date().toISOString(), resolver_name: username, resolved_message: msg })
      .eq('id', id)
      .select()
      .single();
    if (data) setQueries(q => q.map(x => x.id === id ? data as ReconQuery : x));
  }

  // ── Cross-check computation ───────────────────────────────────────────────

  const hotel = hotels.find(h => h.id === hotelId);
  const country = hotel?.country ?? '';

  const payrollUpload = uploads.find(u => u.upload_type === 'payroll');
  const payroll = payrollUpload?.parsed_data as ParsedPayroll | undefined;
  const ftcPayrollUpload = uploads.find(u => u.upload_type === 'ftc_payroll');
  const ftcPayroll = ftcPayrollUpload?.parsed_data as ParsedPayroll | undefined;

  const hasAnyPayroll = !!payroll || !!ftcPayroll;

  // Merged lines and totals from permanent + FTC payrolls
  const allPayrollLines = [...(payroll?.lines ?? []), ...(ftcPayroll?.lines ?? [])];
  const ftcCodes = new Set((ftcPayroll?.lines ?? []).map(l => l.empCode));
  const mergedTotals = {
    furnmart:     (payroll?.totals.furnmart     ?? 0) + (ftcPayroll?.totals.furnmart     ?? 0),
    cbStores:     (payroll?.totals.cbStores     ?? 0) + (ftcPayroll?.totals.cbStores     ?? 0),
    bodulo:       (payroll?.totals.bodulo       ?? 0) + (ftcPayroll?.totals.bodulo       ?? 0),
    staffLoans:   (payroll?.totals.staffLoans   ?? 0) + (ftcPayroll?.totals.staffLoans   ?? 0),
    afritecLoans: (payroll?.totals.afritecLoans ?? 0) + (ftcPayroll?.totals.afritecLoans ?? 0),
    toplineLoans: (payroll?.totals.toplineLoans ?? 0) + (ftcPayroll?.totals.toplineLoans ?? 0),
  };

  function getStmt(type: ReconUploadType): ParsedStatement | undefined {
    return uploads.find(u => u.upload_type === type)?.parsed_data as ParsedStatement | undefined;
  }

  const furnmartStmt = getStmt('furnmart');
  const afritecStmt  = getStmt('afritec');
  const toplineStmt  = getStmt('topline');
  const cbStmt       = getStmt('cbstores');
  const boduloStmt   = getStmt('bodulo');

  // Determine if payroll has separate columns per lender (vs one combined staffLoans)
  const payrollHasSeparateLoanCols = mergedTotals.afritecLoans > 0 || mergedTotals.toplineLoans > 0;
  const loanStmtTotal = (afritecStmt?.total ?? 0) + (toplineStmt?.total ?? 0);
  const bothLenders = !!afritecStmt && !!toplineStmt;

  // Summary rows for the deductions tab
  // pay/diff are null when payroll has no comparable column (statement shown for reference only)
  type SummaryRow = { label: string; stmt: number; pay: number | null; diff: number | null; isCombined?: boolean; isMgmt?: boolean };
  const summaryRows: SummaryRow[] = [];
  if (hasAnyPayroll) {
    if (furnmartStmt) summaryRows.push({
      label: 'Furnmart',
      stmt: furnmartStmt.total,
      pay: mergedTotals.furnmart,
      diff: furnmartStmt.total - mergedTotals.furnmart,
    });

    // Afritec Loans
    if (afritecStmt) {
      const afritecPay = payrollHasSeparateLoanCols
        ? mergedTotals.afritecLoans
        : (!toplineStmt ? mergedTotals.staffLoans : null);
      summaryRows.push({
        label: 'Afritec Loans',
        stmt: afritecStmt.total,
        pay: afritecPay,
        diff: afritecPay != null ? afritecStmt.total - afritecPay : null,
      });
    }

    if (cbStmt) summaryRows.push({
      label: 'CB Stores',
      stmt: cbStmt.total,
      pay: mergedTotals.cbStores,
      diff: cbStmt.total - mergedTotals.cbStores,
    });

    // Topline
    if (toplineStmt) {
      const toplinePay = payrollHasSeparateLoanCols
        ? mergedTotals.toplineLoans
        : (!afritecStmt ? mergedTotals.staffLoans : null);
      summaryRows.push({
        label: 'Topline',
        stmt: toplineStmt.total,
        pay: toplinePay,
        diff: toplinePay != null ? toplineStmt.total - toplinePay : null,
      });
    }

    // Combined loan reconciliation row — only needed when both lenders present
    // but payroll has no separate columns (each row above shows stmt only in that case)
    if (bothLenders && !payrollHasSeparateLoanCols) {
      summaryRows.push({
        label: 'Total Loans',
        stmt: loanStmtTotal,
        pay: mergedTotals.staffLoans,
        diff: loanStmtTotal - mergedTotals.staffLoans,
        isCombined: true,
      });
    }

    if (boduloStmt) summaryRows.push({
      label: 'Bodulo Funeral',
      stmt: boduloStmt.total,
      pay: mergedTotals.bodulo,
      diff: boduloStmt.total - mergedTotals.bodulo,
    });
  }

  // Per-employee cross-check: union of all employee codes
  interface EmpRow {
    empCode: string;
    name: string;
    section?: string; // section label from CB/Topline multi-section files
    furnmart_stmt: number | null; furnmart_pay: number | null;
    afritec_stmt: number | null;  afritec_pay: number | null;
    topline_stmt: number | null;  topline_pay: number | null;
    cb_stmt: number | null;       cb_pay: number | null;
    bodulo_stmt: number | null;   bodulo_pay: number | null;
  }

  function buildEmpMap<T extends ReconLine>(lines?: T[]): Map<string, T> {
    const m = new Map<string, T>();
    lines?.forEach(l => m.set(l.empCode, l));
    return m;
  }

  // Build payMap from permanent payroll, then add any FTC employees not already present
  const payMap = new Map((payroll?.lines ?? []).map(l => [l.empCode, l]));
  (ftcPayroll?.lines ?? []).forEach(l => { if (!payMap.has(l.empCode)) payMap.set(l.empCode, l); });

  const furnMap    = buildEmpMap(furnmartStmt?.lines);
  const afritecMap = buildEmpMap(afritecStmt?.lines);
  // CB Stores / Topline may use matchByName — their empCode is a nameKey, not a hotel code.
  // Build the same way; lookups switch from payroll empCode to nameKey(payroll name).
  const toplineMap = buildEmpMap(toplineStmt?.lines);
  const cbMap      = buildEmpMap(cbStmt?.lines);
  const boduloMap  = buildEmpMap(boduloStmt?.lines);

  // Code-based allCodes excludes name-matched statements (their keys aren't hotel emp codes)
  const allCodes = new Set<string>([
    ...allPayrollLines.map(l => l.empCode),
    ...(furnmartStmt?.lines ?? []).map(l => l.empCode),
    ...(afritecStmt?.lines ?? []).map(l => l.empCode),
    ...(!toplineStmt?.matchByName ? (toplineStmt?.lines ?? []).map(l => l.empCode) : []),
    ...(!cbStmt?.matchByName      ? (cbStmt?.lines      ?? []).map(l => l.empCode) : []),
    ...(boduloStmt?.lines ?? []).map(l => l.empCode),
  ]);

  // Track which name-matched statement lines were consumed during code-based pass
  const matchedCbKeys      = new Set<string>();
  const matchedToplineKeys = new Set<string>();

  const empRows: EmpRow[] = Array.from(allCodes)
    .filter(c => c)
    .sort()
    .map(code => {
      const pay = payMap.get(code);
      // Per-employee loan payroll amounts — null when payroll has no separate column
      // and both lenders are present (can't split combined staffLoans per employee)
      const afritecPay = pay == null ? null
        : payrollHasSeparateLoanCols ? pay.afritecLoans
        : !toplineStmt ? pay.staffLoans
        : null;
      const toplinePay = pay == null ? null
        : payrollHasSeparateLoanCols ? pay.toplineLoans
        : !afritecStmt ? pay.staffLoans
        : null;

      // CB Stores: name-based lookup using payroll employee name
      let cb_stmt: number | null = null;
      if (cbStmt) {
        if (cbStmt.matchByName && pay) {
          const key = nameKey(pay.name);
          const match = cbMap.get(key);
          if (match) { cb_stmt = match.amount; matchedCbKeys.add(key); }
        } else if (!cbStmt.matchByName) {
          cb_stmt = cbMap.get(code)?.amount ?? null;
        }
      }

      // Topline: name-based lookup using payroll employee name
      let topline_stmt: number | null = null;
      if (toplineStmt) {
        if (toplineStmt.matchByName && pay) {
          const key = nameKey(pay.name);
          const match = toplineMap.get(key);
          if (match) { topline_stmt = match.amount; matchedToplineKeys.add(key); }
        } else if (!toplineStmt.matchByName) {
          topline_stmt = toplineMap.get(code)?.amount ?? null;
        }
      }

      return {
        empCode: code,
        name: pay?.name
          ?? furnMap.get(code)?.name
          ?? afritecMap.get(code)?.name
          ?? boduloMap.get(code)?.name
          ?? code,
        furnmart_stmt: furnmartStmt ? (furnMap.get(code)?.amount ?? null) : null,
        furnmart_pay: furnmartStmt && pay ? pay.furnmart : null,
        afritec_stmt: afritecStmt ? (afritecMap.get(code)?.amount ?? null) : null,
        afritec_pay: afritecStmt ? afritecPay : null,
        topline_stmt: toplineStmt ? topline_stmt : null,
        topline_pay: toplineStmt ? toplinePay : null,
        cb_stmt: cbStmt ? cb_stmt : null,
        cb_pay: cbStmt && pay ? pay.cbStores : null,
        bodulo_stmt: boduloStmt ? (boduloMap.get(code)?.amount ?? null) : null,
        bodulo_pay: boduloStmt && pay ? pay.bodulo : null,
      };
    });

  // Append name-matched statement entries that had no payroll counterpart
  // (in statement but not in payroll — payroll side shows —)
  if (cbStmt?.matchByName) {
    for (const [key, line] of cbMap) {
      if (!matchedCbKeys.has(key)) {
        empRows.push({
          empCode: '', name: line.name, section: line.section,
          furnmart_stmt: null, furnmart_pay: null,
          afritec_stmt: null,  afritec_pay: null,
          topline_stmt: null,  topline_pay: null,
          cb_stmt: line.amount, cb_pay: null,
          bodulo_stmt: null,   bodulo_pay: null,
        });
      }
    }
  }
  if (toplineStmt?.matchByName) {
    for (const [key, line] of toplineMap) {
      if (!matchedToplineKeys.has(key)) {
        empRows.push({
          empCode: '', name: line.name, section: line.section,
          furnmart_stmt: null, furnmart_pay: null,
          afritec_stmt: null,  afritec_pay: null,
          topline_stmt: line.amount, topline_pay: null,
          cb_stmt: null,       cb_pay: null,
          bodulo_stmt: null,   bodulo_pay: null,
        });
      }
    }
  }

  // ── Second-pass: name-match ALL statement unmatchedLines against payroll ──────
  // Afritec/Furnmart put unrecognised-code entries into unmatchedLines; CB/Topline
  // (old-format uploads) also store everything in unmatchedLines. Cross-check them
  // against payroll employees by sorted-word name key before surfacing in the callout.

  const empRowByNameKey = new Map<string, EmpRow>(
    empRows.filter(r => r.empCode && r.name).map(r => [nameKey(r.name), r]),
  );

  const resolvedFurnmart  = new Set<string>();
  const resolvedAfritec   = new Set<string>();
  const resolvedCb        = new Set<string>();
  const resolvedTopline   = new Set<string>();
  const resolvedBodulo    = new Set<string>();

  function tryResolveByName(
    lines: ReconLine[],
    resolved: Set<string>,
    setter: (row: EmpRow, line: ReconLine) => void,
  ) {
    for (const line of lines) {
      if (!line.name) continue;
      const k = nameKey(line.name);
      const row = empRowByNameKey.get(k);
      if (row) { setter(row, line); resolved.add(k); }
    }
  }

  if (furnmartStmt) tryResolveByName(furnmartStmt.unmatchedLines, resolvedFurnmart,
    (r, l) => { if (r.furnmart_stmt == null) r.furnmart_stmt = l.amount; });
  if (afritecStmt) tryResolveByName(afritecStmt.unmatchedLines, resolvedAfritec,
    (r, l) => { if (r.afritec_stmt == null) r.afritec_stmt = l.amount; });
  if (cbStmt) tryResolveByName(cbStmt.unmatchedLines, resolvedCb,
    (r, l) => { if (r.cb_stmt == null) { r.cb_stmt = l.amount; if (!r.section) r.section = l.section; } });
  if (toplineStmt) tryResolveByName(toplineStmt.unmatchedLines, resolvedTopline,
    (r, l) => { if (r.topline_stmt == null) { r.topline_stmt = l.amount; if (!r.section) r.section = l.section; } });
  if (boduloStmt) tryResolveByName(boduloStmt.unmatchedLines, resolvedBodulo,
    (r, l) => { if (r.bodulo_stmt == null) r.bodulo_stmt = l.amount; });

  // Add entries that are truly absent from payroll (no match by code or name)
  function addNoPayrollRow(
    lines: ReconLine[],
    resolved: Set<string>,
    patch: (l: ReconLine) => Partial<EmpRow>,
  ) {
    for (const line of lines) {
      const k = nameKey(line.name);
      if (resolved.has(k) || empRowByNameKey.has(k)) continue;
      empRows.push({
        empCode: '', name: line.name, section: line.section,
        furnmart_stmt: null, furnmart_pay: null,
        afritec_stmt: null,  afritec_pay: null,
        topline_stmt: null,  topline_pay: null,
        cb_stmt: null,       cb_pay: null,
        bodulo_stmt: null,   bodulo_pay: null,
        ...patch(line),
      });
    }
  }

  addNoPayrollRow(furnmartStmt?.unmatchedLines ?? [], resolvedFurnmart, l => ({ furnmart_stmt: l.amount }));
  addNoPayrollRow(afritecStmt?.unmatchedLines ?? [], resolvedAfritec, l => ({ afritec_stmt: l.amount }));
  addNoPayrollRow(cbStmt?.unmatchedLines ?? [], resolvedCb, l => ({ cb_stmt: l.amount }));
  addNoPayrollRow(toplineStmt?.unmatchedLines ?? [], resolvedTopline, l => ({ topline_stmt: l.amount }));
  addNoPayrollRow(boduloStmt?.unmatchedLines ?? [], resolvedBodulo, l => ({ bodulo_stmt: l.amount }));

  // Separate management employees (from MGMT sections) into their own bucket
  const isMgt = (r: EmpRow) => /mgmt|management/i.test(r.section ?? '');

  // Only show rows that have at least one non-zero deduction value for an uploaded statement
  const hasAnyDeduction = (r: EmpRow) =>
    (furnmartStmt != null && ((r.furnmart_stmt ?? 0) > 0 || (r.furnmart_pay ?? 0) > 0)) ||
    (afritecStmt  != null && ((r.afritec_stmt  ?? 0) > 0 || (r.afritec_pay  ?? 0) > 0)) ||
    (toplineStmt  != null && ((r.topline_stmt  ?? 0) > 0 || (r.topline_pay  ?? 0) > 0)) ||
    (cbStmt       != null && ((r.cb_stmt       ?? 0) > 0 || (r.cb_pay       ?? 0) > 0)) ||
    (boduloStmt   != null && ((r.bodulo_stmt   ?? 0) > 0 || (r.bodulo_pay   ?? 0) > 0));

  const staffEmpRows = empRows.filter(r => !isMgt(r) && hasAnyDeduction(r));
  const mgtEmpRows   = empRows.filter(r => isMgt(r)  && hasAnyDeduction(r));

  // Per-vendor management amounts — used to split summary rows into Staff + Mgmt sub-rows
  const mgtVendorTotals = {
    furnmart: mgtEmpRows.reduce((s, r) => s + (r.furnmart_stmt ?? 0), 0),
    afritec:  mgtEmpRows.reduce((s, r) => s + (r.afritec_stmt  ?? 0), 0),
    topline:  mgtEmpRows.reduce((s, r) => s + (r.topline_stmt  ?? 0), 0),
    cb:       mgtEmpRows.reduce((s, r) => s + (r.cb_stmt       ?? 0), 0),
    bodulo:   mgtEmpRows.reduce((s, r) => s + (r.bodulo_stmt   ?? 0), 0),
  };

  // CFE employee name map for management cross-reference (surname+first name → Employee)
  const cfeNameMap = new Map<string, Employee>();
  cfeEmployees.forEach(e => cfeNameMap.set(nameKey(`${e.surname} ${e.first_name}`), e));

  // Map vendor label → management amount so we can split summary rows
  const VENDOR_MGT: Record<string, number> = {
    'Furnmart':       mgtVendorTotals.furnmart,
    'Afritec Loans':  mgtVendorTotals.afritec,
    'CB Stores':      mgtVendorTotals.cb,
    'Topline':        mgtVendorTotals.topline,
    'Bodulo Funeral': mgtVendorTotals.bodulo,
    'Total Loans':    mgtVendorTotals.afritec + mgtVendorTotals.topline,
  };

  // Expand each vendor summary row: when management amounts exist, split into
  // a staff sub-row (stmt vs payroll → should reconcile) + a management sub-row
  // (stmt only — CFE payroll is separate). The staff stmt already excludes mgmt.
  const expandedSummaryRows: SummaryRow[] = [];
  for (const row of summaryRows) {
    const mgtAmt = row.isCombined ? 0 : (VENDOR_MGT[row.label] ?? 0);
    if (mgtAmt > 0) {
      const staffStmt = row.stmt - mgtAmt;
      expandedSummaryRows.push({
        ...row,
        stmt: staffStmt,
        pay: row.pay,
        diff: row.pay != null ? staffStmt - row.pay : null,
      });
      expandedSummaryRows.push({ label: row.label, stmt: mgtAmt, pay: null, diff: null, isMgmt: true });
    } else {
      expandedSummaryRows.push(row);
    }
  }

  // ── Prior-month changes ───────────────────────────────────────────────────
  // Unified prev-month shape regardless of source (recon upload or salary_records)
  type PrevEmp = { empCode: string; name: string; basic: number };

  const prevDataList: PrevEmp[] = prevPayrollLines != null
    ? prevPayrollLines.map(l => ({ empCode: l.empCode, name: l.name, basic: l.basic }))
    : prevRecords.map(r => ({
        empCode: (r.employees.employee_code ?? '').toUpperCase(),
        name: `${r.employees.first_name} ${r.employees.surname}`.trim(),
        basic: r.basic_salary,
      }));

  const prevMap = new Map(prevDataList.map(d => [d.empCode, d]));
  const curCodes = new Set(allPayrollLines.map(l => l.empCode));
  const prevCodes = new Set(prevMap.keys());

  const newEmps       = allPayrollLines.filter(l => !prevCodes.has(l.empCode));
  const leftEmps      = prevDataList.filter(d => !curCodes.has(d.empCode));
  const salaryChanges = allPayrollLines.filter(l => {
    const prev = prevMap.get(l.empCode);
    if (!prev) return false;
    return Math.abs(l.basic - prev.basic) > 0.5;
  });

  // ── DB cross-reference (CSL / NL — per sub-tab) ──────────────────────────
  type CrossRefRow = {
    name: string;
    dbEmployee: Employee | null;
    dbBasic: number | null;
    payBasic: number | null;
    ftc: boolean;
  };

  function buildCrossRef(xref: HotelXRefData): CrossRefRow[] {
    const basicMap = new Map<string, number>();
    xref.salaryRecords.forEach(r => {
      if (!basicMap.has(r.employee_id)) basicMap.set(r.employee_id, r.basic_salary);
    });
    const byNameKey = new Map<string, Employee>();
    xref.employees.forEach(e => byNameKey.set(nameKey(`${e.surname} ${e.first_name}`), e));

    const rows: CrossRefRow[] = [];
    const matched = new Set<string>();

    for (const l of xref.payrollLines) {
      const db = byNameKey.get(nameKey(l.name));
      if (db) matched.add(db.id);
      rows.push({
        name: l.name,
        dbEmployee: db ?? null,
        dbBasic: db ? (basicMap.get(db.id) ?? null) : null,
        payBasic: l.basic,
        ftc: db?.grade_label === 'FTC' || db?.grade_label === 'Fixed Term',
      });
    }
    for (const emp of xref.employees) {
      if (!matched.has(emp.id)) {
        rows.push({
          name: `${emp.first_name} ${emp.surname}`.trim(),
          dbEmployee: emp,
          dbBasic: basicMap.get(emp.id) ?? null,
          payBasic: null,
          ftc: emp.grade_label === 'FTC' || emp.grade_label === 'Fixed Term',
        });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  const activeXRef  = crossRefSubTab === 'CSL' ? cslXRef : nlXRef;
  const crossRefRows = buildCrossRef(activeXRef);

  function xrefStats(rows: CrossRefRow[]) {
    return {
      matched:  rows.filter(r => r.dbEmployee && r.payBasic != null && r.dbBasic != null && Math.abs((r.payBasic ?? 0) - (r.dbBasic ?? 0)) <= 0.5).length,
      mismatch: rows.filter(r => r.dbEmployee && r.payBasic != null && r.dbBasic != null && Math.abs((r.payBasic ?? 0) - (r.dbBasic ?? 0)) > 0.5).length,
      payOnly:  rows.filter(r => !r.dbEmployee).length,
      dbOnly:   rows.filter(r => r.dbEmployee && r.payBasic == null).length,
    };
  }

  const crossRefStats = xrefStats(crossRefRows);
  const cslStats = xrefStats(buildCrossRef(cslXRef));
  const nlStats  = xrefStats(buildCrossRef(nlXRef));
  const totalBadge = cslStats.mismatch + cslStats.payOnly + cslStats.dbOnly
                   + nlStats.mismatch  + nlStats.payOnly  + nlStats.dbOnly;

  const filteredCrossRef = crossRefRows.filter(r => {
    if (crossRefFilter === 'mismatch') return r.dbEmployee && r.payBasic != null && r.dbBasic != null && Math.abs((r.payBasic ?? 0) - (r.dbBasic ?? 0)) > 0.5;
    if (crossRefFilter === 'payonly')  return !r.dbEmployee;
    if (crossRefFilter === 'dbonly')   return r.dbEmployee && r.payBasic == null;
    return true;
  });

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>;

  const years = [year - 1, year, year + 1];

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="border-b bg-white px-6 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-lg font-semibold text-foreground">Payroll Reconciliation</h1>

          {/* Hotel tabs */}
          <div className="flex gap-1 flex-wrap">
            {hotels.map(h => (
              <button
                key={h.id}
                onClick={() => setHotelId(h.id)}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  h.id === hotelId
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {h.short_code}
              </button>
            ))}
          </div>

          {/* Status + workflow — right side */}
          <div className="flex items-center gap-2 ml-auto">
            {period && (
              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATUS_COLORS[period.status]}`}>
                {STATUS_LABELS[period.status]}
              </span>
            )}
            {period && (
              <span className="text-sm text-muted-foreground">
                {MONTH_NAMES[month - 1]} {year}
              </span>
            )}

            {/* Workflow buttons */}
            {period?.status === 'open' && (
              <button
                onClick={() => updateStatus('submitted')}
                disabled={saving || !payrollUpload}
                className="px-3 py-1 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                Submit
              </button>
            )}
            {period?.status === 'submitted' && (
              <button
                onClick={() => updateStatus('approved')}
                disabled={saving}
                className="px-3 py-1 bg-green-700 text-white rounded text-sm font-medium hover:bg-green-800 disabled:opacity-50"
              >
                Approve
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Tab nav ── */}
      <div className="border-b bg-white px-6">
        <div className="flex gap-1">
          {(['upload', 'deductions'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'deductions' ? 'Deductions Check' : 'Upload'}
            </button>
          ))}
          <button
            onClick={() => setTab('crossref')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === 'crossref' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            Employees
            {totalBadge > 0 && (
              <span className="ml-1.5 bg-orange-100 text-orange-700 rounded-full px-1.5 text-xs">
                {totalBadge}
              </span>
            )}
          </button>
          {(['changes', 'queries'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'changes' ? 'Prior Month Changes' : 'Queries'}
              {t === 'queries' && queries.filter(q => !q.resolved_at).length > 0 && (
                <span className="ml-1.5 bg-red-100 text-red-700 rounded-full px-1.5 text-xs">
                  {queries.filter(q => !q.resolved_at).length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-auto p-6">

        {/* ═════ UPLOAD TAB ═════ */}
        {tab === 'upload' && (
          <div className="max-w-3xl space-y-3">
            {/* Period selector */}
            <div className="flex items-center gap-3 rounded-lg border bg-white px-4 py-3 mb-2">
              <span className="text-sm font-medium text-muted-foreground">Uploading for</span>
              <select
                value={month}
                onChange={e => setMonth(Number(e.target.value))}
                className="border rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {MONTH_NAMES.map((m, i) => (
                  <option key={i} value={i + 1}>{m}</option>
                ))}
              </select>
              <select
                value={year}
                onChange={e => setYear(Number(e.target.value))}
                className="border rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <span className="text-sm text-muted-foreground">— <strong>{hotel?.name}</strong></span>
            </div>

            {UPLOAD_CONFIGS.map(cfg => {
              const existing = uploads.find(u => u.upload_type === cfg.type);
              return (
                <div
                  key={cfg.type}
                  className="flex items-center gap-4 rounded-lg border bg-white px-4 py-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{cfg.label}</span>
                      {cfg.required && <span className="text-xs text-red-500">required</span>}
                    </div>
                    <p className="text-xs text-muted-foreground">{cfg.desc}</p>
                  </div>

                  {existing ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-green-700 font-medium">✓ {existing.file_name}</span>
                      {existing.total_amount != null && (
                        <span className="text-xs text-muted-foreground">
                          {fmt(existing.total_amount, country)}
                        </span>
                      )}
                      {existing.row_count != null && (
                        <span className="text-xs text-muted-foreground">{existing.row_count} rows</span>
                      )}
                      {cfg.type === 'twelve_months' && (
                        <button
                          onClick={() => viewPdf(existing)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          View
                        </button>
                      )}
                      <button
                        onClick={() => fileRefs.current[cfg.type]?.click()}
                        className="text-xs text-blue-600 hover:underline"
                        disabled={uploading === cfg.type}
                      >
                        Replace
                      </button>
                      <button
                        onClick={() => deleteUpload(existing.id)}
                        className="text-xs text-red-500 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileRefs.current[cfg.type]?.click()}
                      disabled={uploading === cfg.type}
                      className="shrink-0 px-3 py-1.5 border rounded text-sm font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {uploading === cfg.type ? 'Parsing…' : 'Upload'}
                    </button>
                  )}

                  <input
                    type="file"
                    accept={cfg.accept}
                    className="hidden"
                    ref={el => { fileRefs.current[cfg.type] = el; }}
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(cfg.type, f);
                    }}
                  />
                </div>
              );
            })}

            {/* Notes */}
            {period && (
              <div className="mt-6">
                <label className="block text-sm font-medium mb-1">Period Notes</label>
                <textarea
                  defaultValue={period.notes ?? ''}
                  onBlur={e => saveNotes(e.target.value)}
                  rows={3}
                  placeholder="Add any notes for this reconciliation period…"
                  className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            )}
          </div>
        )}

        {/* ═════ DEDUCTIONS TAB ═════ */}
        {tab === 'deductions' && (
          <div className="space-y-6">
            {!hasAnyPayroll ? (
              <p className="text-muted-foreground text-sm">Upload a payroll spreadsheet first to enable cross-checks.</p>
            ) : (
              <>
                {/* Unmatched entries — truly absent from payroll (not resolved by code or name) */}
                {(() => {
                  const truly = [
                    { stmt: furnmartStmt, label: 'Furnmart', resolved: resolvedFurnmart },
                    { stmt: afritecStmt,  label: 'Afritec',  resolved: resolvedAfritec },
                    { stmt: toplineStmt,  label: 'Topline',  resolved: resolvedTopline },
                    { stmt: cbStmt,       label: 'CB Stores',resolved: resolvedCb },
                    { stmt: boduloStmt,   label: 'Bodulo',   resolved: resolvedBodulo },
                  ].flatMap(({ stmt, label, resolved }) =>
                    (stmt?.unmatchedLines ?? [])
                      .filter(l => !resolved.has(nameKey(l.name)) && !empRowByNameKey.has(nameKey(l.name)))
                      .map(l => ({ label, line: l }))
                  );
                  if (!truly.length) return null;
                  return (
                    <div className="rounded border border-orange-200 bg-orange-50 p-4">
                      <p className="text-xs font-semibold text-orange-800 mb-2">
                        Unmatched statement entries (not found in payroll by code or name)
                      </p>
                      {truly.map(({ label, line }, i) => (
                        <div key={i} className="text-xs text-orange-700">
                          {label}: {line.name || '(no name)'} — {fmt(line.amount, country)}
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Summary cards */}
                {summaryRows.length > 0 && (
                  <div>
                    <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                      Summary — Statement vs Payroll
                    </h2>
                    <table className="text-sm border rounded overflow-hidden w-full max-w-2xl">
                      <thead>
                        <tr className="bg-[#1B3A5C] text-white">
                          <th className="px-4 py-2 text-left font-semibold">Vendor</th>
                          <th className="px-4 py-2 text-right font-semibold">Statement</th>
                          <th className="px-4 py-2 text-right font-semibold">Payroll</th>
                          <th className="px-4 py-2 text-right font-semibold">Difference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {expandedSummaryRows.map((row, i) => (
                          <tr
                            key={`${row.label}-${row.isMgmt ? 'mgmt' : i}`}
                            className={`${row.isMgmt ? 'bg-teal-50/60' : row.isCombined ? '' : i % 2 === 0 ? 'bg-white' : 'bg-muted/20'} ${row.isCombined ? 'border-t border-muted' : ''}`}
                          >
                            <td className={`px-4 py-2 font-medium ${row.isCombined ? 'pl-8 text-muted-foreground italic text-xs' : ''} ${row.isMgmt ? 'pl-8 text-teal-700 text-sm font-normal' : ''}`}>
                              {row.isCombined
                                ? `↳ ${row.label}`
                                : row.isMgmt
                                  ? '↳ Mgmt (CFE)'
                                  : row.label}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{fmt(row.stmt, country)}</td>
                            <td className={`px-4 py-2 text-right tabular-nums ${row.isMgmt ? 'text-muted-foreground' : ''}`}>
                              {row.pay != null ? fmt(row.pay, country) : '—'}
                            </td>
                            <td className={`px-4 py-2 text-right tabular-nums ${row.diff != null ? diffClass(row.diff) : 'text-muted-foreground'}`}>
                              {row.diff != null ? fmtDiff(row.diff, country) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {expandedSummaryRows.some(r => r.diff != null && Math.abs(r.diff) > 0.01) && (
                      <p className="mt-2 text-xs text-orange-600">
                        Positive difference = statement amount exceeds payroll (potential under-capture). Negative = payroll exceeds statement.
                      </p>
                    )}
                  </div>
                )}

                {summaryRows.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    Upload at least one third-party statement (Furnmart, Afritec, Bodulo, etc.) to see the cross-check.
                  </p>
                )}

                {/* Per-employee table — staff only */}
                {staffEmpRows.length > 0 && summaryRows.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                        Employee Detail
                      </h2>
                      <div className="flex gap-1">
                        {([
                          { key: 'all',      label: 'All',      active: 'bg-slate-700 text-white',      inactive: 'bg-slate-100 text-slate-700 hover:bg-slate-200' },
                          furnmartStmt ? { key: 'furnmart', label: 'Furnmart',  active: 'bg-blue-600 text-white',       inactive: 'bg-blue-50 text-blue-700 hover:bg-blue-100' }  : null,
                          afritecStmt  ? { key: 'afritec',  label: 'Afritec',   active: 'bg-amber-600 text-white',      inactive: 'bg-amber-50 text-amber-700 hover:bg-amber-100' }  : null,
                          toplineStmt  ? { key: 'topline',  label: 'Topline',   active: 'bg-purple-600 text-white',     inactive: 'bg-purple-50 text-purple-700 hover:bg-purple-100' }  : null,
                          cbStmt       ? { key: 'cbstores', label: 'CB Stores', active: 'bg-emerald-600 text-white',    inactive: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' } : null,
                          boduloStmt   ? { key: 'bodulo',   label: 'Bodulo',    active: 'bg-rose-600 text-white',       inactive: 'bg-rose-50 text-rose-700 hover:bg-rose-100' }    : null,
                        ]).filter(Boolean).map((f: any) => (
                          <button
                            key={f.key}
                            onClick={() => setDedFilter(f.key)}
                            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                              dedFilter === f.key ? f.active : f.inactive
                            }`}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="text-xs border rounded w-full whitespace-nowrap">
                        <thead>
                          <tr className="bg-[#1B3A5C] text-white">
                            <th className="px-3 py-2 text-left">Code</th>
                            <th className="px-3 py-2 text-left">Name</th>
                            {furnmartStmt && (dedFilter === 'all' || dedFilter === 'furnmart') && <>
                              <th className="px-3 py-2 text-right">Furnmart Stmt</th>
                              <th className="px-3 py-2 text-right">Furnmart Pay</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                            {afritecStmt && (dedFilter === 'all' || dedFilter === 'afritec') && <>
                              <th className="px-3 py-2 text-right">Afritec Stmt</th>
                              <th className="px-3 py-2 text-right">Afritec Pay</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                            {toplineStmt && (dedFilter === 'all' || dedFilter === 'topline') && <>
                              <th className="px-3 py-2 text-right">Topline Stmt</th>
                              <th className="px-3 py-2 text-right">Topline Pay</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                            {cbStmt && (dedFilter === 'all' || dedFilter === 'cbstores') && <>
                              <th className="px-3 py-2 text-right">CB Stores Stmt</th>
                              <th className="px-3 py-2 text-right">CB Stores Pay</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                            {boduloStmt && (dedFilter === 'all' || dedFilter === 'bodulo') && <>
                              <th className="px-3 py-2 text-right">Bodulo Stmt</th>
                              <th className="px-3 py-2 text-right">Bodulo Pay</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                          </tr>
                        </thead>
                        <tbody>
                          {(dedFilter === 'all' ? staffEmpRows : staffEmpRows.filter(row => {
                            if (dedFilter === 'furnmart') return (row.furnmart_stmt ?? 0) > 0 || (row.furnmart_pay ?? 0) > 0;
                            if (dedFilter === 'afritec')  return (row.afritec_stmt  ?? 0) > 0 || (row.afritec_pay  ?? 0) > 0;
                            if (dedFilter === 'topline')  return (row.topline_stmt  ?? 0) > 0 || (row.topline_pay  ?? 0) > 0;
                            if (dedFilter === 'cbstores') return (row.cb_stmt       ?? 0) > 0 || (row.cb_pay       ?? 0) > 0;
                            if (dedFilter === 'bodulo')   return (row.bodulo_stmt   ?? 0) > 0 || (row.bodulo_pay   ?? 0) > 0;
                            return true;
                          })).map((row, i) => {
                            const furnDiff    = row.furnmart_stmt != null && row.furnmart_pay != null
                              ? row.furnmart_stmt - row.furnmart_pay : null;
                            const afritecDiff = row.afritec_stmt != null && row.afritec_pay != null
                              ? row.afritec_stmt - row.afritec_pay : null;
                            const toplineDiff = row.topline_stmt != null && row.topline_pay != null
                              ? row.topline_stmt - row.topline_pay : null;
                            const cbDiff      = row.cb_stmt != null && row.cb_pay != null
                              ? row.cb_stmt - row.cb_pay : null;
                            const bodDiff     = row.bodulo_stmt != null && row.bodulo_pay != null
                              ? row.bodulo_stmt - row.bodulo_pay : null;
                            const hasDiscrep =
                              (furnDiff    != null && Math.abs(furnDiff)    > 0.01) ||
                              (afritecDiff != null && Math.abs(afritecDiff) > 0.01) ||
                              (toplineDiff != null && Math.abs(toplineDiff) > 0.01) ||
                              (cbDiff      != null && Math.abs(cbDiff)      > 0.01) ||
                              (bodDiff     != null && Math.abs(bodDiff)     > 0.01);
                            return (
                              <tr key={`${row.empCode || 'x'}-${row.name}-${i}`} className={`${i % 2 === 0 ? 'bg-white' : 'bg-muted/20'} ${hasDiscrep ? 'ring-1 ring-inset ring-orange-200' : ''}`}>
                                <td className="px-3 py-1.5 font-mono text-xs">
                                  {row.empCode && !row.empCode.includes('|') ? row.empCode : '—'}
                                  {row.empCode && ftcCodes.has(row.empCode) && (
                                    <span className="ml-1.5 font-sans text-xs bg-amber-100 text-amber-700 px-1 py-0.5 rounded">FTC</span>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 max-w-[140px] truncate">{row.name}</td>
                                {furnmartStmt && (dedFilter === 'all' || dedFilter === 'furnmart') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.furnmart_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.furnmart_pay, country)}</td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${furnDiff != null ? diffClass(furnDiff) : ''}`}>
                                    {furnDiff != null ? fmtDiff(furnDiff, country) : '—'}
                                  </td>
                                </>}
                                {afritecStmt && (dedFilter === 'all' || dedFilter === 'afritec') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.afritec_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.afritec_pay, country)}</td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${afritecDiff != null ? diffClass(afritecDiff) : 'text-muted-foreground'}`}>
                                    {afritecDiff != null ? fmtDiff(afritecDiff, country) : '—'}
                                  </td>
                                </>}
                                {toplineStmt && (dedFilter === 'all' || dedFilter === 'topline') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.topline_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.topline_pay, country)}</td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${toplineDiff != null ? diffClass(toplineDiff) : 'text-muted-foreground'}`}>
                                    {toplineDiff != null ? fmtDiff(toplineDiff, country) : '—'}
                                  </td>
                                </>}
                                {cbStmt && (dedFilter === 'all' || dedFilter === 'cbstores') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.cb_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.cb_pay, country)}</td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${cbDiff != null ? diffClass(cbDiff) : ''}`}>
                                    {cbDiff != null ? fmtDiff(cbDiff, country) : '—'}
                                  </td>
                                </>}
                                {boduloStmt && (dedFilter === 'all' || dedFilter === 'bodulo') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.bodulo_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.bodulo_pay, country)}</td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${bodDiff != null ? diffClass(bodDiff) : ''}`}>
                                    {bodDiff != null ? fmtDiff(bodDiff, country) : '—'}
                                  </td>
                                </>}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                  </div>
                )}

                {/* Management section — CFE employees from MGMT sections in statements */}
                {mgtEmpRows.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                          Management (CFE)
                        </h2>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          On CFE Management payroll — statement amounts shown. Reconcile via the CFE tab.
                          {cfeEmployees.length > 0 && (
                            <span className="ml-2 text-teal-700">
                              {mgtEmpRows.filter(r => cfeNameMap.has(nameKey(r.name))).length}/{mgtEmpRows.length} matched in CFE records
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="text-xs border rounded w-full whitespace-nowrap">
                        <thead>
                          <tr className="bg-[#2D6A4F] text-white">
                            <th className="px-3 py-2 text-left">Code</th>
                            <th className="px-3 py-2 text-left">Name</th>
                            {furnmartStmt && (dedFilter === 'all' || dedFilter === 'furnmart') && <>
                              <th className="px-3 py-2 text-right">Furnmart Stmt</th>
                              <th className="px-3 py-2 text-right">Payroll</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                            {afritecStmt && (dedFilter === 'all' || dedFilter === 'afritec') && <>
                              <th className="px-3 py-2 text-right">Afritec Stmt</th>
                              <th className="px-3 py-2 text-right">Payroll</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                            {toplineStmt && (dedFilter === 'all' || dedFilter === 'topline') && <>
                              <th className="px-3 py-2 text-right">Topline Stmt</th>
                              <th className="px-3 py-2 text-right">Payroll</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                            {cbStmt && (dedFilter === 'all' || dedFilter === 'cbstores') && <>
                              <th className="px-3 py-2 text-right">CB Stores Stmt</th>
                              <th className="px-3 py-2 text-right">Payroll</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                            {boduloStmt && (dedFilter === 'all' || dedFilter === 'bodulo') && <>
                              <th className="px-3 py-2 text-right">Bodulo Stmt</th>
                              <th className="px-3 py-2 text-right">Payroll</th>
                              <th className="px-3 py-2 text-right">±</th>
                            </>}
                          </tr>
                        </thead>
                        <tbody>
                          {(dedFilter === 'all' ? mgtEmpRows : mgtEmpRows.filter(row => {
                            if (dedFilter === 'furnmart') return (row.furnmart_stmt ?? 0) > 0;
                            if (dedFilter === 'afritec')  return (row.afritec_stmt  ?? 0) > 0;
                            if (dedFilter === 'topline')  return (row.topline_stmt  ?? 0) > 0;
                            if (dedFilter === 'cbstores') return (row.cb_stmt       ?? 0) > 0;
                            if (dedFilter === 'bodulo')   return (row.bodulo_stmt   ?? 0) > 0;
                            return true;
                          })).map((row, i) => {
                            const cfeMatch = cfeNameMap.get(nameKey(row.name));
                            return (
                              <tr key={`mgt-${row.name}-${i}`} className={i % 2 === 0 ? 'bg-white' : 'bg-muted/20'}>
                                <td className="px-3 py-1.5 font-mono text-xs">
                                  {cfeMatch?.employee_code
                                    ? <span className="text-emerald-700 font-medium">{cfeMatch.employee_code}</span>
                                    : <span className="text-muted-foreground">—</span>
                                  }
                                </td>
                                <td className="px-3 py-1.5">
                                  <span className="font-medium">{row.name}</span>
                                  {!cfeMatch && cfeEmployees.length > 0 && (
                                    <span className="ml-1.5 text-xs text-orange-500 font-normal">unmatched</span>
                                  )}
                                </td>
                                {furnmartStmt && (dedFilter === 'all' || dedFilter === 'furnmart') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.furnmart_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                </>}
                                {afritecStmt && (dedFilter === 'all' || dedFilter === 'afritec') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.afritec_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                </>}
                                {toplineStmt && (dedFilter === 'all' || dedFilter === 'topline') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.topline_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                </>}
                                {cbStmt && (dedFilter === 'all' || dedFilter === 'cbstores') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.cb_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                </>}
                                {boduloStmt && (dedFilter === 'all' || dedFilter === 'bodulo') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.bodulo_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">—</td>
                                </>}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      CFE payroll not uploaded in this context — Payroll column shows — for all management employees.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═════ CROSS-REFERENCE TAB (CSL and NL) ═════ */}
        {tab === 'crossref' && (
          <div className="space-y-4">
            {/* CSL / NL sub-tabs */}
            <div className="flex gap-1 border-b">
              {(['CSL', 'NL'] as const).map(code => {
                const stats = code === 'CSL' ? cslStats : nlStats;
                const disc = stats.mismatch + stats.payOnly + stats.dbOnly;
                return (
                  <button
                    key={code}
                    onClick={() => { setCrossRefSubTab(code); setCrossRefFilter('all'); }}
                    className={`px-5 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                      crossRefSubTab === code ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {code}
                    {disc > 0 && (
                      <span className="ml-1.5 bg-orange-100 text-orange-700 rounded-full px-1.5 text-xs">{disc}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Filter chips */}
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setCrossRefFilter('all')} className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${crossRefFilter === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-white text-muted-foreground border-input hover:bg-muted'}`}>
                All ({crossRefRows.length})
              </button>
              <button onClick={() => setCrossRefFilter('mismatch')} className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${crossRefFilter === 'mismatch' ? 'bg-orange-600 text-white border-orange-600' : 'bg-white text-orange-700 border-orange-200 hover:bg-orange-50'}`}>
                Basic Mismatch ({crossRefStats.mismatch})
              </button>
              <button onClick={() => setCrossRefFilter('payonly')} className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${crossRefFilter === 'payonly' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-200 hover:bg-red-50'}`}>
                Not in DB ({crossRefStats.payOnly})
              </button>
              <button onClick={() => setCrossRefFilter('dbonly')} className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${crossRefFilter === 'dbonly' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-blue-200 hover:bg-blue-50'}`}>
                Not in Payroll ({crossRefStats.dbOnly})
              </button>
              <span className="px-3 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                ✓ Matched ({crossRefStats.matched})
              </span>
            </div>

            {!activeXRef.loaded ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : activeXRef.payrollLines.length === 0 && activeXRef.employees.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No payroll uploaded for {crossRefSubTab} in {MONTH_NAMES[month - 1]} {year} and no active employees in DB.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="text-sm border rounded w-full whitespace-nowrap">
                  <thead>
                    <tr className="bg-muted/40 text-left">
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Grade</th>
                      <th className="px-3 py-2">Department</th>
                      <th className="px-3 py-2 text-right">DB Basic</th>
                      <th className="px-3 py-2 text-right">Payroll Basic</th>
                      <th className="px-3 py-2 text-right">Diff</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCrossRef.map((row, i) => {
                      const diff = row.dbBasic != null && row.payBasic != null
                        ? row.payBasic - row.dbBasic
                        : null;
                      const isMatch    = diff != null && Math.abs(diff) <= 0.5;
                      const isMismatch = diff != null && Math.abs(diff) > 0.5;
                      const isPayOnly  = !row.dbEmployee;
                      const isDbOnly   = row.dbEmployee && row.payBasic == null;
                      return (
                        <tr
                          key={`xref-${i}`}
                          className={`border-t ${isMismatch ? 'bg-orange-50/50' : isPayOnly ? 'bg-red-50/40' : isDbOnly ? 'bg-blue-50/40' : i % 2 === 0 ? 'bg-white' : 'bg-muted/10'}`}
                        >
                          <td className="px-3 py-1.5 font-medium">
                            {row.name}
                            {row.ftc && (
                              <span className="ml-1.5 text-xs bg-amber-100 text-amber-700 px-1 py-0.5 rounded">FTC</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground text-xs">
                            {row.dbEmployee?.grade_label ?? '—'}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground text-xs">
                            {row.dbEmployee?.department_code ?? '—'}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {row.dbBasic != null ? fmt(row.dbBasic, country) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {row.payBasic != null ? fmt(row.payBasic, country) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${isMatch ? 'text-green-700' : isMismatch ? (diff! > 0 ? 'text-red-600' : 'text-orange-600') : 'text-muted-foreground'}`}>
                            {isMatch ? '✓' : diff != null ? `${diff > 0 ? '+' : ''}${fmt(diff, country)}` : '—'}
                          </td>
                          <td className="px-3 py-1.5">
                            {isPayOnly  && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">Not in DB</span>}
                            {isDbOnly   && <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Not in payroll</span>}
                            {isMismatch && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">Basic diff</span>}
                            {isMatch    && <span className="text-xs text-green-700">Matched</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredCrossRef.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground text-sm">
                          No records match this filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ═════ CHANGES TAB ═════ */}
        {tab === 'changes' && (
          <div className="space-y-6">
            {!hasAnyPayroll ? (
              <p className="text-muted-foreground text-sm">Upload a payroll spreadsheet first.</p>
            ) : prevDataList.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No payroll data found for the previous month (
                {MONTH_NAMES[month === 1 ? 11 : month - 2]} {month === 1 ? year - 1 : year}).
                Upload that month&apos;s payroll spreadsheet via the Upload tab, or import it via Import HR List.
              </p>
            ) : (
              <>
                {/* New employees */}
                <div>
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    New Employees ({newEmps.length})
                  </h2>
                  {newEmps.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None — headcount unchanged.</p>
                  ) : (
                    <table className="text-sm border rounded w-full max-w-xl">
                      <thead>
                        <tr className="bg-muted/40">
                          <th className="px-3 py-2 text-left">Code</th>
                          <th className="px-3 py-2 text-left">Name</th>
                          <th className="px-3 py-2 text-right">Basic</th>
                        </tr>
                      </thead>
                      <tbody>
                        {newEmps.map(e => (
                          <tr key={e.empCode} className="border-t">
                            <td className="px-3 py-1.5 font-mono text-xs">
                              {e.empCode && !e.empCode.includes('|') ? e.empCode : '—'}
                              {ftcCodes.has(e.empCode) && (
                                <span className="ml-1.5 font-sans text-xs bg-amber-100 text-amber-700 px-1 py-0.5 rounded">FTC</span>
                              )}
                            </td>
                            <td className="px-3 py-1.5">{e.name}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{fmt(e.basic, country)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Employees no longer in payroll */}
                <div>
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Not in Current Payroll ({leftEmps.length})
                  </h2>
                  {leftEmps.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None — no departures.</p>
                  ) : (
                    <table className="text-sm border rounded w-full max-w-xl">
                      <thead>
                        <tr className="bg-muted/40">
                          <th className="px-3 py-2 text-left">Code</th>
                          <th className="px-3 py-2 text-left">Name</th>
                          <th className="px-3 py-2 text-right">Prev Basic</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leftEmps.map((d, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-3 py-1.5 font-mono text-xs">
                              {d.empCode && !d.empCode.includes('|') ? d.empCode : '—'}
                            </td>
                            <td className="px-3 py-1.5">{d.name}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{fmt(d.basic, country)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Basic salary changes */}
                <div>
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Basic Salary Changes ({salaryChanges.length})
                  </h2>
                  {salaryChanges.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No basic salary changes from prior month.</p>
                  ) : (
                    <table className="text-sm border rounded w-full max-w-2xl">
                      <thead>
                        <tr className="bg-muted/40">
                          <th className="px-3 py-2 text-left">Code</th>
                          <th className="px-3 py-2 text-left">Name</th>
                          <th className="px-3 py-2 text-right">Prior Basic</th>
                          <th className="px-3 py-2 text-right">Current Basic</th>
                          <th className="px-3 py-2 text-right">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {salaryChanges.map(e => {
                          const prev = prevMap.get(e.empCode);
                          const chg = e.basic - (prev?.basic ?? 0);
                          return (
                            <tr key={e.empCode} className="border-t">
                              <td className="px-3 py-1.5 font-mono text-xs">
                                {e.empCode && !e.empCode.includes('|') ? e.empCode : '—'}
                                {ftcCodes.has(e.empCode) && (
                                  <span className="ml-1.5 font-sans text-xs bg-amber-100 text-amber-700 px-1 py-0.5 rounded">FTC</span>
                                )}
                              </td>
                              <td className="px-3 py-1.5">{e.name}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(prev?.basic ?? 0, country)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(e.basic, country)}</td>
                              <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${chg > 0 ? 'text-green-700' : 'text-red-600'}`}>
                                {chg > 0 ? '+' : ''}{fmt(chg, country)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ═════ QUERIES TAB ═════ */}
        {tab === 'queries' && (
          <div className="max-w-2xl space-y-4">
            {queries.length === 0 && (
              <p className="text-sm text-muted-foreground">No queries yet for this period.</p>
            )}

            {queries.map(q => (
              <QueryItem
                key={q.id}
                query={q}
                onResolve={(msg) => resolveQuery(q.id, msg)}
              />
            ))}

            {/* New query input */}
            <div className="border rounded p-4 bg-white mt-4">
              <label className="block text-sm font-medium mb-2">Raise a Query</label>
              <textarea
                value={newQuery}
                onChange={e => setNewQuery(e.target.value)}
                rows={3}
                placeholder="Describe the discrepancy or question…"
                className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={addQuery}
                disabled={!newQuery.trim()}
                className="mt-2 px-4 py-1.5 bg-primary text-primary-foreground rounded text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                Submit Query
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Query item sub-component ──────────────────────────────────────────────────

function QueryItem({ query, onResolve }: { query: ReconQuery; onResolve: (msg: string) => void }) {
  const [resolveMsg, setResolveMsg] = useState('');
  const [showResolve, setShowResolve] = useState(false);

  return (
    <div className={`border rounded p-4 ${query.resolved_at ? 'bg-green-50 border-green-200' : 'bg-white'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <p className="text-sm font-medium">{query.message}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {query.author_name} · {new Date(query.created_at).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })}
          </p>
        </div>
        {!query.resolved_at && (
          <button
            onClick={() => setShowResolve(v => !v)}
            className="text-xs text-blue-600 hover:underline shrink-0"
          >
            Resolve
          </button>
        )}
      </div>

      {query.resolved_at && (
        <div className="mt-2 pl-3 border-l-2 border-green-400">
          <p className="text-sm text-green-800">{query.resolved_message}</p>
          <p className="text-xs text-green-600 mt-0.5">
            Resolved by {query.resolver_name} · {new Date(query.resolved_at).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })}
          </p>
        </div>
      )}

      {showResolve && !query.resolved_at && (
        <div className="mt-3">
          <textarea
            value={resolveMsg}
            onChange={e => setResolveMsg(e.target.value)}
            rows={2}
            placeholder="Resolution / explanation…"
            className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={() => { onResolve(resolveMsg); setShowResolve(false); }}
            disabled={!resolveMsg.trim()}
            className="mt-1 px-3 py-1 bg-green-700 text-white rounded text-sm hover:bg-green-800 disabled:opacity-50"
          >
            Mark Resolved
          </button>
        </div>
      )}
    </div>
  );
}
