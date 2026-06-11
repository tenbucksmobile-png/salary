'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MONTH_NAMES, sortHotels, fmtCurrency } from '@/lib/utils';
import type { Hotel } from '@/types/database';
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
    type: 'topline', label: 'Topline Loan Statement', required: false,
    accept: '.xls,.xlsx', desc: 'Monthly loan instalment schedule (.xls)',
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

const LOAN_TYPES: ReconUploadType[] = ['afritec', 'topline'];

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
  const [tab, setTab] = useState<'upload' | 'deductions' | 'changes' | 'queries'>('upload');
  const [dedFilter, setDedFilter] = useState<'all' | 'furnmart' | 'loans' | 'cbstores' | 'bodulo'>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [newQuery, setNewQuery] = useState('');
  const [username, setUsername] = useState('admin');
  const [prevRecords, setPrevRecords] = useState<Array<{
    basic_salary: number;
    employees: { employee_code: string | null; surname: string; first_name: string };
  }>>([]);

  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => { if (d?.username) setUsername(d.username); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    supabase.from('hotels').select('*').then(({ data }) => {
      if (data) {
        const RECON_CODES = ['CFE', 'CSL', 'NL'];
        const filtered = sortHotels(data as Hotel[]).filter(h => RECON_CODES.includes(h.short_code));
        setHotels(filtered);
        const nl = filtered.find(h => h.short_code === 'NL') || filtered[0];
        if (nl) setHotelId(nl.id);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!hotelId) return;
    loadPeriod();
    loadPrevRecords();
  }, [hotelId, year, month]);

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

      if (type === 'payroll')   parsed = await parsePayrollXlsx(buf, file.name);
      else if (type === 'furnmart') parsed = await parseFurnmart(buf, file.name);
      else if (type === 'bodulo')   parsed = await parseBodulo(buf, file.name);
      else                          parsed = await parseAfritecXls(buf, file.name, type);

      const pid = await ensurePeriod();
      const isStmt = type !== 'payroll';
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

  function getStmt(type: ReconUploadType): ParsedStatement | undefined {
    return uploads.find(u => u.upload_type === type)?.parsed_data as ParsedStatement | undefined;
  }

  const furnmartStmt = getStmt('furnmart');
  const afritecStmt  = getStmt('afritec');
  const toplineStmt  = getStmt('topline');
  const cbStmt       = getStmt('cbstores');
  const boduloStmt   = getStmt('bodulo');

  // Combined loan (afritec + topline both map to staffLoans in payroll)
  const loanStmtTotal = (afritecStmt?.total ?? 0) + (toplineStmt?.total ?? 0);
  const hasLoan = afritecStmt || toplineStmt;

  // Summary rows for the deductions tab
  type SummaryRow = { label: string; stmt: number; pay: number; diff: number };
  const summaryRows: SummaryRow[] = [];
  if (payroll) {
    if (furnmartStmt) summaryRows.push({
      label: 'Furnmart',
      stmt: furnmartStmt.total,
      pay: payroll.totals.furnmart ?? 0,
      diff: furnmartStmt.total - (payroll.totals.furnmart ?? 0),
    });
    if (hasLoan) summaryRows.push({
      label: 'Afritec / Topline Loans',
      stmt: loanStmtTotal,
      pay: payroll.totals.staffLoans ?? 0,
      diff: loanStmtTotal - (payroll.totals.staffLoans ?? 0),
    });
    if (cbStmt) summaryRows.push({
      label: 'CB Stores',
      stmt: cbStmt.total,
      pay: payroll.totals.cbStores ?? 0,
      diff: cbStmt.total - (payroll.totals.cbStores ?? 0),
    });
    if (boduloStmt) summaryRows.push({
      label: 'Bodulo Funeral',
      stmt: boduloStmt.total,
      pay: payroll.totals.bodulo ?? 0,
      diff: boduloStmt.total - (payroll.totals.bodulo ?? 0),
    });
  }

  // Per-employee cross-check: union of all employee codes
  interface EmpRow {
    empCode: string;
    name: string;
    furnmart_stmt: number | null; furnmart_pay: number | null;
    loan_stmt: number | null;    loan_pay: number | null;
    cb_stmt: number | null;      cb_pay: number | null;
    bodulo_stmt: number | null;  bodulo_pay: number | null;
  }

  function buildEmpMap<T extends ReconLine>(lines?: T[]): Map<string, T> {
    const m = new Map<string, T>();
    lines?.forEach(l => m.set(l.empCode, l));
    return m;
  }

  const payMap     = new Map((payroll?.lines ?? []).map(l => [l.empCode, l]));
  const furnMap    = buildEmpMap(furnmartStmt?.lines);
  const loanMap    = new Map<string, number>();
  [...(afritecStmt?.lines ?? []), ...(toplineStmt?.lines ?? [])].forEach(l => {
    loanMap.set(l.empCode, (loanMap.get(l.empCode) ?? 0) + l.amount);
  });
  const cbMap      = buildEmpMap(cbStmt?.lines);
  const boduloMap  = buildEmpMap(boduloStmt?.lines);

  const allCodes = new Set<string>([
    ...(payroll?.lines ?? []).map(l => l.empCode),
    ...(furnmartStmt?.lines ?? []).map(l => l.empCode),
    ...(afritecStmt?.lines ?? []).map(l => l.empCode),
    ...(toplineStmt?.lines ?? []).map(l => l.empCode),
    ...(cbStmt?.lines ?? []).map(l => l.empCode),
    ...(boduloStmt?.lines ?? []).map(l => l.empCode),
  ]);

  const empRows: EmpRow[] = Array.from(allCodes)
    .filter(c => c)
    .sort()
    .map(code => {
      const pay = payMap.get(code);
      return {
        empCode: code,
        name: pay?.name
          ?? furnMap.get(code)?.name
          ?? afritecStmt?.lines.find(l => l.empCode === code)?.name
          ?? toplineStmt?.lines.find(l => l.empCode === code)?.name
          ?? cbMap.get(code)?.name
          ?? boduloMap.get(code)?.name
          ?? code,
        furnmart_stmt: furnmartStmt ? (furnMap.get(code)?.amount ?? null) : null,
        furnmart_pay: furnmartStmt && pay ? pay.furnmart : null,
        loan_stmt: hasLoan ? (loanMap.get(code) ?? null) : null,
        loan_pay: hasLoan && pay ? pay.staffLoans : null,
        cb_stmt: cbStmt ? (cbMap.get(code)?.amount ?? null) : null,
        cb_pay: cbStmt && pay ? pay.cbStores : null,
        bodulo_stmt: boduloStmt ? (boduloMap.get(code)?.amount ?? null) : null,
        bodulo_pay: boduloStmt && pay ? pay.bodulo : null,
      };
    });

  // ── Prior-month changes ───────────────────────────────────────────────────

  const prevMap = new Map(prevRecords.map(r => [
    (r.employees.employee_code ?? '').toUpperCase(),
    r,
  ]));
  const curCodes = new Set((payroll?.lines ?? []).map(l => l.empCode));
  const prevCodes = new Set(prevMap.keys());

  const newEmps    = payroll?.lines.filter(l => !prevCodes.has(l.empCode)) ?? [];
  const leftEmps   = prevRecords.filter(r => !curCodes.has((r.employees.employee_code ?? '').toUpperCase()));
  const salaryChanges = payroll?.lines.filter(l => {
    const prev = prevMap.get(l.empCode);
    if (!prev) return false;
    return Math.abs(l.basic - prev.basic_salary) > 0.5;
  }) ?? [];

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
          {(['upload', 'deductions', 'changes', 'queries'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'deductions' ? 'Deductions Check' : t === 'changes' ? 'Prior Month Changes' : t.charAt(0).toUpperCase() + t.slice(1)}
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
            {!payroll ? (
              <p className="text-muted-foreground text-sm">Upload the payroll spreadsheet first to enable cross-checks.</p>
            ) : (
              <>
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
                        {summaryRows.map((row, i) => (
                          <tr key={row.label} className={i % 2 === 0 ? 'bg-white' : 'bg-muted/20'}>
                            <td className="px-4 py-2 font-medium">{row.label}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{fmt(row.stmt, country)}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{fmt(row.pay, country)}</td>
                            <td className={`px-4 py-2 text-right tabular-nums ${diffClass(row.diff)}`}>
                              {fmtDiff(row.diff, country)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {summaryRows.some(r => Math.abs(r.diff) > 0.01) && (
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

                {/* Per-employee table */}
                {empRows.length > 0 && summaryRows.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                        Employee Detail
                      </h2>
                      <div className="flex gap-1">
                        {([
                          { key: 'all',      label: 'All' },
                          furnmartStmt ? { key: 'furnmart', label: 'Furnmart' }  : null,
                          hasLoan      ? { key: 'loans',    label: 'Loans' }     : null,
                          cbStmt       ? { key: 'cbstores', label: 'CB Stores' } : null,
                          boduloStmt   ? { key: 'bodulo',   label: 'Bodulo' }    : null,
                        ]).filter(Boolean).map((f: any) => (
                          <button
                            key={f.key}
                            onClick={() => setDedFilter(f.key)}
                            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                              dedFilter === f.key
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted text-muted-foreground hover:bg-muted/80'
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
                            {hasLoan && (dedFilter === 'all' || dedFilter === 'loans') && <>
                              <th className="px-3 py-2 text-right">Loans Stmt</th>
                              <th className="px-3 py-2 text-right">Loans Pay</th>
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
                          {empRows.map((row, i) => {
                            const furnDiff = row.furnmart_stmt != null && row.furnmart_pay != null
                              ? row.furnmart_stmt - row.furnmart_pay : null;
                            const loanDiff = row.loan_stmt != null && row.loan_pay != null
                              ? row.loan_stmt - row.loan_pay : null;
                            const cbDiff = row.cb_stmt != null && row.cb_pay != null
                              ? row.cb_stmt - row.cb_pay : null;
                            const bodDiff = row.bodulo_stmt != null && row.bodulo_pay != null
                              ? row.bodulo_stmt - row.bodulo_pay : null;
                            const hasDiscrep =
                              (furnDiff != null && Math.abs(furnDiff) > 0.01) ||
                              (loanDiff != null && Math.abs(loanDiff) > 0.01) ||
                              (cbDiff != null && Math.abs(cbDiff) > 0.01) ||
                              (bodDiff != null && Math.abs(bodDiff) > 0.01);
                            return (
                              <tr key={row.empCode} className={`${i % 2 === 0 ? 'bg-white' : 'bg-muted/20'} ${hasDiscrep ? 'ring-1 ring-inset ring-orange-200' : ''}`}>
                                <td className="px-3 py-1.5 font-mono text-xs">{row.empCode}</td>
                                <td className="px-3 py-1.5 max-w-[140px] truncate">{row.name}</td>
                                {furnmartStmt && (dedFilter === 'all' || dedFilter === 'furnmart') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.furnmart_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.furnmart_pay, country)}</td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${furnDiff != null ? diffClass(furnDiff) : ''}`}>
                                    {furnDiff != null ? fmtDiff(furnDiff, country) : '—'}
                                  </td>
                                </>}
                                {hasLoan && (dedFilter === 'all' || dedFilter === 'loans') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.loan_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.loan_pay, country)}</td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${loanDiff != null ? diffClass(loanDiff) : ''}`}>
                                    {loanDiff != null ? fmtDiff(loanDiff, country) : '—'}
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

                    {/* Unmatched entries */}
                    {[furnmartStmt, afritecStmt, toplineStmt, cbStmt, boduloStmt].some(s => s?.unmatchedLines.length) && (
                      <div className="mt-4 rounded border border-orange-200 bg-orange-50 p-4">
                        <p className="text-xs font-semibold text-orange-800 mb-2">
                          Unmatched statement entries (no payroll employee code found)
                        </p>
                        {[
                          { stmt: furnmartStmt, label: 'Furnmart' },
                          { stmt: afritecStmt, label: 'Afritec' },
                          { stmt: toplineStmt, label: 'Topline' },
                          { stmt: cbStmt, label: 'CB Stores' },
                          { stmt: boduloStmt, label: 'Bodulo' },
                        ].map(({ stmt, label }) =>
                          (stmt?.unmatchedLines ?? []).map((l, i) => (
                            <div key={`${label}-${i}`} className="text-xs text-orange-700">
                              {label}: {l.name || '(no name)'} — {fmt(l.amount, country)}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═════ CHANGES TAB ═════ */}
        {tab === 'changes' && (
          <div className="space-y-6">
            {!payroll ? (
              <p className="text-muted-foreground text-sm">Upload the payroll spreadsheet first.</p>
            ) : prevRecords.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No salary records found for the previous month (
                {MONTH_NAMES[month === 1 ? 11 : month - 2]} {month === 1 ? year - 1 : year}) in the database.
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
                            <td className="px-3 py-1.5 font-mono text-xs">{e.empCode}</td>
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
                        {leftEmps.map((r, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-3 py-1.5 font-mono text-xs">{r.employees.employee_code ?? '—'}</td>
                            <td className="px-3 py-1.5">{r.employees.first_name} {r.employees.surname}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.basic_salary, country)}</td>
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
                          const chg = e.basic - (prev?.basic_salary ?? 0);
                          return (
                            <tr key={e.empCode} className="border-t">
                              <td className="px-3 py-1.5 font-mono text-xs">{e.empCode}</td>
                              <td className="px-3 py-1.5">{e.name}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(prev?.basic_salary ?? 0, country)}</td>
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
