'use client';

import { useEffect, useRef, useState, Fragment } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MONTH_NAMES, sortHotels, fmtCurrency } from '@/lib/utils';
import type { Hotel, Employee } from '@/types/database';
import type {
  ReconciliationPeriod,
  ReconUpload,
  ReconUploadType,
  ReconConsolidationEntry,
  ReconEmployeeApproval,
  ReconApprovalCategory,
} from '@/types/database';
import {
  parseAfritecXls,
  parseFurnmart,
  parseBodulo,
  parsePayrollXlsx,
  parseFtcPayrollXls,
  parseCfemDeductions,
  nameKey,
  nameTokens,
  type PayrollLine,
} from '@/lib/recon-parsers';
import type { ParsedStatement, ParsedPayroll, ReconLine, ParsedCfemDeductions } from '@/lib/recon-parsers';
import { exportReport, type ReportSheet } from '@/lib/reports-export';

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
  {
    type: 'pension', label: 'Pension Contributions', required: false,
    accept: '.xls,.xlsx', desc: 'Monthly pension/provident fund contribution statement (.xls) — uploaded per hotel, including CFEM',
    payrollKey: 'pensionEe',
  },
  {
    type: 'cfem_deductions', label: 'CFEM Deductions Summary', required: true,
    accept: '.csv,.txt', desc: 'Combined per-vendor deductions report exported from the CFEM payroll system',
    payrollKey: null,
  },
];

// CFEM has its own confidential payroll and never uploads any salary data here —
// its single combined deductions report is the only upload slot shown ("12 Months
// Payroll Report" is also a salary document, so it's excluded too, not just Payroll Spreadsheet).
// Pension Contributions is the one exception: unlike the other 5 vendors (which arrive mixed
// into CSL's/NL's shared statements for CFE), pension is administered directly per hotel, so
// CFEM gets its own upload slot for it too, alongside the combined deductions report.
const CFEM_UPLOAD_TYPES: ReconUploadType[] = ['cfem_deductions', 'pension'];
const NON_CFEM_UPLOAD_TYPES: ReconUploadType[] = UPLOAD_CONFIGS
  .map(c => c.type)
  .filter(t => t !== 'cfem_deductions');

// Maps a CFEM Deductions Summary section's vendor label to the existing vendor upload_type
// keys the Deductions Check tab already knows how to render — "Afri Insurance" is CFEM's
// name for the same kind of deduction CSL/NL call "Bodulo Funeral Scheme"; "Taku" has no
// current equivalent (zero entries so far) and is intentionally left unmapped/unused.
const CFEM_VENDOR_TO_TYPE: Record<string, 'furnmart' | 'afritec' | 'topline' | 'cbstores' | 'bodulo'> = {
  'Furnmart': 'furnmart',
  'Afritec': 'afritec',
  'Topline': 'topline',
  'CB Stores': 'cbstores',
  'Afri Insurance': 'bodulo',
};
// Case-insensitive index of the map above — CFEM's export casing for a "LIST OF: <Vendor>"
// label isn't guaranteed to match these labels exactly (e.g. "FURNMART" vs "Furnmart"), and
// an exact-key miss here silently drops that vendor's section rather than erroring.
const CFEM_VENDOR_TO_TYPE_UPPER: Record<string, 'furnmart' | 'afritec' | 'topline' | 'cbstores' | 'bodulo'> =
  Object.fromEntries(Object.entries(CFEM_VENDOR_TO_TYPE).map(([k, v]) => [k.toUpperCase(), v]));
function lookupCfemVendorType(vendor: string) {
  return CFEM_VENDOR_TO_TYPE_UPPER[vendor.trim().toUpperCase()];
}


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
  const [tab, setTab] = useState<'upload' | 'deductions' | 'crossref' | 'consolidation'>('upload');
  const [dedFilter, setDedFilter] = useState<'all' | 'furnmart' | 'afritec' | 'topline' | 'cbstores' | 'bodulo' | 'pension'>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [username, setUsername] = useState('admin');
  const [userRole, setUserRole] = useState<'admin' | 'sub' | null>(null);
  const [cfeEmployees, setCfeEmployees] = useState<Employee[]>([]);

  // The Employees tab now does month-to-month payroll comparison (Basic Salary Mismatch /
  // New Appointments / Terminations) for CSL and NL only — CFE has no payroll uploaded here
  // at all (by design), so it isn't part of this comparison; it keeps its own separate
  // Deductions Check cross-reference below.
  type PayrollReconHotel = 'CSL' | 'NL';
  const PAYROLL_RECON_HOTELS: PayrollReconHotel[] = ['CSL', 'NL'];

  // Current + previous period's payroll lines per hotel — the sole basis for the
  // Employees tab's three sections. Never compared against the DB employee list.
  type TermPayrollState = { current: PayrollLine[]; previous: PayrollLine[]; loaded: boolean };
  const emptyTermPayroll: TermPayrollState = { current: [], previous: [], loaded: false };
  const [termPayrollByHotel, setTermPayrollByHotel] = useState<Record<PayrollReconHotel, TermPayrollState>>({ CSL: emptyTermPayroll, NL: emptyTermPayroll });

  // Employees tab approvals — per-record tickbox state, persisted so it survives navigation.
  // Loaded from DB on tab open; ticking a checkbox only updates local state (approvalTicks);
  // clicking Submit is what writes the current tick state to recon_employee_approvals.
  // Purely a staging record for now — nothing here writes to the employees table yet.
  const [employeeApprovals, setEmployeeApprovals] = useState<ReconEmployeeApproval[]>([]);
  const [approvalTicks, setApprovalTicks] = useState<Record<string, boolean>>({});
  const [submittingApprovals, setSubmittingApprovals] = useState(false);
  function approvalKey(category: ReconApprovalCategory, name: string) {
    return `${category}|${name}`;
  }

  // Commit — admin-only, writes approved (submitted + ticked) rows into employees/
  // salary_records for CSL/NL. Gated behind a confirm popup showing exactly what will be
  // written (including how each new-appointment name gets split into surname/first name,
  // since that's inherently ambiguous from a payroll file's single name column).
  const [showCommitConfirm, setShowCommitConfirm] = useState(false);
  const [committingApprovals, setCommittingApprovals] = useState(false);

  // CFE cross-reference (Deductions Check, CFEM only): CSL's and NL's own vendor
  // statement uploads for the same period, so CFEM's report can be diffed against
  // whatever CFE-employee lines are mixed into the shared third-party statements.
  type CfeVendorType = 'furnmart' | 'afritec' | 'topline' | 'cbstores' | 'bodulo';
  type OtherHotelStmts = Partial<Record<CfeVendorType, ParsedStatement>>;
  const emptyOtherHotelStmts: { CSL: OtherHotelStmts; NL: OtherHotelStmts; loaded: boolean } = { CSL: {}, NL: {}, loaded: false };
  const [csnStmtsForCfe, setCsnStmtsForCfe] = useState(emptyOtherHotelStmts);

  // Consolidation tab: director-facing monthly bank release sign-off, spanning all
  // three hotels for the selected month regardless of the main hotel selector.
  type ConsolidationHotel = 'CSL' | 'NL' | 'CFEM';
  const CONSOLIDATION_HOTELS: ConsolidationHotel[] = ['CSL', 'NL', 'CFEM'];
  type LineItem = 'basic_salary' | 'furnmart' | 'afritec' | 'topline' | 'cbstores' | 'bodulo' | 'pension';
  const LINE_ITEMS: LineItem[] = ['basic_salary', 'furnmart', 'afritec', 'topline', 'cbstores', 'bodulo', 'pension'];
  const LINE_ITEM_LABELS: Record<LineItem, string> = {
    basic_salary: 'Basic Salary', furnmart: 'Furnmart', afritec: 'Afritec',
    topline: 'Topline', cbstores: 'CB Stores', bodulo: 'Bodulo / Afri Insurance', pension: 'Pension',
  };
  // null = no automatic source in this app for that line item (only CFEM's Basic Salary,
  // since CFEM payroll is never uploaded here) — falls back to a manual system_amount entry.
  type SystemTotals = Record<LineItem, number | null>;
  const emptySystemTotals: SystemTotals = { basic_salary: 0, furnmart: 0, afritec: 0, topline: 0, cbstores: 0, bodulo: 0, pension: 0 };
  const [consolidationSystem, setConsolidationSystem] = useState<Record<ConsolidationHotel, SystemTotals> & { loaded: boolean }>({
    CSL: emptySystemTotals, NL: emptySystemTotals, CFEM: emptySystemTotals, loaded: false,
  });
  const [consolidationEntries, setConsolidationEntries] = useState<ReconConsolidationEntry[]>([]);

  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => {
        if (d?.username) setUsername(d.username);
        if (d?.role) setUserRole(d.role);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      supabase.from('hotels').select('*'),
      fetch('/api/auth/me').then(r => r.ok ? r.json() : null),
    ]).then(([{ data }, me]) => {
      if (data) {
        const RECON_CODES = ['CFEM', 'CSL', 'NL'];
        let filtered = sortHotels(data as Hotel[]).filter(h => RECON_CODES.includes(h.short_code));
        const meData = me as { role: string; hotelIds: string[] | null } | null;
        if (meData?.role === 'sub' && meData.hotelIds?.length) {
          filtered = filtered.filter(h => meData.hotelIds!.includes(h.id));
        }
        setHotels(filtered);
        const csl = filtered.find(h => h.short_code === 'CSL') || filtered[0];
        if (csl) setHotelId(csl.id);

        // Load CFE employees for management cross-reference (all users, unfiltered)
        const cfeHotel = (data as Hotel[]).find(h => h.short_code === 'CFEM');
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
    loadPeriod();
  }, [hotelId, year, month]);

  // The Employees tab only applies to CSL/NL — if the hotel pill switches to CFEM
  // while it's open, drop back to Upload rather than showing a stale/mislabeled view.
  useEffect(() => {
    if (tab !== 'crossref') return;
    const code = hotels.find(h => h.id === hotelId)?.short_code;
    if (code !== 'CSL' && code !== 'NL') setTab('upload');
  }, [hotelId, hotels, tab]);

  // Load payroll lines uploaded for a given hotel/period's recon upload (payroll +
  // ftc_payroll merged, deduplicated by nameKey). Shared by the Employees tab (current
  // period AND previous period, compared against each other) and the CFE cross-reference.
  async function loadPeriodPayrollLines(hotelId: string, y: number, m: number): Promise<PayrollLine[]> {
    const { data: periodRow } = await supabase
      .from('reconciliation_periods')
      .select('id')
      .eq('hotel_id', hotelId)
      .eq('period_year', y)
      .eq('period_month', m)
      .maybeSingle();
    if (!periodRow) return [];

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
    return merged.filter(l => {
      const k = nameKey(l.name);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Employees tab: compare the current period's payroll upload against the PREVIOUS
  // period's payroll upload only, for CSL and NL — never against the DB employee list,
  // which stays static regardless of how many payroll-only months are uploaded and would
  // just re-flag the same people every month. Triggered when the Employees tab opens or
  // year/month/hotels changes.
  useEffect(() => {
    if (tab !== 'crossref' || !hotels.length) return;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;

    async function load(shortCode: PayrollReconHotel): Promise<TermPayrollState> {
      const hotel = hotels.find(h => h.short_code === shortCode);
      if (!hotel) return { ...emptyTermPayroll, loaded: true };
      const [current, previous] = await Promise.all([
        loadPeriodPayrollLines(hotel.id, year, month),
        loadPeriodPayrollLines(hotel.id, prevYear, prevMonth),
      ]);
      return { current, previous, loaded: true };
    }

    setTermPayrollByHotel(prev => Object.fromEntries(PAYROLL_RECON_HOTELS.map(h => [h, { ...prev[h], loaded: false }])) as Record<PayrollReconHotel, TermPayrollState>);
    Promise.all(PAYROLL_RECON_HOTELS.map(load)).then(results => {
      setTermPayrollByHotel(Object.fromEntries(PAYROLL_RECON_HOTELS.map((h, i) => [h, results[i]])) as Record<PayrollReconHotel, TermPayrollState>);
    });
  }, [tab, year, month, hotels]);

  // Load any previously-submitted approvals for the currently selected hotel/period, so
  // ticks survive navigating away and back. Not gated to the Employees tab — the Commit
  // button lives in the header and needs an accurate pending count regardless of which
  // sub-tab is open.
  useEffect(() => {
    if (!hotelId) return;
    const code = hotels.find(h => h.id === hotelId)?.short_code;
    if (code !== 'CSL' && code !== 'NL') return;

    supabase.from('recon_employee_approvals')
      .select('*')
      .eq('hotel_id', hotelId)
      .eq('period_year', year)
      .eq('period_month', month)
      .then(({ data }) => {
        const approvals = (data ?? []) as ReconEmployeeApproval[];
        setEmployeeApprovals(approvals);
        setApprovalTicks(Object.fromEntries(approvals.map(a => [approvalKey(a.category, a.employee_name), a.approved])));
      });
  }, [tab, hotelId, year, month, hotels]);

  // CFE cross-reference: load CSL's and NL's own 5 vendor statement uploads for the
  // SAME period being viewed on the CFEM tab, so CFE-employee lines mixed into those
  // shared statements can be diffed against CFEM's own combined report.
  useEffect(() => {
    const currentHotelCode = hotels.find(h => h.id === hotelId)?.short_code;
    if (tab !== 'deductions' || currentHotelCode !== 'CFEM' || !hotels.length) return;

    async function loadForHotel(shortCode: 'CSL' | 'NL'): Promise<OtherHotelStmts> {
      const h = hotels.find(x => x.short_code === shortCode);
      if (!h) return {};
      const { data: periodRow } = await supabase
        .from('reconciliation_periods')
        .select('id')
        .eq('hotel_id', h.id)
        .eq('period_year', year)
        .eq('period_month', month)
        .maybeSingle();
      if (!periodRow) return {};
      const { data: ups } = await supabase
        .from('recon_uploads')
        .select('upload_type, parsed_data')
        .eq('period_id', periodRow.id)
        .in('upload_type', ['furnmart', 'afritec', 'topline', 'cbstores', 'bodulo']);
      const result: OtherHotelStmts = {};
      (ups ?? []).forEach((u: any) => { result[u.upload_type as CfeVendorType] = u.parsed_data as ParsedStatement; });
      return result;
    }

    setCsnStmtsForCfe(s => ({ ...s, loaded: false }));
    Promise.all([loadForHotel('CSL'), loadForHotel('NL')]).then(([CSL, NL]) => {
      setCsnStmtsForCfe({ CSL, NL, loaded: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, hotelId, year, month, hotels]);

  // Consolidation tab: load each hotel's "system" totals (auto from whatever's already
  // parsed — payroll spreadsheets for CSL/NL, the CFEM Deductions Summary for CFEM) plus
  // any manual bank/system figures already saved for this period, for all 3 hotels at once.
  useEffect(() => {
    if (tab !== 'consolidation' || !hotels.length) return;

    async function loadSystemTotals(shortCode: ConsolidationHotel): Promise<SystemTotals> {
      const h = hotels.find(x => x.short_code === shortCode);
      if (!h) return emptySystemTotals;
      const { data: periodRow } = await supabase
        .from('reconciliation_periods')
        .select('id')
        .eq('hotel_id', h.id)
        .eq('period_year', year)
        .eq('period_month', month)
        .maybeSingle();
      if (!periodRow) return shortCode === 'CFEM' ? { ...emptySystemTotals, basic_salary: null } : emptySystemTotals;

      const { data: ups } = await supabase
        .from('recon_uploads')
        .select('upload_type, parsed_data')
        .eq('period_id', periodRow.id);
      const byType = new Map((ups ?? []).map((u: any) => [u.upload_type, u.parsed_data]));

      const get = (t: string) => (byType.get(t) as ParsedStatement | undefined)?.total ?? 0;

      if (shortCode === 'CFEM') {
        const cfem = byType.get('cfem_deductions') as ParsedCfemDeductions | undefined;
        const totals: SystemTotals = { ...emptySystemTotals, basic_salary: null };
        cfem?.sections.forEach(sec => {
          const t = lookupCfemVendorType(sec.vendor);
          if (t) totals[t] = sec.total;
        });
        // Pension isn't part of the combined CFEM Deductions Summary — it's its own upload.
        totals.pension = get('pension');
        return totals;
      }

      const payroll = byType.get('payroll') as ParsedPayroll | undefined;
      const ftc = byType.get('ftc_payroll') as ParsedPayroll | undefined;
      const basicSalary = (payroll?.lines.reduce((s, l) => s + l.basic, 0) ?? 0)
                         + (ftc?.lines.reduce((s, l) => s + l.basic, 0) ?? 0);
      return {
        basic_salary: basicSalary,
        furnmart: get('furnmart'), afritec: get('afritec'), topline: get('topline'),
        cbstores: get('cbstores'), bodulo: get('bodulo'), pension: get('pension'),
      };
    }

    async function loadEntries(): Promise<ReconConsolidationEntry[]> {
      const { data } = await supabase
        .from('recon_consolidation')
        .select('*')
        .eq('period_year', year)
        .eq('period_month', month);
      return (data ?? []) as ReconConsolidationEntry[];
    }

    setConsolidationSystem(s => ({ ...s, loaded: false }));
    Promise.all([loadSystemTotals('CSL'), loadSystemTotals('NL'), loadSystemTotals('CFEM'), loadEntries()]).then(
      ([CSL, NL, CFEM, entries]) => {
        setConsolidationSystem({ CSL, NL, CFEM, loaded: true });
        setConsolidationEntries(entries);
      }
    );
  }, [tab, year, month, hotels]);

  async function saveConsolidationEntry(
    hotelCode: ConsolidationHotel,
    lineItem: LineItem,
    field: 'system_amount' | 'bank_amount',
    value: number | null,
  ) {
    const existing = consolidationEntries.find(e => e.hotel_short_code === hotelCode && e.line_item === lineItem);
    const payload = {
      period_year: year,
      period_month: month,
      hotel_short_code: hotelCode,
      line_item: lineItem,
      system_amount: field === 'system_amount' ? value : existing?.system_amount ?? null,
      bank_amount: field === 'bank_amount' ? value : existing?.bank_amount ?? null,
      updated_at: new Date().toISOString(),
      updated_by: username,
    };
    const { data } = await supabase
      .from('recon_consolidation')
      .upsert(payload, { onConflict: 'period_year,period_month,hotel_short_code,line_item' })
      .select()
      .single();
    if (data) {
      setConsolidationEntries(prev => [
        ...prev.filter(e => !(e.hotel_short_code === hotelCode && e.line_item === lineItem)),
        data as ReconConsolidationEntry,
      ]);
    }
  }

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
    } else {
      setUploads([]);
    }
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

  async function handleUpload(type: ReconUploadType, file: File) {
    setUploading(type);
    try {
      const buf = await file.arrayBuffer();

      // CFEM Deductions Summary — plain text/CSV, multi-vendor sections, own shape
      if (type === 'cfem_deductions') {
        const text = new TextDecoder().decode(buf);
        const parsedCfem = parseCfemDeductions(text, file.name);
        const pid = await ensurePeriod();
        const rowCount = parsedCfem.sections.reduce((s, sec) => s + sec.lines.length, 0);
        const totalAmount = parsedCfem.sections.reduce((s, sec) => s + sec.total, 0);
        const { error } = await supabase.from('recon_uploads').upsert(
          { period_id: pid, upload_type: type, file_name: file.name,
            parsed_data: parsedCfem, row_count: rowCount, total_amount: totalAmount, uploaded_by: username },
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

  // ── Cross-check computation ───────────────────────────────────────────────

  const hotel = hotels.find(h => h.id === hotelId);
  const country = hotel?.country ?? '';
  const isCfem = hotel?.short_code === 'CFEM';

  // CFEM never uploads salaries — its one combined deductions file replaces the
  // 5 individual vendor slots (and the Payroll Spreadsheet, which doesn't apply here).
  const visibleUploadConfigs = UPLOAD_CONFIGS.filter(c =>
    isCfem ? CFEM_UPLOAD_TYPES.includes(c.type) : NON_CFEM_UPLOAD_TYPES.includes(c.type)
  );

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
    pensionEe:    (payroll?.totals.pensionEe    ?? 0) + (ftcPayroll?.totals.pensionEe    ?? 0),
    staffLoans:   (payroll?.totals.staffLoans   ?? 0) + (ftcPayroll?.totals.staffLoans   ?? 0),
    afritecLoans: (payroll?.totals.afritecLoans ?? 0) + (ftcPayroll?.totals.afritecLoans ?? 0),
    toplineLoans: (payroll?.totals.toplineLoans ?? 0) + (ftcPayroll?.totals.toplineLoans ?? 0),
  };

  function getStmt(type: ReconUploadType): ParsedStatement | undefined {
    return uploads.find(u => u.upload_type === type)?.parsed_data as ParsedStatement | undefined;
  }

  // CFEM: derive the same 5 vendor ParsedStatement shapes from its one combined
  // upload instead of 5 separate ones, so all the existing statement-vs-payroll
  // rendering below works unchanged (payroll side just stays empty/null for CFEM).
  const cfemDeductionsUpload = uploads.find(u => u.upload_type === 'cfem_deductions');
  const cfemParsed = cfemDeductionsUpload?.parsed_data as ParsedCfemDeductions | undefined;
  const cfemStatements: Partial<Record<'furnmart' | 'afritec' | 'topline' | 'cbstores' | 'bodulo', ParsedStatement>> = {};
  if (cfemParsed) {
    for (const section of cfemParsed.sections) {
      const vendorType = lookupCfemVendorType(section.vendor);
      if (!vendorType) continue; // e.g. "Taku" — no equivalent slot yet
      cfemStatements[vendorType] = {
        uploadType: vendorType,
        lines: section.lines.map(l => ({ empCode: l.empCode, name: l.name, amount: l.empAmount })),
        unmatchedLines: [],
        total: section.total,
        fileName: cfemDeductionsUpload!.file_name ?? 'CFEM Deductions Summary',
      };
    }
  }

  const furnmartStmt = isCfem ? cfemStatements.furnmart : getStmt('furnmart');
  const afritecStmt  = isCfem ? cfemStatements.afritec  : getStmt('afritec');
  const toplineStmt  = isCfem ? cfemStatements.topline  : getStmt('topline');
  const cbStmt       = isCfem ? cfemStatements.cbstores : getStmt('cbstores');
  const boduloStmt   = isCfem ? cfemStatements.bodulo   : getStmt('bodulo');
  // Pension is uploaded directly for every hotel including CFEM (unlike the 5 vendors
  // above, it's never mixed into CSL's/NL's shared statements), so no CFEM ternary needed.
  const pensionStmt  = getStmt('pension');

  // Determine if payroll has separate columns per lender (vs one combined staffLoans)
  const payrollHasSeparateLoanCols = mergedTotals.afritecLoans > 0 || mergedTotals.toplineLoans > 0;
  const loanStmtTotal = (afritecStmt?.total ?? 0) + (toplineStmt?.total ?? 0);
  const bothLenders = !!afritecStmt && !!toplineStmt;

  // Summary rows for the deductions tab
  // pay/diff are null when payroll has no comparable column (statement shown for reference only).
  // CFEM never has payroll data at all — its rows always show stmt-only (pay/diff null).
  type SummaryRow = { label: string; stmt: number; pay: number | null; diff: number | null; isCombined?: boolean; isMgmt?: boolean };
  const summaryRows: SummaryRow[] = [];
  if (hasAnyPayroll || isCfem) {
    if (furnmartStmt) summaryRows.push({
      label: 'Furnmart',
      stmt: furnmartStmt.total,
      pay: isCfem ? null : mergedTotals.furnmart,
      diff: isCfem ? null : furnmartStmt.total - mergedTotals.furnmart,
    });

    // Afritec Loans
    if (afritecStmt) {
      const afritecPay = isCfem ? null : payrollHasSeparateLoanCols
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
      pay: isCfem ? null : mergedTotals.cbStores,
      diff: isCfem ? null : cbStmt.total - mergedTotals.cbStores,
    });

    // Topline
    if (toplineStmt) {
      const toplinePay = isCfem ? null : payrollHasSeparateLoanCols
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
    if (bothLenders && !payrollHasSeparateLoanCols && !isCfem) {
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
      pay: isCfem ? null : mergedTotals.bodulo,
      diff: isCfem ? null : boduloStmt.total - mergedTotals.bodulo,
    });

    if (pensionStmt) summaryRows.push({
      label: 'Pension',
      stmt: pensionStmt.total,
      pay: isCfem ? null : mergedTotals.pensionEe,
      diff: isCfem ? null : pensionStmt.total - mergedTotals.pensionEe,
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
    pension_stmt: number | null;  pension_pay: number | null;
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
  const pensionMap = buildEmpMap(pensionStmt?.lines);

  // Code-based allCodes excludes name-matched statements (their keys aren't hotel emp codes)
  const allCodes = new Set<string>([
    ...allPayrollLines.map(l => l.empCode),
    ...(furnmartStmt?.lines ?? []).map(l => l.empCode),
    ...(afritecStmt?.lines ?? []).map(l => l.empCode),
    ...(!toplineStmt?.matchByName ? (toplineStmt?.lines ?? []).map(l => l.empCode) : []),
    ...(!cbStmt?.matchByName      ? (cbStmt?.lines      ?? []).map(l => l.empCode) : []),
    ...(boduloStmt?.lines ?? []).map(l => l.empCode),
    ...(pensionStmt?.lines ?? []).map(l => l.empCode),
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
        pension_stmt: pensionStmt ? (pensionMap.get(code)?.amount ?? null) : null,
        pension_pay: pensionStmt && pay ? pay.pensionEe : null,
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
          pension_stmt: null,  pension_pay: null,
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
          pension_stmt: null,  pension_pay: null,
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
  const resolvedPension   = new Set<string>();

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
  if (pensionStmt) tryResolveByName(pensionStmt.unmatchedLines, resolvedPension,
    (r, l) => { if (r.pension_stmt == null) r.pension_stmt = l.amount; });

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
        pension_stmt: null,  pension_pay: null,
        ...patch(line),
      });
    }
  }

  addNoPayrollRow(furnmartStmt?.unmatchedLines ?? [], resolvedFurnmart, l => ({ furnmart_stmt: l.amount }));
  addNoPayrollRow(afritecStmt?.unmatchedLines ?? [], resolvedAfritec, l => ({ afritec_stmt: l.amount }));
  addNoPayrollRow(cbStmt?.unmatchedLines ?? [], resolvedCb, l => ({ cb_stmt: l.amount }));
  addNoPayrollRow(toplineStmt?.unmatchedLines ?? [], resolvedTopline, l => ({ topline_stmt: l.amount }));
  addNoPayrollRow(boduloStmt?.unmatchedLines ?? [], resolvedBodulo, l => ({ bodulo_stmt: l.amount }));
  addNoPayrollRow(pensionStmt?.unmatchedLines ?? [], resolvedPension, l => ({ pension_stmt: l.amount }));

  // Separate management employees (from MGMT sections) into their own bucket
  const isMgt = (r: EmpRow) => /mgmt|management/i.test(r.section ?? '');

  // Only show rows that have at least one non-zero deduction value for an uploaded statement
  const hasAnyDeduction = (r: EmpRow) =>
    (furnmartStmt != null && ((r.furnmart_stmt ?? 0) > 0 || (r.furnmart_pay ?? 0) > 0)) ||
    (afritecStmt  != null && ((r.afritec_stmt  ?? 0) > 0 || (r.afritec_pay  ?? 0) > 0)) ||
    (toplineStmt  != null && ((r.topline_stmt  ?? 0) > 0 || (r.topline_pay  ?? 0) > 0)) ||
    (cbStmt       != null && ((r.cb_stmt       ?? 0) > 0 || (r.cb_pay       ?? 0) > 0)) ||
    (boduloStmt   != null && ((r.bodulo_stmt   ?? 0) > 0 || (r.bodulo_pay   ?? 0) > 0)) ||
    (pensionStmt  != null && ((r.pension_stmt  ?? 0) > 0 || (r.pension_pay  ?? 0) > 0));

  const staffEmpRows = empRows.filter(r => !isMgt(r) && hasAnyDeduction(r));
  const mgtEmpRows   = empRows.filter(r => isMgt(r)  && hasAnyDeduction(r));

  // Per-vendor management amounts — used to split summary rows into Staff + Mgmt sub-rows
  const mgtVendorTotals = {
    furnmart: mgtEmpRows.reduce((s, r) => s + (r.furnmart_stmt ?? 0), 0),
    afritec:  mgtEmpRows.reduce((s, r) => s + (r.afritec_stmt  ?? 0), 0),
    topline:  mgtEmpRows.reduce((s, r) => s + (r.topline_stmt  ?? 0), 0),
    cb:       mgtEmpRows.reduce((s, r) => s + (r.cb_stmt       ?? 0), 0),
    bodulo:   mgtEmpRows.reduce((s, r) => s + (r.bodulo_stmt   ?? 0), 0),
    pension:  mgtEmpRows.reduce((s, r) => s + (r.pension_stmt  ?? 0), 0),
  };

  // Code index for CFEM's own report lines — used only as a FALLBACK when name resolution
  // fails outright, never to override a name match. CFEM's own report isn't fully self-
  // consistent: one CB Stores line lists "MRS D FRENCH" (Diane) tagged with code "FRE002",
  // which actually belongs to James French in the DB (Diane's real code is "FRE001") —
  // trusting code over name here would misattribute Diane's deduction to James. Name
  // (surname + first-initial, see matchCfeEmployee below) stays authoritative.
  const cfeCodeIndex = new Map<string, Employee>();
  cfeEmployees.forEach(e => { if (e.employee_code) cfeCodeIndex.set(e.employee_code.toUpperCase(), e); });

  // Requires the SURNAME to appear as a token AND the first name's initial to match — not
  // just any single shared token. Pure "any token" matching (an earlier version) produced
  // false positives on real July data: a different CSL employee named "Dorcus" (matched CFE's
  // Dorcus Shamukuni on first name alone) and a different CSL employee surnamed "Nkwazi"
  // (matched CFE's Thomas Nkwazi on surname alone). Surname + initial correctly rejects both
  // while still linking CFEM's initials-only report names ("MR B.A. BAAKILE", initial B) to
  // CSL's full-name statement lines ("BABOLOKI BAAKILE", also initial B).
  function matchCfeEmployee(name: string): Employee | undefined {
    const tokens = nameTokens(name);
    if (!tokens.length) return undefined;
    for (const e of cfeEmployees) {
      const surnameTokens = nameTokens(e.surname);
      if (!surnameTokens.some(st => tokens.includes(st))) continue;
      const firstInitial = nameTokens(e.first_name)[0]?.[0];
      if (!firstInitial || tokens.some(t => t[0] === firstInitial)) return e;
    }
    return undefined;
  }

  // Name first (authoritative — see note above), code only as a fallback if the name
  // doesn't resolve to anyone at all.
  function resolveCfemLine(l: ReconLine): Employee | undefined {
    const byName = matchCfeEmployee(l.name);
    if (byName) return byName;
    return l.empCode ? cfeCodeIndex.get(l.empCode.toUpperCase()) : undefined;
  }

  // Map vendor label → management amount so we can split summary rows
  const VENDOR_MGT: Record<string, number> = {
    'Furnmart':       mgtVendorTotals.furnmart,
    'Afritec Loans':  mgtVendorTotals.afritec,
    'CB Stores':      mgtVendorTotals.cb,
    'Topline':        mgtVendorTotals.topline,
    'Bodulo Funeral': mgtVendorTotals.bodulo,
    'Total Loans':    mgtVendorTotals.afritec + mgtVendorTotals.topline,
    'Pension':        mgtVendorTotals.pension,
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

  // ── CFE cross-reference (CFEM tab only) ──────────────────────────────────
  // Diffs CFEM's own combined deductions report against whatever CFE-employee
  // lines are mixed into CSL's/NL's own shared vendor statements for the same
  // period — the actual "merge the cross reference" ask, not just a viewer.
  const CFEM_VENDOR_LABELS: Record<CfeVendorType, string> = {
    furnmart: 'Furnmart', afritec: 'Afritec', topline: 'Topline', cbstores: 'CB Stores', bodulo: 'Bodulo / Afri Insurance',
  };
  interface CfeCrossCheckRow {
    type: CfeVendorType;
    label: string;
    cfemTotal: number;
    embeddedTotal: number;
    diff: number;
    onlyInCfem: ReconLine[];
    onlyInEmbedded: ReconLine[];
    details: Array<{ name: string; cfemAmount: number | null; embeddedAmount: number | null }>;
  }
  const cfeCrossCheck: CfeCrossCheckRow[] = isCfem ? (Object.keys(CFEM_VENDOR_LABELS) as CfeVendorType[])
    .filter(type => cfemStatements[type] || csnStmtsForCfe.CSL[type] || csnStmtsForCfe.NL[type])
    .map(type => {
      const cfemLines = cfemStatements[type]?.lines ?? [];
      const embeddedLines: ReconLine[] = [];
      (['CSL', 'NL'] as const).forEach(code => {
        const stmt = csnStmtsForCfe[code][type];
        if (!stmt) return;
        [...stmt.lines, ...stmt.unmatchedLines].forEach(l => {
          if (matchCfeEmployee(l.name)) embeddedLines.push(l);
        });
      });
      // Resolve each line to the CFE employee it represents (via the same token-overlap
      // match), so "MR B.A. BAAKILE" (CFEM's own report, initials) and "BABOLOKI BAAKILE"
      // (CSL's statement, full name) are recognised as the same person by identity —
      // comparing raw name strings here would wrongly list him as unmatched on both sides.
      const cfemByEmp = new Map<string, ReconLine>();
      cfemLines.forEach(l => { const emp = resolveCfemLine(l); if (emp) cfemByEmp.set(emp.id, l); });
      const embeddedByEmp = new Map<string, ReconLine>();
      embeddedLines.forEach(l => { const emp = matchCfeEmployee(l.name); if (emp) embeddedByEmp.set(emp.id, l); });

      // Every CFE employee appearing on either side, for a full side-by-side table —
      // not just the mismatches (onlyInCfem/onlyInEmbedded below cover those separately).
      const allEmpIds = new Set([...cfemByEmp.keys(), ...embeddedByEmp.keys()]);
      const details = [...allEmpIds].map(id => {
        const cfeEmp = cfeEmployees.find(e => e.id === id);
        return {
          name: cfeEmp ? `${cfeEmp.surname}, ${cfeEmp.first_name}` : (cfemByEmp.get(id) ?? embeddedByEmp.get(id))!.name,
          cfemAmount: cfemByEmp.get(id)?.amount ?? null,
          embeddedAmount: embeddedByEmp.get(id)?.amount ?? null,
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      return {
        type,
        label: CFEM_VENDOR_LABELS[type],
        cfemTotal: cfemLines.reduce((s, l) => s + l.amount, 0),
        embeddedTotal: embeddedLines.reduce((s, l) => s + l.amount, 0),
        diff: cfemLines.reduce((s, l) => s + l.amount, 0) - embeddedLines.reduce((s, l) => s + l.amount, 0),
        onlyInCfem: [...cfemByEmp.entries()].filter(([id]) => !embeddedByEmp.has(id)).map(([, l]) => l),
        onlyInEmbedded: [...embeddedByEmp.entries()].filter(([id]) => !cfemByEmp.has(id)).map(([, l]) => l),
        details,
      };
    }) : [];

  // ── Employees tab: month-to-month payroll comparison (CSL/NL only) ────────
  // Matched by name, not employee code — a hotel's payroll provider can change code
  // formats between periods (observed for NL: "NL0020"-style in one month, "BAB001"
  // mnemonic-style the next), which would otherwise make every employee look like a
  // termination/new-appointment even though nothing actually changed. Never compared
  // against the DB employee list — see termPayrollByHotel above.
  interface BasicMismatchRow { name: string; empCode: string; prevBasic: number; currBasic: number; diff: number }
  interface RosterChangeRow { name: string; empCode: string; basic: number }

  function buildEmployeesComparison(state: TermPayrollState) {
    const prevByKey = new Map(state.previous.map(l => [nameKey(l.name), l]));
    const currByKey = new Map(state.current.map(l => [nameKey(l.name), l]));

    const basicMismatches: BasicMismatchRow[] = [];
    const newAppointments: RosterChangeRow[] = [];
    for (const l of state.current) {
      const prev = prevByKey.get(nameKey(l.name));
      if (!prev) {
        newAppointments.push({ name: l.name, empCode: l.empCode, basic: l.basic });
      } else if (Math.abs(l.basic - prev.basic) > 0.5) {
        basicMismatches.push({ name: l.name, empCode: l.empCode, prevBasic: prev.basic, currBasic: l.basic, diff: l.basic - prev.basic });
      }
    }
    const terminations: RosterChangeRow[] = state.previous
      .filter(l => !currByKey.has(nameKey(l.name)))
      .map(l => ({ name: l.name, empCode: l.empCode, basic: l.basic }));

    return { basicMismatches, newAppointments, terminations };
  }

  const employeesComparisonByHotel = Object.fromEntries(
    PAYROLL_RECON_HOTELS.map(h => [h, buildEmployeesComparison(termPayrollByHotel[h])])
  ) as Record<PayrollReconHotel, ReturnType<typeof buildEmployeesComparison>>;

  // The Employees tab always reflects whichever hotel is currently selected via the
  // header pill (CSL or NL) — no separate internal sub-tab, so what you see always
  // matches the pill you're on.
  const employeesActiveHotel: PayrollReconHotel = hotel?.short_code === 'NL' ? 'NL' : 'CSL';
  const activeEmployeesComparison = employeesComparisonByHotel[employeesActiveHotel];
  const activeTermPayrollForEmployees = termPayrollByHotel[employeesActiveHotel];

  const employeesTabBadge = employeesComparisonByHotel[employeesActiveHotel];
  const employeesTabBadgeCount = employeesTabBadge.basicMismatches.length + employeesTabBadge.newAppointments.length + employeesTabBadge.terminations.length;

  const tickedApprovalCount = [
    ...activeEmployeesComparison.basicMismatches.map(r => approvalKey('basic_mismatch', r.name)),
    ...activeEmployeesComparison.newAppointments.map(r => approvalKey('new_appointment', r.name)),
    ...activeEmployeesComparison.terminations.map(r => approvalKey('termination', r.name)),
  ].filter(k => approvalTicks[k]).length;

  // Writes the CURRENT tick state for every row currently visible on the Employees tab to
  // recon_employee_approvals (upsert — ticked rows become approved:true, unticked rows
  // become approved:false, so un-ticking something previously submitted also persists).
  // Purely a staging record — nothing here touches the employees table.
  async function submitEmployeeApprovals() {
    if (!hotelId) return;
    setSubmittingApprovals(true);
    try {
      const rows = [
        ...activeEmployeesComparison.basicMismatches.map(r => ({
          category: 'basic_mismatch' as ReconApprovalCategory, name: r.name, code: r.empCode,
          detail: { prevBasic: r.prevBasic, currBasic: r.currBasic, diff: r.diff },
        })),
        ...activeEmployeesComparison.newAppointments.map(r => ({
          category: 'new_appointment' as ReconApprovalCategory, name: r.name, code: r.empCode,
          detail: { basic: r.basic },
        })),
        ...activeEmployeesComparison.terminations.map(r => ({
          category: 'termination' as ReconApprovalCategory, name: r.name, code: r.empCode,
          detail: { basic: r.basic },
        })),
      ];
      const payload = rows.map(r => ({
        hotel_id: hotelId,
        period_year: year,
        period_month: month,
        category: r.category,
        employee_name: r.name,
        employee_code: r.code || null,
        detail: r.detail,
        approved: !!approvalTicks[approvalKey(r.category, r.name)],
        submitted_at: new Date().toISOString(),
        submitted_by: username,
        updated_at: new Date().toISOString(),
      }));
      if (payload.length === 0) return;
      const { data } = await supabase
        .from('recon_employee_approvals')
        .upsert(payload, { onConflict: 'hotel_id,period_year,period_month,category,employee_name' })
        .select();
      if (data) setEmployeeApprovals(data as ReconEmployeeApproval[]);
    } finally {
      setSubmittingApprovals(false);
    }
  }

  // Splits a raw payroll name into { surname, firstName } for a new employees row —
  // inherently a guess (payroll files store names inconsistently: "Title First Last",
  // "Last First", multiple middle names). Convention: strip any salutation, treat the
  // LAST word as surname, everything before it as first name. Shown in the commit
  // confirmation popup so an admin gets one last look before it's actually written.
  function splitNameForNewEmployee(raw: string): { surname: string; firstName: string } {
    const tokens = nameTokens(raw);
    const toTitle = (s: string) => s.split(' ').filter(Boolean).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
    if (tokens.length === 0) return { surname: raw.trim() || 'Unknown', firstName: '' };
    if (tokens.length === 1) return { surname: toTitle(tokens[0]), firstName: '' };
    return { surname: toTitle(tokens[tokens.length - 1]), firstName: toTitle(tokens.slice(0, -1).join(' ')) };
  }

  const pendingCommitApprovals = employeeApprovals.filter(a => a.approved && !a.committed_at);

  // Admin-only. Resolves each approved row to an existing employee (code first, then name)
  // and writes directly to employees/salary_records — no re-flagging, per instruction this
  // is a straight update/override. Only ever touches CSL/NL, matching this tab's scope.
  async function commitEmployeeApprovals() {
    if (userRole !== 'admin' || !hotelId || pendingCommitApprovals.length === 0) return;
    setCommittingApprovals(true);
    try {
      const { data: existingEmps } = await supabase.from('employees').select('*').eq('hotel_id', hotelId);
      const empList = (existingEmps ?? []) as Employee[];
      const codeMap = new Map(empList.filter(e => e.employee_code).map(e => [e.employee_code!.toUpperCase(), e]));
      const nameMap = new Map(empList.map(e => [nameKey(`${e.surname} ${e.first_name}`), e]));
      function resolve(a: ReconEmployeeApproval): Employee | undefined {
        if (a.employee_code) {
          const byCode = codeMap.get(a.employee_code.toUpperCase());
          if (byCode) return byCode;
        }
        return nameMap.get(nameKey(a.employee_name));
      }

      const nowIso = new Date().toISOString();
      for (const a of pendingCommitApprovals) {
        if (a.category === 'termination') {
          const emp = resolve(a);
          if (emp) {
            await supabase.from('employees').update({ status: 'terminated', updated_at: nowIso }).eq('id', emp.id);
          }
        } else if (a.category === 'basic_mismatch') {
          const emp = resolve(a);
          const newBasic = a.detail?.currBasic;
          if (emp && newBasic != null) {
            await supabase.from('salary_records').upsert(
              { employee_id: emp.id, period_year: a.period_year, period_month: a.period_month, basic_salary: newBasic },
              { onConflict: 'employee_id,period_year,period_month' },
            );
          }
        } else if (a.category === 'new_appointment') {
          const existing = resolve(a);
          if (!existing) {
            const { surname, firstName } = splitNameForNewEmployee(a.employee_name);
            const { data: newEmp } = await supabase.from('employees').insert({
              hotel_id: hotelId,
              employee_code: a.employee_code || null,
              surname,
              first_name: firstName,
              status: 'active',
            }).select().single();
            const empId = (newEmp as any)?.id;
            if (empId && a.detail?.basic != null) {
              await supabase.from('salary_records').insert({
                employee_id: empId,
                period_year: a.period_year,
                period_month: a.period_month,
                basic_salary: a.detail.basic,
                allowances: {},
                total_earnings: a.detail.basic,
                tax_paye: 0, uif_employee: 0, medical_employee: 0, ancilla_employee: 0, provident_employee: 0, total_deductions: 0,
                uif_company: 0, medical_company: 0, provident_company: 0, sdl_company: 0, ancilla_company: 0, total_company_contrib: 0,
                total_payroll_burden: 0, total_cost: a.detail.basic,
                net_salary: a.detail.basic, ctc: a.detail.basic,
              });
            }
          }
        }
        await supabase.from('recon_employee_approvals').update({ committed_at: nowIso, committed_by: username }).eq('id', a.id);
      }

      const { data: refreshed } = await supabase
        .from('recon_employee_approvals').select('*')
        .eq('hotel_id', hotelId).eq('period_year', year).eq('period_month', month);
      setEmployeeApprovals((refreshed ?? []) as ReconEmployeeApproval[]);
      setShowCommitConfirm(false);
    } finally {
      setCommittingApprovals(false);
    }
  }

  // ── Consolidation (director bank-release sign-off) ────────────────────────
  function getConsolidationEntry(hotelCode: ConsolidationHotel, lineItem: LineItem) {
    return consolidationEntries.find(e => e.hotel_short_code === hotelCode && e.line_item === lineItem);
  }
  function consolidationIsManualSystem(hotelCode: ConsolidationHotel, lineItem: LineItem): boolean {
    return consolidationSystem[hotelCode][lineItem] == null;
  }
  function consolidationSystemValue(hotelCode: ConsolidationHotel, lineItem: LineItem): number {
    const auto = consolidationSystem[hotelCode][lineItem];
    if (auto != null) return auto;
    return getConsolidationEntry(hotelCode, lineItem)?.system_amount ?? 0;
  }
  function consolidationBankValue(hotelCode: ConsolidationHotel, lineItem: LineItem): number {
    return getConsolidationEntry(hotelCode, lineItem)?.bank_amount ?? 0;
  }

  async function handleExportConsolidation() {
    const rows: Array<Array<string | number | null>> = [];
    for (const h of CONSOLIDATION_HOTELS) {
      const sysByLi = LINE_ITEMS.map(li => consolidationSystemValue(h, li));
      const bankByLi = LINE_ITEMS.map(li => consolidationBankValue(h, li));
      const totalSys = sysByLi.reduce((a, b) => a + b, 0);
      const totalBank = bankByLi.reduce((a, b) => a + b, 0);
      rows.push([h, 'System', ...sysByLi, totalSys]);
      rows.push(['', 'Bank Upload', ...bankByLi, totalBank]);
      rows.push(['', 'Balance Differential', ...sysByLi.map((sys, i) => sys - bankByLi[i]), totalSys - totalBank]);
    }
    const grandSysByLi = LINE_ITEMS.map(li => CONSOLIDATION_HOTELS.reduce((s, h) => s + consolidationSystemValue(h, li), 0));
    const grandBankByLi = LINE_ITEMS.map(li => CONSOLIDATION_HOTELS.reduce((s, h) => s + consolidationBankValue(h, li), 0));
    const grandSys = grandSysByLi.reduce((a, b) => a + b, 0);
    const grandBank = grandBankByLi.reduce((a, b) => a + b, 0);
    rows.push(['Total', 'System', ...grandSysByLi, grandSys]);
    rows.push(['', 'Bank Upload', ...grandBankByLi, grandBank]);
    rows.push(['', 'Balance Differential', ...grandSysByLi.map((sys, i) => sys - grandBankByLi[i]), grandSys - grandBank]);

    const headers = [
      'Hotel', '',
      ...LINE_ITEMS.map(li => LINE_ITEM_LABELS[li]),
      'Total',
    ];
    const sheet: ReportSheet = {
      name: 'Consolidation',
      headers,
      rows,
      isTotalsRow: rows.map(r => r[0] === 'Total'),
    };
    await exportReport('Consolidation', `Consolidation_${MONTH_NAMES[month - 1]}_${year}.xlsx`, [sheet]);
  }

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
          <div className="flex gap-1 flex-wrap items-center">
            {hotels.map(h => (
              <button
                key={h.id}
                onClick={() => { setHotelId(h.id); if (tab === 'consolidation') setTab('upload'); }}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  tab !== 'consolidation' && h.id === hotelId
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {h.short_code}
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-border" />
            <button
              onClick={() => setTab('consolidation')}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                tab === 'consolidation'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              Consolidation
            </button>
            {/* Commit — admin-only, applies only to CSL/NL (the Employees tab's scope).
                Lives here rather than inside the Employees tab content so it's always
                reachable regardless of which sub-tab is open. */}
            {userRole === 'admin' && (hotel?.short_code === 'CSL' || hotel?.short_code === 'NL') && (
              <button
                onClick={() => setShowCommitConfirm(true)}
                disabled={pendingCommitApprovals.length === 0 || committingApprovals}
                className="ml-1 px-3 py-1 rounded text-sm font-medium bg-red-700 text-white hover:bg-red-800 disabled:opacity-50"
              >
                Commit to HR List ({pendingCommitApprovals.length})
              </button>
            )}
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
                disabled={saving || (hotel?.short_code === 'CFEM' ? !cfemDeductionsUpload : !payrollUpload)}
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

      {/* Commit confirmation popup — lives at the top level (not nested in the Employees
          tab) since the Commit button that opens it is now in the header and reachable
          from any sub-tab. Secondary confirm/cancel before anything is written, per
          instruction — shows exactly what will change, including the surname/first-name
          split for new appointments (inherently a guess from a single payroll name
          column) so there's a last visual check before commit. */}
      {showCommitConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-auto p-6">
            <h3 className="text-base font-semibold mb-1">Commit to HR List?</h3>
            <p className="text-sm text-muted-foreground mb-4">
              This writes directly to the employees table for {employeesActiveHotel} — new appointments are
              added, terminations are marked, basic salary changes are applied. This cannot be undone from here.
            </p>
            <div className="border rounded divide-y mb-4">
              {pendingCommitApprovals.map(a => (
                <div key={a.id} className="px-3 py-2 text-sm">
                  {a.category === 'new_appointment' && (() => {
                    const { surname, firstName } = splitNameForNewEmployee(a.employee_name);
                    return <>Add employee: <strong>{firstName} {surname}</strong> (code {a.employee_code || '—'}, basic {fmt(a.detail?.basic ?? 0, country)})</>;
                  })()}
                  {a.category === 'termination' && <>Mark terminated: <strong>{a.employee_name}</strong></>}
                  {a.category === 'basic_mismatch' && <>Update basic salary: <strong>{a.employee_name}</strong> → {fmt(a.detail?.currBasic ?? 0, country)}</>}
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCommitConfirm(false)}
                disabled={committingApprovals}
                className="px-4 py-2 rounded text-sm font-medium border hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={commitEmployeeApprovals}
                disabled={committingApprovals}
                className="px-4 py-2 rounded text-sm font-medium bg-red-700 text-white hover:bg-red-800 disabled:opacity-50"
              >
                {committingApprovals ? 'Committing…' : 'Commit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab nav — hidden while viewing Consolidation, which isn't hotel-scoped ── */}
      {tab !== 'consolidation' && (
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
            {/* Employees only applies to CSL/NL — CFE has no payroll upload to compare month-to-month */}
            {(hotel?.short_code === 'CSL' || hotel?.short_code === 'NL') && (
              <button
                onClick={() => setTab('crossref')}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === 'crossref' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Employees
                {employeesTabBadgeCount > 0 && (
                  <span className="ml-1.5 bg-orange-100 text-orange-700 rounded-full px-1.5 text-xs">
                    {employeesTabBadgeCount}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      )}

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

            {visibleUploadConfigs.map(cfg => {
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
            {!hasAnyPayroll && !isCfem ? (
              <p className="text-muted-foreground text-sm">Upload a payroll spreadsheet first to enable cross-checks.</p>
            ) : !hasAnyPayroll && isCfem && !cfemParsed ? (
              <p className="text-muted-foreground text-sm">Upload the CFEM Deductions Summary first to enable cross-checks.</p>
            ) : (
              <>
                {/* Unmatched entries — truly absent from payroll (not resolved by code or name).
                    Only meaningful for CSL/NL, which have real payroll data to match against —
                    CFEM's own report has no unmatchedLines by construction. */}
                {!isCfem && (() => {
                  const truly = [
                    { stmt: furnmartStmt, label: 'Furnmart', resolved: resolvedFurnmart },
                    { stmt: afritecStmt,  label: 'Afritec',  resolved: resolvedAfritec },
                    { stmt: toplineStmt,  label: 'Topline',  resolved: resolvedTopline },
                    { stmt: cbStmt,       label: 'CB Stores',resolved: resolvedCb },
                    { stmt: boduloStmt,   label: 'Bodulo',   resolved: resolvedBodulo },
                    { stmt: pensionStmt,  label: 'Pension',  resolved: resolvedPension },
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

                {/* Summary cards — CSL/NL only. For CFEM, "Payroll" is meaningless (CFEM never
                    uploads salaries here) — its comparison lives entirely in the CFE
                    Cross-Reference section below, against CSL/NL's own statements. */}
                {!isCfem && summaryRows.length > 0 && (
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

                {!isCfem && summaryRows.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    Upload at least one third-party statement (Furnmart, Afritec, Bodulo, etc.) to see the cross-check.
                  </p>
                )}

                {/* CFEM's primary cross-reference — its own report (the payroll-equivalent
                    source of truth for CFEM) vs the CFE-employee lines embedded in CSL's/NL's
                    own shared vendor statements. This replaces the generic Summary/Employee
                    Detail tables above (hidden for CFEM) since CFEM never has real "Payroll"
                    data in this system — this comparison is the real one. */}
                {isCfem && (
                  <div className="space-y-6">
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                        Summary — CFEM Report vs CSL/NL Statements
                      </h2>
                      <p className="text-xs text-muted-foreground mb-3">
                        CFEM&apos;s deductions are mixed into CSL&apos;s and NL&apos;s shared vendor statements. This compares
                        CFEM&apos;s own report against the CFE-employee lines found in CSL&apos;s and NL&apos;s uploads for
                        {' '}{MONTH_NAMES[month - 1]} {year}.
                      </p>
                      {!csnStmtsForCfe.loaded ? (
                        <p className="text-sm text-muted-foreground">Loading…</p>
                      ) : !cfemParsed ? (
                        <p className="text-sm text-muted-foreground">Upload the CFEM Deductions Summary to see this comparison.</p>
                      ) : cfeCrossCheck.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No matching vendor statements found on CSL/NL for this period yet.
                        </p>
                      ) : (
                        <>
                          <table className="text-sm border rounded overflow-hidden w-full max-w-2xl">
                            <thead>
                              <tr className="bg-[#1B3A5C] text-white">
                                <th className="px-4 py-2 text-left font-semibold">Vendor</th>
                                <th className="px-4 py-2 text-right font-semibold">CFEM Report</th>
                                <th className="px-4 py-2 text-right font-semibold">Found in CSL/NL</th>
                                <th className="px-4 py-2 text-right font-semibold">Difference</th>
                              </tr>
                            </thead>
                            <tbody>
                              {cfeCrossCheck.map((row, i) => (
                                <tr key={row.type} className={i % 2 === 0 ? 'bg-white' : 'bg-muted/20'}>
                                  <td className="px-4 py-2 font-medium">{row.label}</td>
                                  <td className="px-4 py-2 text-right tabular-nums">{fmt(row.cfemTotal, country)}</td>
                                  <td className="px-4 py-2 text-right tabular-nums">{fmt(row.embeddedTotal, country)}</td>
                                  <td className={`px-4 py-2 text-right tabular-nums ${diffClass(row.diff)}`}>{fmtDiff(row.diff, country)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {cfeCrossCheck.some(r => r.onlyInCfem.length > 0 || r.onlyInEmbedded.length > 0) && (
                            <div className="mt-3 space-y-2 max-w-2xl">
                              {cfeCrossCheck.filter(r => r.onlyInCfem.length > 0 || r.onlyInEmbedded.length > 0).map(row => (
                                <div key={row.type} className="rounded border border-amber-200 bg-amber-50 p-3 text-xs">
                                  <p className="font-semibold text-amber-800 mb-1">{row.label} — not matched on both sides</p>
                                  {row.onlyInCfem.length > 0 && (
                                    <p className="text-amber-700">
                                      Only in CFEM report: {row.onlyInCfem.map(l => `${l.name} (${fmt(l.amount, country)})`).join(', ')}
                                    </p>
                                  )}
                                  {row.onlyInEmbedded.length > 0 && (
                                    <p className="text-amber-700">
                                      Only in CSL/NL statements: {row.onlyInEmbedded.map(l => `${l.name} (${fmt(l.amount, country)})`).join(', ')}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    {/* Per-employee detail, one table per vendor — every CFE employee found on
                        either side, not just the mismatches called out above. */}
                    {cfeCrossCheck.filter(r => r.details.length > 0).map(row => (
                      <div key={row.type}>
                        <h3 className="text-sm font-semibold mb-2">{row.label} — Employee Detail</h3>
                        <table className="text-sm border rounded w-full max-w-xl">
                          <thead>
                            <tr className="bg-muted/40">
                              <th className="px-3 py-2 text-left">Name</th>
                              <th className="px-3 py-2 text-right">CFEM Report</th>
                              <th className="px-3 py-2 text-right">CSL/NL Statement</th>
                              <th className="px-3 py-2 text-right">Diff</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.details.map((d, i) => {
                              const diff = d.cfemAmount != null && d.embeddedAmount != null ? d.cfemAmount - d.embeddedAmount : null;
                              return (
                                <tr key={i} className="border-t">
                                  <td className="px-3 py-1.5">{d.name}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">
                                    {d.cfemAmount != null ? fmt(d.cfemAmount, country) : <span className="text-muted-foreground">—</span>}
                                  </td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">
                                    {d.embeddedAmount != null ? fmt(d.embeddedAmount, country) : <span className="text-muted-foreground">—</span>}
                                  </td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${diff != null ? diffClass(diff) : 'text-muted-foreground'}`}>
                                    {diff != null ? fmtDiff(diff, country) : '—'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                )}

                {/* Per-employee table — staff only (CSL/NL — CFEM has its own detail tables above) */}
                {!isCfem && staffEmpRows.length > 0 && summaryRows.length > 0 && (
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
                          pensionStmt  ? { key: 'pension',  label: 'Pension',   active: 'bg-cyan-600 text-white',       inactive: 'bg-cyan-50 text-cyan-700 hover:bg-cyan-100' }    : null,
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
                            {pensionStmt && (dedFilter === 'all' || dedFilter === 'pension') && <>
                              <th className="px-3 py-2 text-right">Pension Stmt</th>
                              <th className="px-3 py-2 text-right">Pension Pay</th>
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
                            if (dedFilter === 'pension')  return (row.pension_stmt  ?? 0) > 0 || (row.pension_pay  ?? 0) > 0;
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
                            const pensionDiff = row.pension_stmt != null && row.pension_pay != null
                              ? row.pension_stmt - row.pension_pay : null;
                            const hasDiscrep =
                              (furnDiff    != null && Math.abs(furnDiff)    > 0.01) ||
                              (afritecDiff != null && Math.abs(afritecDiff) > 0.01) ||
                              (toplineDiff != null && Math.abs(toplineDiff) > 0.01) ||
                              (cbDiff      != null && Math.abs(cbDiff)      > 0.01) ||
                              (bodDiff     != null && Math.abs(bodDiff)     > 0.01) ||
                              (pensionDiff != null && Math.abs(pensionDiff) > 0.01);
                            return (
                              <tr key={`${row.empCode || 'x'}-${row.name}-${i}`} className={`${i % 2 === 0 ? 'bg-white' : 'bg-muted/20'} ${hasDiscrep ? 'ring-1 ring-inset ring-orange-200' : ''}`}>
                                <td className="px-3 py-1.5 font-mono text-xs">
                                  {row.empCode && !row.empCode.includes('|') ? row.empCode : '—'}
                                  {row.empCode && ftcCodes.has(row.empCode) && (
                                    <span className="ml-1.5 font-sans text-xs bg-amber-100 text-amber-700 px-1 py-0.5 rounded">Fixed Term</span>
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
                                {pensionStmt && (dedFilter === 'all' || dedFilter === 'pension') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.pension_stmt, country)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.pension_pay, country)}</td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${pensionDiff != null ? diffClass(pensionDiff) : ''}`}>
                                    {pensionDiff != null ? fmtDiff(pensionDiff, country) : '—'}
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

                {/* Management section — CFE employees from MGMT sections in statements (CSL/NL only) */}
                {!isCfem && mgtEmpRows.length > 0 && (
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
                              {mgtEmpRows.filter(r => matchCfeEmployee(r.name)).length}/{mgtEmpRows.length} matched in CFE records
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
                            {pensionStmt && (dedFilter === 'all' || dedFilter === 'pension') && <>
                              <th className="px-3 py-2 text-right">Pension Stmt</th>
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
                            if (dedFilter === 'pension')  return (row.pension_stmt  ?? 0) > 0;
                            return true;
                          })).map((row, i) => {
                            const cfeMatch = matchCfeEmployee(row.name);
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
                                {pensionStmt && (dedFilter === 'all' || dedFilter === 'pension') && <>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(row.pension_stmt, country)}</td>
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

        {/* ═════ EMPLOYEES TAB — CSL/NL month-to-month payroll comparison ═════ */}
        {tab === 'crossref' && (
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground max-w-3xl">
              Compares this period&apos;s uploaded Payroll Spreadsheet against the <strong>previous period&apos;s</strong> upload
              — never against the HR List (employees table). Matched names with a different Basic Salary show as
              Basic Salary Mismatch; names new this period show as New Appointments; names in last period&apos;s payroll
              but missing this period show as Terminations.
            </p>

            {!activeTermPayrollForEmployees.loaded ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : activeTermPayrollForEmployees.previous.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No payroll uploaded for {employeesActiveHotel}&apos;s previous period — nothing to compare against yet.
              </p>
            ) : (
              <>
                {/* Basic Salary Mismatch */}
                <div>
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Basic Salary Mismatch ({activeEmployeesComparison.basicMismatches.length})
                  </h2>
                  {activeEmployeesComparison.basicMismatches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No basic salary changes from prior month.</p>
                  ) : (
                    <table className="text-sm border rounded w-full max-w-2xl">
                      <thead>
                        <tr className="bg-muted/40">
                          <th className="px-3 py-2 text-center">Approve</th>
                          <th className="px-3 py-2 text-left">Name</th>
                          <th className="px-3 py-2 text-right">Prior Basic</th>
                          <th className="px-3 py-2 text-right">Current Basic</th>
                          <th className="px-3 py-2 text-right">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeEmployeesComparison.basicMismatches.map((r, i) => {
                          const key = approvalKey('basic_mismatch', r.name);
                          return (
                            <tr key={i} className="border-t">
                              <td className="px-3 py-1.5 text-center">
                                <input
                                  type="checkbox"
                                  checked={!!approvalTicks[key]}
                                  onChange={e => setApprovalTicks(prev => ({ ...prev, [key]: e.target.checked }))}
                                />
                              </td>
                              <td className="px-3 py-1.5">{r.name}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.prevBasic, country)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.currBasic, country)}</td>
                              <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${r.diff > 0 ? 'text-green-700' : 'text-red-600'}`}>
                                {r.diff > 0 ? '+' : ''}{fmt(r.diff, country)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* New Appointments */}
                <div>
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    New Appointments ({activeEmployeesComparison.newAppointments.length})
                  </h2>
                  {activeEmployeesComparison.newAppointments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None — headcount unchanged.</p>
                  ) : (
                    <table className="text-sm border rounded w-full max-w-xl">
                      <thead>
                        <tr className="bg-muted/40">
                          <th className="px-3 py-2 text-center">New Appointment</th>
                          <th className="px-3 py-2 text-left">Name</th>
                          <th className="px-3 py-2 text-right">Basic</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeEmployeesComparison.newAppointments.map((r, i) => {
                          const key = approvalKey('new_appointment', r.name);
                          return (
                            <tr key={i} className="border-t">
                              <td className="px-3 py-1.5 text-center">
                                <input
                                  type="checkbox"
                                  checked={!!approvalTicks[key]}
                                  onChange={e => setApprovalTicks(prev => ({ ...prev, [key]: e.target.checked }))}
                                />
                              </td>
                              <td className="px-3 py-1.5">{r.name}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.basic, country)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Terminations */}
                <div>
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Terminations ({activeEmployeesComparison.terminations.length})
                  </h2>
                  {activeEmployeesComparison.terminations.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None — no departures.</p>
                  ) : (
                    <table className="text-sm border rounded w-full max-w-xl">
                      <thead>
                        <tr className="bg-muted/40">
                          <th className="px-3 py-2 text-center">Termination</th>
                          <th className="px-3 py-2 text-left">Name</th>
                          <th className="px-3 py-2 text-right">Prior Basic</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeEmployeesComparison.terminations.map((r, i) => {
                          const key = approvalKey('termination', r.name);
                          return (
                            <tr key={i} className="border-t">
                              <td className="px-3 py-1.5 text-center">
                                <input
                                  type="checkbox"
                                  checked={!!approvalTicks[key]}
                                  onChange={e => setApprovalTicks(prev => ({ ...prev, [key]: e.target.checked }))}
                                />
                              </td>
                              <td className="px-3 py-1.5">{r.name}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.basic, country)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Consolidated submit — persists the current tick state. Purely a staging
                    record; the admin-only Commit button (top of page, next to the hotel
                    pills) is what actually writes to employees/salary_records. */}
                {employeesTabBadgeCount > 0 && (
                  <div className="flex flex-wrap items-center gap-3 pt-2 border-t">
                    <button
                      onClick={submitEmployeeApprovals}
                      disabled={submittingApprovals}
                      className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:opacity-90 disabled:opacity-50"
                    >
                      {submittingApprovals ? 'Submitting…' : `Submit (${tickedApprovalCount} of ${employeesTabBadgeCount} ticked)`}
                    </button>
                    {employeeApprovals.some(a => a.submitted_at) && (
                      <span className="text-xs text-muted-foreground">
                        Last submitted {new Date(
                          employeeApprovals.reduce((latest, a) => a.submitted_at && a.submitted_at > latest ? a.submitted_at : latest, '')
                        ).toLocaleString('en-ZA')}
                        {' '}by {employeeApprovals.find(a => a.submitted_at)?.submitted_by ?? 'unknown'}
                      </span>
                    )}
                    {employeeApprovals.some(a => a.committed_at) && (
                      <span className="text-xs text-green-700">
                        Last committed {new Date(
                          employeeApprovals.reduce((latest, a) => a.committed_at && a.committed_at > latest ? a.committed_at : latest, '')
                        ).toLocaleString('en-ZA')}
                        {' '}by {[...employeeApprovals].reverse().find(a => a.committed_at)?.committed_by ?? 'unknown'}
                      </span>
                    )}
                  </div>
                )}

              </>
            )}
          </div>
        )}

        {/* ═════ CONSOLIDATION TAB — director bank-release sign-off ═════ */}
        {tab === 'consolidation' && (
          <div className="space-y-4 max-w-6xl">
            <div className="flex items-center gap-3 rounded-lg border bg-white px-4 py-3">
              <span className="text-sm font-medium text-muted-foreground">Consolidating for</span>
              <select
                value={month}
                onChange={e => setMonth(Number(e.target.value))}
                className="border rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
              <select
                value={year}
                onChange={e => setYear(Number(e.target.value))}
                className="border rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <button
                onClick={handleExportConsolidation}
                className="ml-auto px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm font-medium hover:opacity-90"
              >
                Export to Excel
              </button>
            </div>

            <p className="text-sm text-muted-foreground">
              System figures are pulled automatically from each hotel&apos;s uploaded payroll / statements / CFEM Deductions
              Summary for this period. Bank figures are entered manually, reflecting what was actually paid to the bank.
              Everything should balance to zero once the bank release is confirmed.
            </p>

            {!consolidationSystem.loaded ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="text-sm border rounded w-full whitespace-nowrap">
                  <thead>
                    <tr className="bg-[#1B3A5C] text-white">
                      <th className="px-3 py-2 text-left">Hotel</th>
                      <th className="px-3 py-2 text-left border-l border-white/20"></th>
                      {LINE_ITEMS.map(li => (
                        <th key={li} className="px-2 py-2 text-right border-l border-white/20">{LINE_ITEM_LABELS[li]}</th>
                      ))}
                      <th className="px-2 py-2 text-right border-l border-white/20">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CONSOLIDATION_HOTELS.map((h, hi) => {
                      const rowBg = hi % 2 === 0 ? 'bg-white' : 'bg-muted/10';
                      let hotelTotalSys = 0, hotelTotalBank = 0;
                      const sysByLi = LINE_ITEMS.map(li => consolidationSystemValue(h, li));
                      const bankByLi = LINE_ITEMS.map(li => consolidationBankValue(h, li));
                      sysByLi.forEach(v => { hotelTotalSys += v; });
                      bankByLi.forEach(v => { hotelTotalBank += v; });
                      return (
                        <Fragment key={h}>
                          <tr className={rowBg}>
                            <td rowSpan={3} className="px-3 py-1.5 font-semibold border-t align-top">{h}</td>
                            <td className="px-3 py-1.5 text-muted-foreground border-t">System</td>
                            {LINE_ITEMS.map((li, i) => {
                              const sys = sysByLi[i];
                              const manual = consolidationIsManualSystem(h, li);
                              return (
                                <td key={li} className="px-2 py-1.5 text-right border-t border-l">
                                  {manual ? (
                                    <input
                                      type="number"
                                      defaultValue={sys || ''}
                                      onBlur={e => saveConsolidationEntry(h, li, 'system_amount', e.target.value === '' ? null : Number(e.target.value))}
                                      className="w-24 text-right border rounded px-1.5 py-0.5 text-xs"
                                    />
                                  ) : (
                                    <span className="tabular-nums">{fmt(sys, country)}</span>
                                  )}
                                </td>
                              );
                            })}
                            <td className="px-2 py-1.5 text-right border-t border-l tabular-nums font-medium">{fmt(hotelTotalSys, country)}</td>
                          </tr>
                          <tr className={rowBg}>
                            <td className="px-3 py-1.5 text-muted-foreground border-t">Bank Upload</td>
                            {LINE_ITEMS.map((li, i) => (
                              <td key={li} className="px-2 py-1.5 text-right border-t border-l">
                                <input
                                  type="number"
                                  defaultValue={bankByLi[i] || ''}
                                  onBlur={e => saveConsolidationEntry(h, li, 'bank_amount', e.target.value === '' ? null : Number(e.target.value))}
                                  className="w-24 text-right border rounded px-1.5 py-0.5 text-xs"
                                />
                              </td>
                            ))}
                            <td className="px-2 py-1.5 text-right border-t border-l tabular-nums font-medium">{fmt(hotelTotalBank, country)}</td>
                          </tr>
                          <tr className={rowBg}>
                            <td className="px-3 py-1.5 text-muted-foreground border-t">Balance Differential</td>
                            {LINE_ITEMS.map((li, i) => {
                              const diff = sysByLi[i] - bankByLi[i];
                              return (
                                <td key={li} className={`px-2 py-1.5 text-right border-t border-l tabular-nums ${diffClass(diff)}`}>
                                  {fmtDiff(diff, country)}
                                </td>
                              );
                            })}
                            <td className={`px-2 py-1.5 text-right border-t border-l tabular-nums font-medium ${diffClass(hotelTotalSys - hotelTotalBank)}`}>
                              {fmtDiff(hotelTotalSys - hotelTotalBank, country)}
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    {(() => {
                      const sysByLi = LINE_ITEMS.map(li => CONSOLIDATION_HOTELS.reduce((s, h) => s + consolidationSystemValue(h, li), 0));
                      const bankByLi = LINE_ITEMS.map(li => CONSOLIDATION_HOTELS.reduce((s, h) => s + consolidationBankValue(h, li), 0));
                      const grandSys = sysByLi.reduce((a, b) => a + b, 0);
                      const grandBank = bankByLi.reduce((a, b) => a + b, 0);
                      return (
                        <>
                          <tr className="bg-muted/40 font-semibold">
                            <td rowSpan={3} className="px-3 py-2 border-t align-top">Total</td>
                            <td className="px-3 py-2 border-t">System</td>
                            {sysByLi.map((sys, i) => (
                              <td key={LINE_ITEMS[i]} className="px-2 py-2 text-right border-t border-l tabular-nums">{fmt(sys, country)}</td>
                            ))}
                            <td className="px-2 py-2 text-right border-t border-l tabular-nums">{fmt(grandSys, country)}</td>
                          </tr>
                          <tr className="bg-muted/40 font-semibold">
                            <td className="px-3 py-2 border-t">Bank Upload</td>
                            {bankByLi.map((bank, i) => (
                              <td key={LINE_ITEMS[i]} className="px-2 py-2 text-right border-t border-l tabular-nums">{fmt(bank, country)}</td>
                            ))}
                            <td className="px-2 py-2 text-right border-t border-l tabular-nums">{fmt(grandBank, country)}</td>
                          </tr>
                          <tr className="bg-muted/40 font-semibold">
                            <td className="px-3 py-2 border-t">Balance Differential</td>
                            {sysByLi.map((sys, i) => {
                              const diff = sys - bankByLi[i];
                              return (
                                <td key={LINE_ITEMS[i]} className={`px-2 py-2 text-right border-t border-l tabular-nums ${diffClass(diff)}`}>
                                  {fmtDiff(diff, country)}
                                </td>
                              );
                            })}
                            <td className={`px-2 py-2 text-right border-t border-l tabular-nums ${diffClass(grandSys - grandBank)}`}>
                              {fmtDiff(grandSys - grandBank, country)}
                            </td>
                          </tr>
                        </>
                      );
                    })()}
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
