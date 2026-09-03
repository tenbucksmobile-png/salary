'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Employee, Hotel, BursUpload } from '@/types/database';
import { sortHotels, MONTH_NAMES } from '@/lib/utils';
import { parsePayrollXlsx, isIlgAnalysisReportFile, parseIlgAnalysisReport, isIlgPayrollListFile, parseIlgPayrollList, isRprt739File, parseRprt739, nameKey, type ParsedPayroll, type PayrollLine } from '@/lib/recon-parsers';
import { Receipt, Upload, Download, AlertTriangle, Trash2 } from 'lucide-react';

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

// Every monetary ITW8 field, fixed to exactly 2 decimal places — BURS
// rejects values with more (floating-point arithmetic on payroll figures,
// e.g. incomeTotal - basic, routinely produces 12+ decimal digits like
// 1027.0499999999993).
function money(n: number): string {
  return (n || 0).toFixed(2);
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
  employee: Employee | null;
  hotel?: Hotel;
}

// Lines in a parsed payroll that resolve to NO existing employee at all
// (neither by code nor by name) — candidates to create as new employee
// records. Matching (and so this month's ITW8 inclusion) needs a real
// employee row to attach to; a hotel with no roster yet (e.g. Pom Pom) would
// otherwise show every taxpayer as permanently "unmatched".
function findMissingLines(parsed: ParsedPayroll | null, roster: Employee[]): PayrollLine[] {
  if (!parsed) return [];
  const codeSet = new Set(roster.filter(e => e.employee_code).map(e => e.employee_code!.toUpperCase()));
  const nameSet = new Set(roster.map(e => nameKey(`${e.surname} ${e.first_name}`)));
  return parsed.lines.filter(line => {
    const code = line.empCode?.trim().toUpperCase();
    if (code && codeSet.has(code)) return false;
    if (nameSet.has(nameKey(line.name))) return false;
    return true;
  });
}

// Matches payroll lines to a roster by employee code first (CFEM/PomPom may
// have real codes), falling back to name match (CSL/NL employee codes are
// NULL — migration 014) — same two-pass strategy Reconciliation's Deductions
// Check tab already uses.
//
// EVERY line with paye > 0 becomes a row in `matched`, whether or not it
// resolves to an employee — a PAYE deduction on the payroll is money owed to
// BURS regardless of whether our own employee database happens to have a
// matching record, and the ITW8 is extrapolated directly from the uploaded
// payroll spreadsheets, not gated by internal roster completeness. `unmatched`
// is the subset with no employee match — still included in the export (using
// the payroll line's own name/idNumber, employee: null), but called out
// separately since those rows are more likely to need a manual double-check
// (spelling, a genuinely new hire not yet in employees, etc).
function matchTaxpayers(
  parsed: ParsedPayroll | null,
  roster: Employee[],
  hotelForEmployee: () => Hotel | undefined,
): { matched: TaxpayerRow[]; unmatched: TaxpayerRow[] } {
  if (!parsed) return { matched: [], unmatched: [] };
  const codeMap = new Map(roster.filter(e => e.employee_code).map(e => [e.employee_code!.toUpperCase(), e]));
  const nameMap = new Map(roster.map(e => [nameKey(`${e.surname} ${e.first_name}`), e]));

  const matched: TaxpayerRow[] = [];
  const unmatched: TaxpayerRow[] = [];
  for (const line of parsed.lines) {
    if (!(line.paye > 0)) continue;
    const code = line.empCode?.trim().toUpperCase();
    const employee = (code ? codeMap.get(code) : undefined) ?? nameMap.get(nameKey(line.name)) ?? null;
    const row: TaxpayerRow = { line, employee, hotel: hotelForEmployee() };
    matched.push(row);
    if (!employee) unmatched.push(row);
  }
  return { matched, unmatched };
}

// OtherPayments / BonusCommission / SeverancePayGratuity: CSL/NL payroll
// spreadsheets carry the exact named columns for these (1000/1003/1004/
// 5321/5323, 5300, 5771 — see PayrollLine), captured explicitly by
// parsePayrollXlsx. Every other source (ILG's report, Pom Pom, CFEM's
// RPRT739) has no equivalent granular columns, so line.otherPayments/etc
// are undefined there and this falls back to the old Income Total minus
// Basic derivation for OtherPayments, and 0 for the other two. Shared by
// the ITW8 export and the on-screen Taxpayers table so the two never
// disagree on what "Commission"/"Other Income" mean for a given row.
function itw8DerivedFields(line: PayrollLine): { bonusCommission: number; otherPayments: number; severanceNonTaxable: number } {
  const bonusCommission = line.bonusCommission ?? 0;
  const otherPayments = line.otherPayments ?? Math.max(0, (line.incomeTotal || 0) - (line.basic || 0) - bonusCommission);
  const severanceNonTaxable = line.severanceNonTaxable ?? 0;
  return { bonusCommission, otherPayments, severanceNonTaxable };
}

function buildItw8Csv(rows: TaxpayerRow[], calendarYear: number, calendarMonth: number, tin: string, employerName: string): string {
  const { taxYear, taxMonth } = toBwTaxPeriod(calendarYear, calendarMonth);
  const { from, to } = periodBounds(calendarYear, calendarMonth);
  const lines: string[] = [];
  lines.push(csvRow(ITW8_HEADER_LABELS));
  lines.push(csvRow([String(taxYear), String(taxMonth), tin, employerName]));
  lines.push(csvRow(ITW8_COLUMNS));
  for (const { line, employee } of rows) {
    const { bonusCommission, otherPayments, severanceNonTaxable } = itw8DerivedFields(line);
    // A severance payment requires a payment date on the ITW8 — confirmed
    // convention: the 25th of the selected export period's month, not each
    // employee's own pay date (no per-employee severance date exists upstream).
    const severanceDate = severanceNonTaxable > 0
      ? `25/${String(calendarMonth).padStart(2, '0')}/${calendarYear}`
      : '';
    // A PAYE deduction is owed to BURS regardless of whether our own
    // employee database has a matching record — fall back to the payroll
    // line's own name/idNumber when there's no employee to enrich from.
    const idNumber = employee?.id_number || line.idNumber || '';
    const name = employee ? `${employee.first_name} ${employee.surname}`.trim() : line.name;
    lines.push(csvRow([
      idNumber,
      '', // TIN — not required (per-employee BURS Taxpayer ID not captured)
      name,
      'R',
      'N',
      money(line.basic),
      money(bonusCommission),
      '0', '0', '0', '0',
      money(severanceNonTaxable),
      severanceDate,
      '', // RetrenchmentPaymentDate
      '0', '0', '0',
      '', // PensionPaymentDate
      money(otherPayments),
      money(line.pensionEe),
      '0',
      'ANNUALIZATION',
      money(line.paye),
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

      // Deliberately NOT filtered to status='active' — a terminated employee
      // can still have a real payroll line this period (a final payslip),
      // and if their DB record has an Omang on file it should still be used
      // rather than falling back to a blank ID. Confirmed live: Bahenyi
      // Mopako (CSL) has a real Omang stored but is marked terminated, which
      // silently excluded her from matching entirely before this fix.
      const hotelIds = hotelList.map(hh => hh.id);
      const { data: e } = hotelIds.length
        ? await sb.from('employees').select('*').in('hotel_id', hotelIds)
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

  // CFEM's RPRT739 report is deductions-only (PAYE + Pension) — no salary
  // figure at all, since CFEM's payroll is confidential (see Reconciliation).
  // Basic salary is pulled from the employees table instead: match each
  // entry to a CFEM employee (code, then name) and read their LATEST
  // salary_records.basic_salary. incomeTotal is set equal to basic (no
  // variable-pay figure exists in this source), so OtherPayments derives to 0
  // for these rows — accurate given there's nothing to derive it from.
  async function enrichRprt739WithBasicSalary(entries: { empCode: string; name: string; paye: number; pensionEe: number }[], hotelId: string, fileName: string): Promise<ParsedPayroll> {
    const { data: roster } = await sb.from('employees').select('id, employee_code, surname, first_name').eq('hotel_id', hotelId);
    const codeMap = new Map((roster ?? []).filter(e => e.employee_code).map(e => [e.employee_code!.toUpperCase(), e]));
    const nameMap = new Map((roster ?? []).map(e => [nameKey(`${e.surname} ${e.first_name}`), e]));

    const empIds = (roster ?? []).map(e => e.id);
    const { data: sals } = empIds.length
      ? await sb.from('salary_records').select('employee_id, basic_salary, period_year, period_month').in('employee_id', empIds)
      : { data: [] };
    const latestBasic = new Map<string, { basic: number; y: number; m: number }>();
    for (const s of sals ?? []) {
      const cur = latestBasic.get(s.employee_id);
      if (!cur || s.period_year > cur.y || (s.period_year === cur.y && s.period_month > cur.m)) {
        latestBasic.set(s.employee_id, { basic: s.basic_salary ?? 0, y: s.period_year, m: s.period_month });
      }
    }

    const lines: PayrollLine[] = entries.map(e => {
      const code = e.empCode.trim().toUpperCase();
      const match = codeMap.get(code) ?? nameMap.get(nameKey(e.name));
      const basic = match ? (latestBasic.get(match.id)?.basic ?? 0) : 0;
      return {
        empCode: e.empCode,
        name: e.name,
        idNumber: '',
        basic,
        incomeTotal: basic,
        furnmart: 0, cbStores: 0, bodulo: 0,
        pensionEe: e.pensionEe,
        paye: e.paye,
        medAidEe: 0,
        afritecLoans: 0, toplineLoans: 0, staffLoans: 0,
        deductionTotal: e.paye + e.pensionEe,
        nettPay: basic - e.paye - e.pensionEe,
      };
    });
    return { lines, totals: {}, fileName };
  }

  async function handleUpload(uploadGroup: string, file: File, setUploading: (v: boolean) => void, errorLabel: string, onSuccess: (row: BursUpload) => void, hotelId?: string) {
    setUploading(true);
    setUploadError(null);
    try {
      // ILG's own payroll export is either a plain-text "12 Month Analysis
      // Report" or a "LIST OF:"-sectioned Payroll List (Salary/PAYE/Provident
      // — both saved with a .csv extension but not real delimited CSV); CFEM's
      // own payroll system can export the same "LIST OF:"-sectioned Payroll
      // List too (different section-label spellings, handled generically —
      // see parseIlgPayrollList), or its narrower RPRT739 report, which is
      // deductions-only and needs basic salary enriched from the employees
      // table. All detected by content, not extension. Everything else is a
      // real tabular spreadsheet via parsePayrollXlsx.
      const text = await file.text();
      const parsed = isRprt739File(text)
        ? await enrichRprt739WithBasicSalary(parseRprt739(text), hotelId ?? '', file.name)
        : isIlgAnalysisReportFile(text)
        ? parseIlgAnalysisReport(text, file.name)
        : isIlgPayrollListFile(text)
        ? parseIlgPayrollList(text, file.name)
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
    handleUpload('ilg', file, setUploadingIlg, 'ILG', row => setIlgUploadRow(row), ilgHotel?.id);
  }

  function handleCombinedUpload(hotelCode: string, file: File) {
    const hotel = combinedHotels.find(h => h.short_code === hotelCode);
    handleUpload(
      uploadGroupFor(hotelCode),
      file,
      v => setUploadingCombined(prev => ({ ...prev, [hotelCode]: v })),
      hotelCode,
      row => setCombinedUploadRows(prev => ({ ...prev, [hotelCode]: row })),
      hotel?.id,
    );
  }

  async function handleRemoveUpload(uploadGroup: string, errorLabel: string, onSuccess: () => void) {
    if (!confirm(`Remove the uploaded file for ${errorLabel} — ${MONTH_NAMES[month - 1]} ${year}? This can't be undone.`)) return;
    setUploadError(null);
    try {
      const { error } = await sb
        .from('burs_uploads')
        .delete()
        .eq('period_year', year)
        .eq('period_month', month)
        .eq('upload_group', uploadGroup);
      if (error) throw new Error(error.message);
      onSuccess();
    } catch (err) {
      setUploadError(`Removing ${errorLabel}'s upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleRemoveIlgUpload() {
    handleRemoveUpload('ilg', 'ILG', () => setIlgUploadRow(null));
  }

  function handleRemoveCombinedUpload(hotelCode: string) {
    handleRemoveUpload(uploadGroupFor(hotelCode), hotelCode, () => setCombinedUploadRows(prev => ({ ...prev, [hotelCode]: null })));
  }

  const ilgParsed = (ilgUploadRow?.parsed_data as ParsedPayroll | undefined) ?? null;

  const ilgTaxpayers = useMemo(
    () => matchTaxpayers(ilgParsed, ilgEmployees, () => ilgHotel),
    [ilgParsed, ilgEmployees, ilgHotel],
  );

  // One matchTaxpayers() pass per hotel, each against that hotel's own
  // roster only, then combined for the export and the summary table below.
  const combinedTaxpayersByHotel = useMemo(() => {
    const result: Record<string, { matched: TaxpayerRow[]; unmatched: TaxpayerRow[] }> = {};
    for (const code of COMBINED_CODES) {
      const parsed = (combinedUploadRows[code]?.parsed_data as ParsedPayroll | undefined) ?? null;
      const hotel = combinedHotels.find(h => h.short_code === code);
      result[code] = matchTaxpayers(parsed, combinedEmployeesByHotel[code] ?? [], () => hotel);
    }
    return result;
  }, [combinedUploadRows, combinedEmployeesByHotel, combinedHotels]);

  // Lines with no employee at all yet (e.g. Pom Pom, which starts with zero
  // employees) — offered as a one-click bulk-create so this month's taxpayers
  // can actually be matched, without needing the Import HR List page (which
  // deliberately hides BURS-only hotels like Pom Pom from its own picker).
  const combinedMissingByHotel = useMemo(() => {
    const result: Record<string, PayrollLine[]> = {};
    for (const code of COMBINED_CODES) {
      const parsed = (combinedUploadRows[code]?.parsed_data as ParsedPayroll | undefined) ?? null;
      result[code] = findMissingLines(parsed, combinedEmployeesByHotel[code] ?? []);
    }
    return result;
  }, [combinedUploadRows, combinedEmployeesByHotel]);

  const [creatingEmployees, setCreatingEmployees] = useState<Record<string, boolean>>({});

  async function createMissingEmployees(hotelCode: string) {
    const hotel = combinedHotels.find(h => h.short_code === hotelCode);
    const missing = combinedMissingByHotel[hotelCode] ?? [];
    if (!hotel || missing.length === 0) return;
    setCreatingEmployees(prev => ({ ...prev, [hotelCode]: true }));
    setUploadError(null);
    try {
      const rows = missing.map(line => {
        let firstName = line.firstName;
        let surname = line.surname;
        if (firstName === undefined && surname === undefined) {
          // No separately-tracked name columns in the source — best-effort
          // split (first token = first name, rest = surname).
          const tokens = line.name.trim().split(/\s+/);
          firstName = tokens[0] ?? '';
          surname = tokens.slice(1).join(' ') || tokens[0] || '';
        }
        return {
          hotel_id: hotel.id,
          employee_code: line.empCode || null,
          surname: surname || line.name || '(unknown)',
          first_name: firstName || '',
          id_number: line.idNumber || null,
          status: 'active' as const,
        };
      });
      const { error } = await sb.from('employees').insert(rows);
      if (error) throw new Error(error.message);

      const hotelIds = hotels.map(h => h.id);
      const { data: e } = hotelIds.length
        ? await sb.from('employees').select('*').in('hotel_id', hotelIds)
        : { data: [] };
      setEmployees((e ?? []) as Employee[]);
    } catch (err) {
      setUploadError(`Creating employees for ${hotelCode} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreatingEmployees(prev => ({ ...prev, [hotelCode]: false }));
    }
  }

  const combinedMatched = useMemo(
    () => COMBINED_CODES.flatMap(code => combinedTaxpayersByHotel[code]?.matched ?? []),
    [combinedTaxpayersByHotel],
  );
  const combinedUnmatched = useMemo(
    () => COMBINED_CODES.flatMap(code => combinedTaxpayersByHotel[code]?.unmatched ?? []),
    [combinedTaxpayersByHotel],
  );

  // ILG and Combined are shown on separate tabs, not one merged list — a
  // concluded ILG submission was visually mixing in with in-progress
  // Combined-group work in the same table, which was confusing since the two
  // groups export separately anyway.
  const [taxpayerTab, setTaxpayerTab] = useState<'ilg' | 'combined'>('ilg');

  const rowSurname = (r: TaxpayerRow) => r.employee?.surname ?? r.line.name;

  const ilgTaxpayerRows = useMemo(
    () => [...ilgTaxpayers.matched].sort((a, b) => rowSurname(a).localeCompare(rowSurname(b))),
    [ilgTaxpayers],
  );
  const combinedTaxpayerRows = useMemo(
    () => [...combinedMatched].sort((a, b) => {
      const hc = (a.hotel?.short_code ?? '').localeCompare(b.hotel?.short_code ?? '');
      return hc !== 0 ? hc : rowSurname(a).localeCompare(rowSurname(b));
    }),
    [combinedMatched],
  );
  const activeTaxpayerRows = taxpayerTab === 'ilg' ? ilgTaxpayerRows : combinedTaxpayerRows;
  const activeUnmatched = taxpayerTab === 'ilg' ? ilgTaxpayers.unmatched : combinedUnmatched;

  const missingOmangAmongTaxpayers = activeTaxpayerRows.filter(r => !(r.employee?.id_number || r.line.idNumber || '').trim());

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
          <div className="flex gap-2">
            <button
              onClick={() => ilgFileRef.current?.click()}
              disabled={uploadingIlg}
              className="flex-1 flex items-center justify-center gap-2 rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploadingIlg ? 'Uploading…' : ilgUploadRow ? `Replace (${ilgUploadRow.file_name})` : 'Upload ILG Payroll Spreadsheet'}
            </button>
            {ilgUploadRow && (
              <button
                onClick={handleRemoveIlgUpload}
                title="Remove this upload"
                className="shrink-0 flex items-center justify-center rounded-md border border-dashed px-3 text-red-600 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
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
              const missing = combinedMissingByHotel[code] ?? [];
              const isCreating = !!creatingEmployees[code];
              return (
                <div key={code}>
                  <input
                    ref={el => { combinedFileRefs.current[code] = el; }}
                    type="file" accept=".xlsx,.xls,.csv" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleCombinedUpload(code, f); e.target.value = ''; }}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => combinedFileRefs.current[code]?.click()}
                      disabled={isUploading}
                      className="flex-1 flex items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {isUploading ? `Uploading ${code}…` : uploadRow ? `${code}: Replace (${uploadRow.file_name})` : `Upload ${code} Payroll Spreadsheet`}
                    </button>
                    {uploadRow && (
                      <button
                        onClick={() => handleRemoveCombinedUpload(code)}
                        title={`Remove ${code}'s upload`}
                        className="shrink-0 flex items-center justify-center rounded-md border border-dashed px-3 text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {uploadRow && taxpayers && (
                    <p className="text-xs text-muted-foreground mt-1 pl-1">
                      {taxpayers.matched.length} taxpayer{taxpayers.matched.length === 1 ? '' : 's'} found
                      {taxpayers.unmatched.length > 0 && `, ${taxpayers.unmatched.length} unmatched`}
                    </p>
                  )}
                  {missing.length > 0 && (
                    <button
                      onClick={() => createMissingEmployees(code)}
                      disabled={isCreating}
                      className="mt-1 w-full text-left pl-1 text-xs text-amber-700 hover:text-amber-900 underline disabled:opacity-50 transition-colors"
                    >
                      {isCreating ? `Creating…` : `${missing.length} employee${missing.length === 1 ? '' : 's'} not on file for ${code} — already included in the export; create from this upload to add Omang and speed up next month's matching`}
                    </button>
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

      {activeUnmatched.length > 0 && (
        <div className="mb-8 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-center gap-2 font-medium mb-1">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {activeUnmatched.length} payroll line(s) with tax deducted have no matching employee record
          </div>
          <p className="text-xs mb-2">
            Still included in the export below (using the payroll file's own name/ID) — a PAYE deduction is owed to
            BURS regardless of our own roster. Worth a manual check for a spelling mismatch or a genuinely new hire.
          </p>
          <ul className="text-xs space-y-0.5 mt-2">
            {activeUnmatched.map(({ line }, i) => (
              <li key={i}>{line.name || line.empCode || '(unnamed)'} — tax {line.paye}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden mb-8">
        <div className="px-5 border-b bg-muted/30 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setTaxpayerTab('ilg')}
              className={`px-3 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                taxpayerTab === 'ilg' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              ILG ({ilgTaxpayerRows.length})
            </button>
            <button
              onClick={() => setTaxpayerTab('combined')}
              className={`px-3 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                taxpayerTab === 'combined' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              Combined ({combinedTaxpayerRows.length})
            </button>
          </div>
          <span className="text-xs text-muted-foreground">{MONTH_NAMES[month - 1]} {year}</span>
        </div>
        {activeTaxpayerRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {taxpayerTab === 'ilg'
              ? `No ILG taxpayers yet — upload ILG's payroll spreadsheet for ${MONTH_NAMES[month - 1]} ${year} above.`
              : `No combined-group taxpayers yet — upload CFEM/CSL/NL/PomPom's payroll spreadsheets for ${MONTH_NAMES[month - 1]} ${year} above.`}
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
                <th className="text-right px-5 py-2.5 font-medium text-muted-foreground">Pension Contrib</th>
                <th className="text-right px-5 py-2.5 font-medium text-muted-foreground">Commission</th>
                <th className="text-right px-5 py-2.5 font-medium text-muted-foreground">Other Income</th>
                <th className="text-right px-5 py-2.5 font-medium text-muted-foreground">Tax Deducted</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {activeTaxpayerRows.map(({ line, employee, hotel }, i) => {
                const idNumber = employee?.id_number || line.idNumber || '';
                const { bonusCommission, otherPayments } = itw8DerivedFields(line);
                return (
                  <tr key={`${employee?.id ?? line.empCode}-${i}`} className={!employee ? 'bg-amber-50/50' : undefined}>
                    <td className="px-5 py-2.5 text-muted-foreground">{hotel?.short_code ?? '—'}</td>
                    <td className="px-5 py-2.5 font-medium">
                      {employee?.surname ?? <span title="No matching employee record">{line.name || '—'}</span>}
                    </td>
                    <td className="px-5 py-2.5">{employee?.first_name ?? ''}</td>
                    <td className={`px-5 py-2.5 font-mono text-xs ${idNumber ? 'text-muted-foreground' : 'text-red-600 font-medium'}`}>
                      {idNumber || 'missing'}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-muted-foreground">{line.basic.toLocaleString('en-ZA')}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-muted-foreground">{line.pensionEe.toLocaleString('en-ZA')}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-muted-foreground">{bonusCommission ? bonusCommission.toLocaleString('en-ZA') : '—'}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-muted-foreground">{otherPayments ? otherPayments.toLocaleString('en-ZA') : '—'}</td>
                    <td className="px-5 py-2.5 text-right font-mono">{line.paye.toLocaleString('en-ZA')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {missingOmangAmongTaxpayers.length > 0 && (
          <div className="px-5 py-3 border-t bg-red-50 text-xs text-red-700">
            {missingOmangAmongTaxpayers.length} of this month's taxpayers are missing an Omang — still included in the
            export below with a blank ID field; fill it in via Import HR List or the Employees page if BURS requires it.
          </div>
        )}
      </div>
    </div>
  );
}
