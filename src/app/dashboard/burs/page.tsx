'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Employee, Hotel, BursUpload } from '@/types/database';
import { sortHotels, MONTH_NAMES } from '@/lib/utils';
import { parsePayrollXlsx, isIlgAnalysisReportFile, parseIlgAnalysisReport, nameKey, type ParsedPayroll, type PayrollLine } from '@/lib/recon-parsers';
import { Receipt, Upload, Download, AlertTriangle } from 'lucide-react';

// BURS = Botswana Unified Revenue Service. Monthly PAYE submission covering
// every taxed employee across these five properties. ILG submits its own
// payroll spreadsheet. CSL/NL/CFEM/PomPom are submitted together as ONE
// combined ITW8 export, but each has its own separate payroll upload slot —
// a genuinely shared spreadsheet mixing all four hotels' employees was never
// actually how the source payroll files are produced, so this matches reality
// and also lets matching happen against each hotel's own roster only,
// instead of the four-hotel union (fewer chances of a cross-hotel mismatch).
const BURS_HOTEL_CODES = ['ILG', 'CSL', 'NL', 'CFEM', 'PomPom'];
// Order matters here: upload cards render in this sequence, and the combined
// ITW8 export's employee rows are built by iterating this same order — per
// explicit request, CFEM, then CSL, then NL, then PomPom.
const COMBINED_CODES = ['CFEM', 'CSL', 'NL', 'PomPom'];

// burs_uploads.upload_group for a combined-group hotel — lowercased short
// code (migration 032 widened the CHECK constraint to allow these values
// alongside the legacy 'combined' single-file group).
function uploadGroupFor(shortCode: string): string {
  return shortCode.toLowerCase();
}

const EMPLOYER_INFO_KEY = 'ihg-salary-burs-employer-info';

// ITW8 PAYE template — exact column order/labels from itw8_paye_template.csv.
// CONFIRMED TWICE from the BURS portal, and the two downloads disagreed with
// each other (`;` CRLF padded-to-25-everywhere vs `,` LF unpadded) — this is
// the SECOND, freshly re-pulled download, treated as authoritative since it's
// the most recent confirmed source. Row shape is NOT uniform: the metadata
// row (TaxYear/TaxMonth/EmployerTin/EmployerName) and its values row have
// exactly 4 fields each, un-padded — only the column-header row and each
// employee data row are the fixed 25-wide shape. The earlier semicolon
// version force-padded every row (including the 4-field metadata rows) out
// to 25 fields, which was wrong.
const ITW8_HEADER_LABELS = ['TaxYear', 'TaxMonth', 'EmployerTin', 'EmployerName'];
const ITW8_COLUMNS = [
  'ID', 'TIN', 'Name', 'ResidentialStatus', 'ITW5Variation', 'SalaryWages', 'BonusCommission',
  'BenefitsHousing', 'BenefitsMotorCar', 'FurnitureBenefit', 'BenefitsOther', 'SeverancePayGratuity',
  'SeverancePayGratuityPaymentDate', 'RetrenchmentPaymentDate', 'RetrenchmentPackage', 'PensionCashout',
  'PensionTotalFund', 'PensionPaymentDate', 'OtherPayments', 'PaymentsToApprovedFund', 'ExemptionAmount',
  'PayeTaxCalcMethod', 'TaxDeducted', 'EmployedFrom', 'EmployedTo',
];

// Comma-delimited, no padding — each row carries exactly as many fields as
// it naturally has (4 for the metadata rows, 25 for column-header/data rows).
function csvRow(values: string[]): string {
  return values.join(',');
}

// Botswana's PAYE tax year runs July–June, labelled by the calendar year it
// ENDS in — confirmed against a real ILG ITW8 export for June 2026, which
// carries TaxYear 2026 / TaxMonth 12 (June = the 12th month of a July-start
// tax year). Jul–Dec map to months 1–6 of the FOLLOWING calendar year's tax
// year; Jan–Jun map to months 7–12 of the CURRENT calendar year's tax year.
function toBwTaxPeriod(calendarYear: number, calendarMonth: number): { taxYear: number; taxMonth: number } {
  return calendarMonth >= 7
    ? { taxYear: calendarYear + 1, taxMonth: calendarMonth - 6 }
    : { taxYear: calendarYear, taxMonth: calendarMonth + 6 };
}

// dd/mm/yyyy for the first and last calendar day of the selected payroll period —
// confirmed against the same real export, where every employee's EmployedFrom/
// EmployedTo is the period's own bounds (01/06/2026–30/06/2026 for June), not
// each employee's actual hire date.
function periodBounds(calendarYear: number, calendarMonth: number): { from: string; to: string } {
  const first = new Date(calendarYear, calendarMonth - 1, 1);
  const last = new Date(calendarYear, calendarMonth, 0);
  const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  return { from: fmt(first), to: fmt(last) };
}

interface TaxpayerRow {
  line: PayrollLine;
  employee: Employee;
  hotel?: Hotel;
}

// Matches payroll lines to a roster by employee code first (CFEM/PomPom may
// have real codes), falling back to name match (CSL/NL employee codes are
// NULL — migration 014) — same two-pass strategy Reconciliation's Deductions
// Check tab already uses. Only lines with paye > 0 are taxpayers; everything
// else is out of scope for this submission.
function matchTaxpayers(
  parsed: ParsedPayroll | null,
  roster: Employee[],
  hotelForEmployee: (e: Employee) => Hotel | undefined,
): { matched: TaxpayerRow[]; unmatched: PayrollLine[] } {
  if (!parsed) return { matched: [], unmatched: [] };
  const codeMap = new Map(roster.filter(e => e.employee_code).map(e => [e.employee_code!.toUpperCase(), e]));
  const nameMap = new Map(roster.map(e => [nameKey(`${e.surname} ${e.first_name}`), e]));

  const matched: TaxpayerRow[] = [];
  const unmatched: PayrollLine[] = [];
  for (const line of parsed.lines) {
    if (!(line.paye > 0)) continue;
    const code = line.empCode?.trim().toUpperCase();
    const employee = (code ? codeMap.get(code) : undefined) ?? nameMap.get(nameKey(line.name));
    if (employee) {
      matched.push({ line, employee, hotel: hotelForEmployee(employee) });
    } else {
      unmatched.push(line);
    }
  }
  return { matched, unmatched };
}

function buildItw8Csv(rows: TaxpayerRow[], calendarYear: number, calendarMonth: number, tin: string, employerName: string): string {
  const { taxYear, taxMonth } = toBwTaxPeriod(calendarYear, calendarMonth);
  const { from, to } = periodBounds(calendarYear, calendarMonth);
  const lines: string[] = [];
  lines.push(csvRow(ITW8_HEADER_LABELS));
  lines.push(csvRow([String(taxYear), String(taxMonth), tin, employerName]));
  lines.push(csvRow(ITW8_COLUMNS));
  for (const { line, employee } of rows) {
    // OtherPayments = variable pay (overtime, Sunday pay, tips/gratuity, leave
    // paid) = the payroll's Income Total less Basic and any bonus/commission —
    // there's no dedicated variable-pay column upstream, so this is derived.
    const bonusCommission = 0; // no data source yet — see "Fields not yet wired up" below
    const otherPayments = Math.max(0, (line.incomeTotal || 0) - (line.basic || 0) - bonusCommission);
    lines.push(csvRow([
      employee.id_number ?? '',
      '', // TIN — not required (per-employee BURS Taxpayer ID not captured)
      `${employee.first_name} ${employee.surname}`.trim(),
      'R',
      'N',
      String(line.basic || 0),
      String(bonusCommission),
      '0', '0', '0', '0',
      '0', // SeverancePayGratuity — no data source yet (occasional payout, not tracked per period)
      '', // SeverancePayGratuityPaymentDate
      '', // RetrenchmentPaymentDate
      '0', '0', '0',
      '', // PensionPaymentDate
      String(otherPayments),
      String(line.pensionEe || 0),
      '0',
      'ANNUALIZATION',
      String(line.paye || 0),
      from,
      to,
    ]));
  }
  // LF line endings, no trailing newline at EOF — matching the confirmed
  // fresh BURS template exactly (it uses neither CRLF nor a trailing blank
  // line, unlike the earlier semicolon template download).
  return lines.join('\n');
}

function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BursPage() {
  const sb = createClient();
  const ilgFileRef = useRef<HTMLInputElement>(null);
  const combinedFileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);

  const [ilgUploadRow, setIlgUploadRow] = useState<BursUpload | null>(null);
  const [combinedUploadRows, setCombinedUploadRows] = useState<Record<string, BursUpload | null>>({});
  const [uploadingIlg, setUploadingIlg] = useState(false);
  const [uploadingCombined, setUploadingCombined] = useState<Record<string, boolean>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ILG's BW TIN/name confirmed from a real submitted ITW8 export — seeded as
  // the default so it doesn't have to be retyped; localStorage (below) still
  // wins once the user has saved their own value.
  const [employerInfo, setEmployerInfo] = useState<Record<'ilg' | 'combined', { tin: string; name: string }>>({
    ilg: { tin: 'BW00000841555', name: 'Indaba Lodge Gaborone' },
    combined: { tin: '', name: '' },
  });

  useEffect(() => {
    (async () => {
      const { data: h } = await sb.from('hotels').select('*');
      const hotelList = sortHotels((h ?? []) as Hotel[], { includeBursOnly: true })
        .filter(hh => BURS_HOTEL_CODES.includes(hh.short_code));
      setHotels(hotelList);

      const hotelIds = hotelList.map(hh => hh.id);
      const { data: e } = hotelIds.length
        ? await sb.from('employees').select('*').in('hotel_id', hotelIds).eq('status', 'active')
        : { data: [] };
      setEmployees((e ?? []) as Employee[]);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(EMPLOYER_INFO_KEY);
      if (saved) setEmployerInfo(JSON.parse(saved));
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(EMPLOYER_INFO_KEY, JSON.stringify(employerInfo)); } catch {}
  }, [employerInfo]);

  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from('burs_uploads')
        .select('*')
        .eq('period_year', year)
        .eq('period_month', month);
      const rows = (data ?? []) as BursUpload[];
      setIlgUploadRow(rows.find(r => r.upload_group === 'ilg') ?? null);
      const byHotel: Record<string, BursUpload | null> = {};
      for (const code of COMBINED_CODES) {
        byHotel[code] = rows.find(r => r.upload_group === uploadGroupFor(code)) ?? null;
      }
      setCombinedUploadRows(byHotel);
    })();
  }, [year, month]);

  const ilgHotel = hotels.find(h => h.short_code === 'ILG');
  const combinedHotels = hotels.filter(h => COMBINED_CODES.includes(h.short_code));
  const ilgEmployees = useMemo(() => employees.filter(e => e.hotel_id === ilgHotel?.id), [employees, ilgHotel]);
  // Each combined-group hotel matches against its OWN roster only — separate
  // uploads mean there's no ambiguity to resolve across hotels the way a
  // single mixed-roster file would have needed.
  const combinedEmployeesByHotel = useMemo(() => {
    const map: Record<string, Employee[]> = {};
    for (const code of COMBINED_CODES) {
      const hotel = combinedHotels.find(h => h.short_code === code);
      map[code] = hotel ? employees.filter(e => e.hotel_id === hotel.id) : [];
    }
    return map;
  }, [employees, combinedHotels]);

  async function handleUpload(uploadGroup: string, file: File, setUploading: (v: boolean) => void, errorLabel: string, onSuccess: (row: BursUpload) => void) {
    setUploading(true);
    setUploadError(null);
    try {
      // ILG's own payroll export is a plain-text "12 Month Analysis Report"
      // (saved with a .csv extension but not real delimited CSV) — detected
      // by content, not extension, since every other hotel uploads a real
      // tabular spreadsheet handled by parsePayrollXlsx.
      const text = await file.text();
      const parsed = isIlgAnalysisReportFile(text)
        ? parseIlgAnalysisReport(text, file.name)
        : await parsePayrollXlsx(await file.arrayBuffer(), file.name);
      const { data, error } = await sb
        .from('burs_uploads')
        .upsert(
          { period_year: year, period_month: month, upload_group: uploadGroup, file_name: file.name, parsed_data: parsed, uploaded_at: new Date().toISOString() },
          { onConflict: 'period_year,period_month,upload_group' },
        )
        .select()
        .single();
      if (error) throw new Error(error.message);
      onSuccess(data as BursUpload);
    } catch (err) {
      setUploadError(`${errorLabel} upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  }

  function handleIlgUpload(file: File) {
    handleUpload('ilg', file, setUploadingIlg, 'ILG', row => setIlgUploadRow(row));
  }

  function handleCombinedUpload(hotelCode: string, file: File) {
    handleUpload(
      uploadGroupFor(hotelCode),
      file,
      v => setUploadingCombined(prev => ({ ...prev, [hotelCode]: v })),
      hotelCode,
      row => setCombinedUploadRows(prev => ({ ...prev, [hotelCode]: row })),
    );
  }

  const ilgParsed = (ilgUploadRow?.parsed_data as ParsedPayroll | undefined) ?? null;

  const ilgTaxpayers = useMemo(
    () => matchTaxpayers(ilgParsed, ilgEmployees, () => ilgHotel),
    [ilgParsed, ilgEmployees, ilgHotel],
  );

  // One matchTaxpayers() pass per hotel, each against that hotel's own
  // roster only, then combined for the export and the summary table below.
  const combinedTaxpayersByHotel = useMemo(() => {
    const result: Record<string, { matched: TaxpayerRow[]; unmatched: PayrollLine[] }> = {};
    for (const code of COMBINED_CODES) {
      const parsed = (combinedUploadRows[code]?.parsed_data as ParsedPayroll | undefined) ?? null;
      const hotel = combinedHotels.find(h => h.short_code === code);
      result[code] = matchTaxpayers(parsed, combinedEmployeesByHotel[code] ?? [], () => hotel);
    }
    return result;
  }, [combinedUploadRows, combinedEmployeesByHotel, combinedHotels]);

  const combinedMatched = useMemo(
    () => COMBINED_CODES.flatMap(code => combinedTaxpayersByHotel[code]?.matched ?? []),
    [combinedTaxpayersByHotel],
  );
  const combinedUnmatched = useMemo(
    () => COMBINED_CODES.flatMap(code => combinedTaxpayersByHotel[code]?.unmatched ?? []),
    [combinedTaxpayersByHotel],
  );

  const allTaxpayerRows = useMemo(
    () => [...ilgTaxpayers.matched, ...combinedMatched].sort((a, b) => {
      const hc = (a.hotel?.short_code ?? '').localeCompare(b.hotel?.short_code ?? '');
      return hc !== 0 ? hc : a.employee.surname.localeCompare(b.employee.surname);
    }),
    [ilgTaxpayers, combinedMatched],
  );

  const missingOmangAmongTaxpayers = allTaxpayerRows.filter(r => !r.employee.id_number || !r.employee.id_number.trim());

  function updateEmployerInfo(group: 'ilg' | 'combined', field: 'tin' | 'name', value: string) {
    setEmployerInfo(prev => ({ ...prev, [group]: { ...prev[group], [field]: value } }));
  }

  function handleExport(group: 'ilg' | 'combined') {
    const rows = group === 'ilg' ? ilgTaxpayers.matched : combinedMatched;
    const info = employerInfo[group];
    const csv = buildItw8Csv(rows, year, month, info.tin, info.name);
    const label = group === 'ilg' ? 'ILG' : 'Combined';
    downloadCsv(csv, `ITW8_PAYE_${label}_${MONTH_NAMES[month - 1]}_${year}.csv`);
  }

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Receipt className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold text-foreground">BURS — Botswana PAYE Submission</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Monthly ITW8 PAYE submission covering every taxed employee across Indaba Lodge Gaborone, Chobe Safari Lodge, Nata Lodge, CFE Management and Pom Pom.
        </p>
      </div>

      <div className="flex items-end gap-4 mb-6 flex-wrap">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Month</label>
          <select
            value={month}
            onChange={e => setMonth(parseInt(e.target.value))}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
          >
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Year</label>
          <select
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
          >
            {[year, year - 1].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {uploadError && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {uploadError}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 mb-8">
        {/* ILG group */}
        <div className="bg-white rounded-xl border p-5">
          <h2 className="text-sm font-semibold mb-1">ILG — Own Payroll Spreadsheet</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Indaba Lodge Gaborone is submitted on its own payroll file, separate from the other four properties.
          </p>
          <input ref={ilgFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleIlgUpload(f); e.target.value = ''; }} />
          <button
            onClick={() => ilgFileRef.current?.click()}
            disabled={uploadingIlg}
            className="w-full flex items-center justify-center gap-2 rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            {uploadingIlg ? 'Uploading…' : ilgUploadRow ? `Replace (${ilgUploadRow.file_name})` : 'Upload ILG Payroll Spreadsheet'}
          </button>
          {ilgUploadRow && (
            <p className="text-xs text-muted-foreground mt-2">
              {ilgTaxpayers.matched.length} taxpayer{ilgTaxpayers.matched.length === 1 ? '' : 's'} found
              {ilgTaxpayers.unmatched.length > 0 && `, ${ilgTaxpayers.unmatched.length} unmatched`}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 mt-4">
            <input
              type="text" placeholder="EmployerTin"
              value={employerInfo.ilg.tin}
              onChange={e => updateEmployerInfo('ilg', 'tin', e.target.value)}
              className="rounded-md border border-input px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="text" placeholder="EmployerName"
              value={employerInfo.ilg.name}
              onChange={e => updateEmployerInfo('ilg', 'name', e.target.value)}
              className="rounded-md border border-input px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            onClick={() => handleExport('ilg')}
            disabled={ilgTaxpayers.matched.length === 0}
            className="w-full flex items-center justify-center gap-2 mt-3 rounded-md bg-primary text-primary-foreground px-4 py-2 text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Export ITW8 CSV
          </button>
        </div>

        {/* Combined group — one export, but a separate upload per hotel */}
        <div className="bg-white rounded-xl border p-5">
          <h2 className="text-sm font-semibold mb-1">Combined — {COMBINED_CODES.join(' / ')}</h2>
          <p className="text-xs text-muted-foreground mb-4">
            These four properties are submitted together as one ITW8 export, but each has its own payroll upload —
            matched against its own roster. Rows are combined into the export in this order: {COMBINED_CODES.join(', ')}.
          </p>
          <div className="space-y-2.5">
            {COMBINED_CODES.map(code => {
              const uploadRow = combinedUploadRows[code];
              const taxpayers = combinedTaxpayersByHotel[code];
              const isUploading = !!uploadingCombined[code];
              return (
                <div key={code}>
                  <input
                    ref={el => { combinedFileRefs.current[code] = el; }}
                    type="file" accept=".xlsx,.xls,.csv" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleCombinedUpload(code, f); e.target.value = ''; }}
                  />
                  <button
                    onClick={() => combinedFileRefs.current[code]?.click()}
                    disabled={isUploading}
                    className="w-full flex items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {isUploading ? `Uploading ${code}…` : uploadRow ? `${code}: Replace (${uploadRow.file_name})` : `Upload ${code} Payroll Spreadsheet`}
                  </button>
                  {uploadRow && taxpayers && (
                    <p className="text-xs text-muted-foreground mt-1 pl-1">
                      {taxpayers.matched.length} taxpayer{taxpayers.matched.length === 1 ? '' : 's'} found
                      {taxpayers.unmatched.length > 0 && `, ${taxpayers.unmatched.length} unmatched`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-4">
            <input
              type="text" placeholder="EmployerTin"
              value={employerInfo.combined.tin}
              onChange={e => updateEmployerInfo('combined', 'tin', e.target.value)}
              className="rounded-md border border-input px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="text" placeholder="EmployerName"
              value={employerInfo.combined.name}
              onChange={e => updateEmployerInfo('combined', 'name', e.target.value)}
              className="rounded-md border border-input px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            onClick={() => handleExport('combined')}
            disabled={combinedMatched.length === 0}
            className="w-full flex items-center justify-center gap-2 mt-3 rounded-md bg-primary text-primary-foreground px-4 py-2 text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Export ITW8 CSV
          </button>
          <p className="text-[11px] text-muted-foreground mt-2">
            One EmployerTin/EmployerName is shared across all four hotels for now — the export isn't split into
            separate per-hotel submissions yet.
          </p>
        </div>
      </div>

      {(ilgTaxpayers.unmatched.length > 0 || combinedUnmatched.length > 0) && (
        <div className="mb-8 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-center gap-2 font-medium mb-1">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {ilgTaxpayers.unmatched.length + combinedUnmatched.length} payroll line(s) with tax deducted could not be matched to an employee
          </div>
          <ul className="text-xs space-y-0.5 mt-2">
            {[...ilgTaxpayers.unmatched, ...combinedUnmatched].map((l, i) => (
              <li key={i}>{l.name || l.empCode || '(unnamed)'} — tax {l.paye}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden mb-8">
        <div className="px-5 py-3 border-b bg-muted/30 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Taxpayers — {MONTH_NAMES[month - 1]} {year}</h2>
          <span className="text-xs text-muted-foreground">{allTaxpayerRows.length} employee(s) with tax deducted</span>
        </div>
        {allTaxpayerRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No taxpayers yet — upload ILG's and/or the combined-group hotels' payroll spreadsheets for {MONTH_NAMES[month - 1]} {year} above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10">
                <th className="text-left px-5 py-2.5 font-medium text-muted-foreground">Hotel</th>
                <th className="text-left px-5 py-2.5 font-medium text-muted-foreground">Surname</th>
                <th className="text-left px-5 py-2.5 font-medium text-muted-foreground">First Name</th>
                <th className="text-left px-5 py-2.5 font-medium text-muted-foreground">Omang</th>
                <th className="text-right px-5 py-2.5 font-medium text-muted-foreground">Salary/Wages</th>
                <th className="text-right px-5 py-2.5 font-medium text-muted-foreground">Tax Deducted</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {allTaxpayerRows.map(({ line, employee, hotel }, i) => (
                <tr key={`${employee.id}-${i}`}>
                  <td className="px-5 py-2.5 text-muted-foreground">{hotel?.short_code ?? '—'}</td>
                  <td className="px-5 py-2.5 font-medium">{employee.surname}</td>
                  <td className="px-5 py-2.5">{employee.first_name}</td>
                  <td className={`px-5 py-2.5 font-mono text-xs ${employee.id_number ? 'text-muted-foreground' : 'text-red-600 font-medium'}`}>
                    {employee.id_number || 'missing'}
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono text-muted-foreground">{line.basic.toLocaleString('en-ZA')}</td>
                  <td className="px-5 py-2.5 text-right font-mono">{line.paye.toLocaleString('en-ZA')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {missingOmangAmongTaxpayers.length > 0 && (
          <div className="px-5 py-3 border-t bg-red-50 text-xs text-red-700">
            {missingOmangAmongTaxpayers.length} of this month's taxpayers are missing an Omang — fill via Import HR List before exporting.
          </div>
        )}
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        <strong>Fields not yet wired up</strong> — TIN (per-employee BURS Taxpayer ID), BonusCommission, Benefits
        (Housing/MotorCar/Furniture/Other), SeverancePayGratuity, Retrenchment, Pension Cashout, and ExemptionAmount all
        export as blank/0 until those data sources exist. SalaryWages and TaxDeducted come from the uploaded payroll
        spreadsheet's Basic and PAYE columns; PaymentsToApprovedFund comes from its Pension EE column; OtherPayments is
        derived as Income Total − Basic (the variable pay not captured in Basic or Bonus/Commission); TaxYear/TaxMonth
        are converted to Botswana's July–June PAYE tax year, and EmployedFrom/EmployedTo are the selected period's own
        first/last day (not each employee's hire date) — all confirmed against a real submitted ILG export.
      </div>
    </div>
  );
}
