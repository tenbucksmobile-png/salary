// Parsers for payroll reconciliation file uploads.
// All parsers are async and dynamically import xlsx-js-style to avoid SSR issues.

export interface ReconLine {
  empCode: string;
  name: string;
  amount: number;
  section?: string; // section label from multi-section files (e.g. "CSL STAFF", "CSL MGMNT")
}

export interface ParsedStatement {
  uploadType: string;
  lines: ReconLine[];
  unmatchedLines: ReconLine[]; // employees with no recognisable code
  total: number;
  fileName: string;
  matchByName?: boolean; // CB Stores / Topline: empCode is a name-sort key, match against payroll by name
}

export interface PayrollLine {
  empCode: string;
  name: string;
  basic: number;
  incomeTotal: number;
  furnmart: number;
  cbStores: number;
  bodulo: number;
  pensionEe: number;
  paye: number;
  medAidEe: number;
  afritecLoans: number;   // Afritec-specific column (0 if not present in payroll)
  toplineLoans: number;   // Topline-specific column (0 if not present in payroll)
  staffLoans: number;     // Combined: afritecLoans + toplineLoans (or single combined col)
  deductionTotal: number;
  nettPay: number;
}

export interface ParsedPayroll {
  lines: PayrollLine[];
  totals: Partial<PayrollLine>;
  fileName: string;
}

function normalizeCode(code: string): string {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

// Salutations that appear in some source files' name fields (e.g. the CSL payroll
// spreadsheet's "Employee Name" column: "MR DENNIS BAANI") but never in the DB's
// surname/first_name fields — left in, these break every single match for that file.
const NAME_TITLES = new Set(['MR', 'MRS', 'MISS', 'MS', 'MSTR', 'DR', 'PROF', 'ADV', 'REV', 'HON', 'MX']);

// Splits a raw name into uppercase word tokens, stripping punctuation and salutations.
// Shared building block for nameKey() (exact full-name matching) and any looser,
// token-overlap matching (e.g. CFE Management identification — see reconciliation page).
export function nameTokens(raw: string): string[] {
  return (raw || '').toUpperCase()
    .replace(/[^A-Z\s]/g, '').trim()
    .split(/\s+/).filter(Boolean)
    .filter(w => !NAME_TITLES.has(w));
}

// Sorts the words in a name so "BEAUTY LISEHU" and "LISEHU BEAUTY" produce the same key.
// Used for name-based matching where the statement may store names as First Last or Last First.
export function nameKey(raw: string): string {
  return nameTokens(raw).sort().join('|');
}

async function getXLSX() {
  const mod = await import('xlsx-js-style');
  return (mod as any).default ?? mod;
}

// ── CB Stores / Topline multi-section format ──────────────────────────────────
// Each file has one or more hotel sections:
//   FROM: <vendor>  /  TO: <HOTEL CODE>  / blank / CUSTOMER NAME | CUST.# | AMOUNT
// Data rows: [name, cust_num, amount]. Section subtotal: ["","",total].
// hotelCode filters which sections to include (CSL → "CSL*", NL → "NSL*", etc.)

function sectionMatchesHotel(label: string, hotelCode: string): boolean {
  if (!hotelCode) return true;
  const l = label.toUpperCase().replace(/\s+/g, ' ');
  // Uppercase defensively — callers pass hotels.short_code, which is DB-stored casing
  // and not guaranteed uppercase everywhere it's read from.
  const code = hotelCode.toUpperCase().trim();
  // Always include management sections — they appear on CSL/NL statements but belong
  // to CFE Management payroll; isMgt() separates them downstream
  if (/mgmt|management/i.test(l)) return true;
  if (code === 'CSL') return l.startsWith('CSL');
  if (code === 'NL')  return l.startsWith('NSL') || l.startsWith('NL ');
  // CFE Management's hotels.short_code is "CFEM", not "CFE" — match both in case a
  // section label itself is ever prefixed with the shorter "CFE" (as CB/Topline's own
  // CFE-labelled sections are), while still accepting the real short_code as input.
  if (code === 'CFEM' || code === 'CFE') return l.startsWith('CFE');
  return true;
}

function parseCbToplineFormat(
  rows: any[][], fileName: string, uploadType: string, hotelCode: string,
): ParsedStatement {
  // empCode = nameKey(name) — CUST.# is ignored; matching is done by name in the page
  const lines: ReconLine[] = [];
  let stmtTotal = 0;
  let i = 0;

  while (i < rows.length) {
    const c0 = String(rows[i][0] || '').trim();

    // Look for "CUSTOMER NAME" header = start of a data section
    if (!/^customer\s*name$/i.test(c0)) { i++; continue; }

    // Back-search up to 5 rows for the "TO: LABEL" row
    let sectionLabel = '';
    for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
      const label = String(rows[k][0] || '').trim();
      if (/^to\s*:/i.test(label)) {
        sectionLabel = label.replace(/^to\s*:\s*/i, '').trim();
        break;
      }
    }
    const include = sectionMatchesHotel(sectionLabel, hotelCode);

    i++; // skip header row, read data rows
    while (i < rows.length) {
      const row = rows[i];
      const c0 = String(row[0] || '').trim();
      const c1 = String(row[1] || '').trim();
      const c2 = Number(row[2]) || 0;

      // Section totals row: empty name + code, positive amount
      if (!c0 && !c1 && c2 > 0) {
        if (include) stmtTotal += c2;
        i++;
        break;
      }
      // Next section boundary
      if (/^from\s*:/i.test(c0)) break;

      if (c0 && c2 > 0 && include) {
        lines.push({
          empCode: nameKey(c0), // sorted word-set key — CUST.# ignored
          name: c0,
          amount: c2,
          section: sectionLabel,
        });
      }
      i++;
    }
  }

  if (!stmtTotal) stmtTotal = lines.reduce((s, l) => s + l.amount, 0);
  return { uploadType, lines, unmatchedLines: [], total: stmtTotal, fileName, matchByName: true };
}

// ── Afritec / Topline .xls loan schedule ─────────────────────────────────────
// Row 0-1: title rows; Row 2: header; Data rows start at row 3.
// Col 5 = Employee Number; Col 10 = Regular Instalment (monthly deduction)
// Totals row: col 5 is empty, col 10 has the total
// hotelCode is forwarded to the CB/Topline multi-section parser when that format is detected.

export async function parseAfritecXls(
  buf: ArrayBuffer,
  fileName: string,
  uploadType = 'afritec',
  hotelCode = '',
): Promise<ParsedStatement> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // CB Stores / Topline multi-section format (CUSTOMER NAME / CUST.# / AMOUNT)
  if (rows.some(r => /^customer\s*name$/i.test(String(r[0] || '').trim()))) {
    return parseCbToplineFormat(rows, fileName, uploadType, hotelCode);
  }

  const lines: ReconLine[] = [];
  const unmatchedLines: ReconLine[] = [];
  let stmtTotal = 0;

  // Find header row — matches Afritec/Topline ("Employee Number/No"), CB Stores-style
  // files ("Emp No", "Staff No", "Payroll No", "Employee #"), and simpler exports that
  // just use a bare "Code" column (e.g. a plain Code/Name/Amount statement with no
  // title rows above it).
  const empColPattern = /employee.?n(?:umber|o\.?)|emp(?:loyee)?\.?\s*(?:no\.?|#)|staff\.?\s*no\.?|payroll\.?\s*no\.?|^\s*code\s*$/i;
  const headerIdx = rows.findIndex(r =>
    r.some((c: any) => empColPattern.test(String(c || ''))),
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 3;

  // Detect column indices from header
  const hRow = rows[headerIdx >= 0 ? headerIdx : 2] || [];
  const colEmp = hRow.findIndex((c: any) => empColPattern.test(String(c || '')));
  // Afritec/Topline: "Regular Instalment"; CB Stores: "Amount", "Deduction", "Monthly Amount"
  // etc.; some life/insurance-style statements use "Premium Due" instead.
  const colAmt = hRow.findIndex((c: any) =>
    /regular.?instal|instalment|^amount$|^deduction$|^monthly\s+(?:amount|inst)|amount\s+due|premium\s+due|^due$/i.test(String(c || '')),
  );
  const colSur = hRow.findIndex((c: any) => /surname/i.test(String(c || '')));
  const colFirstNamed = hRow.findIndex((c: any) => /first.?name|forename/i.test(String(c || '')));
  const colBareName = hRow.findIndex((c: any) => /^(?:full\s*)?name$/i.test(String(c || '').trim()));
  const colCombinedName = hRow.findIndex((c: any) => /^employee\s*name$|^customer\s*name$/i.test(String(c || '').trim()));
  // A bare "Name" header is ambiguous: on CB Stores-style exports it's the ONLY name
  // column (a combined full name), but some statements (e.g. an Afritec life/insurance
  // list) pair a bare "Name" column with a separate "Surname" column, where "Name" means
  // first name only — treating it as a full name there would silently drop the surname.
  // "Employee Name"/"Customer Name" are unambiguous combined-name headers either way.
  const colFullName = colCombinedName >= 0 ? colCombinedName : (colSur < 0 ? colBareName : -1);
  const colFirst = colFirstNamed >= 0 ? colFirstNamed : (colSur >= 0 ? colBareName : -1);

  const eCol = colEmp >= 0 ? colEmp : 5;
  // If amount col not found and file has fewer than 10 cols, scan for last numeric column
  let aCol = colAmt >= 0 ? colAmt : -1;
  if (aCol < 0) {
    // Try col 10 first (Afritec default); if the sheet is shorter, find rightmost numeric col
    const sampleRow = rows[dataStart] || [];
    if (sampleRow.length > 10 && Number(sampleRow[10]) > 0) {
      aCol = 10;
    } else {
      // Walk right-to-left to find a column with numeric values
      for (let c = sampleRow.length - 1; c >= 1; c--) {
        if (Number(sampleRow[c]) > 0) { aCol = c; break; }
      }
      if (aCol < 0) aCol = 10; // last-resort fallback
    }
  }
  const sCol = colSur >= 0 ? colSur : 1;
  const fCol = colFirst >= 0 ? colFirst : 2;

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    const rawCode = String(row[eCol] || '').trim();
    const amount = Number(row[aCol]) || 0;

    // Totals row: no employee code but has amount
    if (!rawCode && amount > 0) {
      stmtTotal = amount;
      continue;
    }
    if (!rawCode || amount <= 0) continue;

    const name = colFullName >= 0
      ? String(row[colFullName] || '').trim()
      : `${String(row[fCol] || '')} ${String(row[sCol] || '')}`.trim();
    const line: ReconLine = { empCode: normalizeCode(rawCode), name, amount };

    // Unmatched = code doesn't look like a hotel employee code (no letters, or just digits)
    if (/^\d+$/.test(rawCode.replace(/\s/g, ''))) {
      unmatchedLines.push(line);
    } else {
      lines.push(line);
    }
  }

  if (!stmtTotal) stmtTotal = [...lines, ...unmatchedLines].reduce((s, l) => s + l.amount, 0);
  return { uploadType, lines, unmatchedLines, total: stmtTotal, fileName };
}

// ── Furnmart .xlsx purchase deductions ─────────────────────────────────────
// Column positions vary across hotel/month exports (a richer multi-SEQ format with
// Contract/Balance/SEQ/TOTAL columns has been seen alongside a much simpler flat
// EMP NO / Name / Surname / Deduction export with one row per employee and no TOTAL
// column at all) — columns are detected from the header row by keyword rather than
// hardcoded positions, with the original multi-SEQ layout's fixed indices (1,2,3,10,11)
// kept as a fallback only for the rare case the header row itself can't be located.
// When a TOTAL column exists, it's only populated on the LAST contract row per
// employee (multi-SEQ accumulation); when there's no TOTAL column, DEDUCTION is the
// final per-employee amount directly (one row per employee, nothing to accumulate).

export async function parseFurnmart(buf: ArrayBuffer, fileName: string): Promise<ParsedStatement> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const headerIdx = rows.findIndex(r =>
    r.some((c: any) => /emp\.?\s*no\.?/i.test(String(c || '').trim())),
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 8;
  const hRow = rows[headerIdx >= 0 ? headerIdx : 0] || [];

  function col(pattern: RegExp): number {
    return hRow.findIndex((c: any) => pattern.test(String(c || '').trim()));
  }
  const colEmpFound = col(/emp\.?\s*no\.?/i);
  const colNameFound = col(/^name$/i);
  const colSurnameFound = col(/surname/i);
  const colDeductionFound = col(/deduction/i);
  const colTotal = col(/^total$/i); // -1 when this format has no separate TOTAL column

  const colEmp = colEmpFound >= 0 ? colEmpFound : 1;
  const colName = colNameFound >= 0 ? colNameFound : 2;
  const colSurname = colSurnameFound >= 0 ? colSurnameFound : 3;
  const colDeduction = colDeductionFound >= 0 ? colDeductionFound : 10;

  // For each employee: find the row where the TOTAL column (if any) > 0
  const empTotal = new Map<string, { name: string; total: number }>();
  const noCodeTotal = new Map<string, { name: string; total: number }>();

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    const rawCode = String(row[colEmp] || '').trim();
    if (String(row[0] || '').toLowerCase().includes('total')) continue;

    const name = `${String(row[colName] ?? '')} ${String(row[colSurname] ?? '')}`.trim();
    const deduction = Number(row[colDeduction]) || 0;
    // No TOTAL column at all → DEDUCTION is already the final per-row amount
    const total = colTotal >= 0 ? Number(row[colTotal]) || 0 : deduction;

    if (!rawCode) {
      // Employee with no code in Furnmart system
      if (total > 0 && name) noCodeTotal.set(name, { name, total });
      else if (deduction > 0 && name && !noCodeTotal.has(name))
        noCodeTotal.set(name, { name, total: deduction });
      continue;
    }

    if (total > 0) {
      // This is the summary row for this employee (has accumulated TOTAL, or —
      // when there's no TOTAL column — is simply that employee's only row)
      empTotal.set(rawCode, { name, total });
    } else if (!empTotal.has(rawCode) && deduction > 0) {
      // Intermediate row — store as fallback if we never see a TOTAL row
      empTotal.set(rawCode, { name, total: deduction });
    }
  }

  const lines: ReconLine[] = Array.from(empTotal.entries()).map(([code, d]) => ({
    empCode: normalizeCode(code),
    name: d.name,
    amount: d.total,
  }));

  const unmatchedLines: ReconLine[] = Array.from(noCodeTotal.values()).map(d => ({
    empCode: '',
    name: d.name,
    amount: d.total,
  }));

  // Statement total from TOTALS row, read from the same TOTAL column (or DEDUCTION
  // when this format has no TOTAL column) used for the per-employee amounts above
  const totalsRow = rows.find(r => String(r[0] || '').toLowerCase().includes('total'));
  const totalsCol = colTotal >= 0 ? colTotal : colDeduction;
  const total = totalsRow ? Number(totalsRow[totalsCol]) || 0 : [...lines, ...unmatchedLines].reduce((s, l) => s + l.amount, 0);

  return { uploadType: 'furnmart', lines, unmatchedLines, total, fileName };
}

// ── Bodulo funeral scheme .xlsx policy list ───────────────────────────────────
// Header at row 0.
// Col 4 = Custom Policy Number (employee code), Col 9 = Premium Due

export async function parseBodulo(buf: ArrayBuffer, fileName: string): Promise<ParsedStatement> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Detect header row
  const headerIdx = rows.findIndex(r =>
    String(r[4] || '').toLowerCase().includes('custom') ||
    String(r[0] || '').toLowerCase() === 'policyid',
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 1;

  const lines: ReconLine[] = [];
  const unmatchedLines: ReconLine[] = [];

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    // Stop when we hit the summary block (no PolicyId, has label text)
    if (!row[0] && String(row[5] || '').length > 0) continue;
    if (!row[0]) continue;

    const rawCode = String(row[4] || '').trim();
    const amount = Number(row[9]) || Number(row[3]) || 0;
    if (!rawCode || amount <= 0) continue;

    const line: ReconLine = { empCode: normalizeCode(rawCode), name: rawCode, amount };
    // Unmatched = codes with spaces or non-standard format that won't match payroll
    lines.push(line);
  }

  // "TOTAL TO PAY" is in col[6] of the summary block at the bottom
  let total = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][5] || '').toLowerCase().includes('total to pay')) {
      total = Number(rows[i][6]) || 0;
      break;
    }
  }
  if (!total) total = lines.reduce((s, l) => s + l.amount, 0);

  return { uploadType: 'bodulo', lines, unmatchedLines, total, fileName };
}

// ── NataLodge / CSL payroll spreadsheet .xlsx ─────────────────────────────────
// Row 0-1: title. Header row detected by col[0]="Code" and "employee" appearing
// anywhere in that row (the employee name column varies by hotel format — e.g.
// NataLodge uses col[1], CSL's "New Employee" export uses col[2] with a
// secondary short-code column at col[1]). Department subtotal rows: col[0]
// empty with no totals in the numeric columns. Final total: col[0] empty with
// non-zero numeric totals (label text varies — not always literally "Total").

export async function parsePayrollXlsx(buf: ArrayBuffer, fileName: string): Promise<ParsedPayroll> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Find header row
  const headerIdx = rows.findIndex(r =>
    String(r[0] || '').trim().toLowerCase() === 'code' &&
    r.some((c: any) => String(c || '').toLowerCase().includes('employee')),
  );
  if (headerIdx < 0) throw new Error('Could not find header row in payroll spreadsheet (expected "Code" in column A)');

  const hRow = rows[headerIdx];

  // Detect columns by header keywords (robust across hotel formats)
  function col(keyword: string | RegExp): number {
    return hRow.findIndex((h: any) => {
      const s = String(h || '').toLowerCase();
      return typeof keyword === 'string' ? s.includes(keyword) : keyword.test(s);
    });
  }

  const colNameFound   = col(/employee.*name|^name$/);
  const colName         = colNameFound >= 0 ? colNameFound : 1;
  const colBasic       = col('5000');
  const colIncome      = col('income total');
  const colFurnmart    = col('furnmart');
  const colCbStores    = col(/cb.?stores/);
  const colBodulo      = col(/funeral|bodulo/);
  const colPension     = col(/pension.?ee|4010/);
  const colPaye        = col(/paye|8001/);
  const colMedAid      = col(/med.*aid|8090/);
  const colAfritec     = col(/afritec|cbh/);
  const colTopline     = col(/topline/);
  const colStaffLoans  = col(/staff.?loan|8150/);
  const colDedTotal    = col('deduction total');
  const colNett        = col('nett pay');
  // True when payroll spreadsheet has separate columns per lender
  const hasSeparateLoanCols = colAfritec >= 0 || colTopline >= 0;
  // When payroll has a Topline column but no dedicated Afritec column,
  // treat the Staff Loans column as the Afritec amount (it was previously combined)
  const afritecFromStaff = colAfritec < 0 && colTopline >= 0 && colStaffLoans >= 0;

  function n(row: any[], c: number): number {
    return c >= 0 ? Number(row[c]) || 0 : 0;
  }

  const lines: PayrollLine[] = [];
  let totals: Partial<PayrollLine> = {};

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const code = String(row[0] || '').trim();
    const name = String(row[colName] || '').trim();

    // Blank-code row: either a department subtotal header (no numeric totals)
    // or the sheet's final totals row (numeric totals present, label text varies).
    if (!code) {
      const isTotalsRow = n(row, colIncome) > 0 || n(row, colDedTotal) > 0 || n(row, colNett) > 0;
      if (!isTotalsRow) continue; // department header or blank row

      const toplineLoans = n(row, colTopline);
      const afritecLoans = colAfritec >= 0 ? n(row, colAfritec)
        : afritecFromStaff ? n(row, colStaffLoans)
        : 0;
      totals = {
        basic: n(row, colBasic),
        incomeTotal: n(row, colIncome),
        furnmart: n(row, colFurnmart),
        cbStores: n(row, colCbStores),
        bodulo: n(row, colBodulo),
        pensionEe: n(row, colPension),
        paye: n(row, colPaye),
        medAidEe: n(row, colMedAid),
        afritecLoans,
        toplineLoans,
        staffLoans: hasSeparateLoanCols
          ? afritecLoans + toplineLoans
          : n(row, colStaffLoans),
        deductionTotal: n(row, colDedTotal),
        nettPay: n(row, colNett),
      };
      continue;
    }

    const toplineLoans = n(row, colTopline);
    const afritecLoans = colAfritec >= 0 ? n(row, colAfritec)
      : afritecFromStaff ? n(row, colStaffLoans)
      : 0;
    lines.push({
      empCode: normalizeCode(code),
      name,
      basic: n(row, colBasic),
      incomeTotal: n(row, colIncome),
      furnmart: n(row, colFurnmart),
      cbStores: n(row, colCbStores),
      bodulo: n(row, colBodulo),
      pensionEe: n(row, colPension),
      paye: n(row, colPaye),
      medAidEe: n(row, colMedAid),
      afritecLoans,
      toplineLoans,
      staffLoans: hasSeparateLoanCols
        ? afritecLoans + toplineLoans
        : n(row, colStaffLoans),
      deductionTotal: n(row, colDedTotal),
      nettPay: n(row, colNett),
    });
  }

  return { lines, totals, fileName };
}

// ── FTC / Casual Pay Register parser ─────────────────────────────────────────
// Handles the bespoke multi-sheet "FIXED SERVICE PAY" xls format.
// Column count and positions vary across sheets (3–14 cols); detection finds
// "NAME"/"FULL NAME" and "TOTAL PAY"/"GROSS SALARY" header cells each time.
// No employee codes — empCode is set to nameKey(name) for name-based matching.

const FTC_MONTH_NAMES = [
  'jan','feb','mar','apr','may','jun',
  'jul','aug','sep','oct','nov','dec',
];

function pickFtcSheet(sheetNames: string[], month: number, year: number): string {
  if (sheetNames.length === 1) return sheetNames[0];
  if (!month || !year) return sheetNames[0];

  const mAbbrev = FTC_MONTH_NAMES[month - 1];
  const yStr = String(year);
  const yShort = yStr.slice(2);

  for (const name of sheetNames) {
    const lower = name.toLowerCase().replace(/\s+/g, '');
    if (lower.includes(mAbbrev) && (lower.includes(yStr) || lower.includes(yShort))) {
      return name;
    }
  }
  return sheetNames[sheetNames.length - 1]; // default to most recent sheet
}

function findFtcHeader(
  rows: any[][],
  startRow: number,
): { found: boolean; nameCol: number; totalCol: number; rowIdx: number } {
  for (let i = startRow; i < Math.min(startRow + 15, rows.length); i++) {
    let nameCol = -1, totalCol = -1;
    rows[i].forEach((cell: any, j: number) => {
      const s = String(cell ?? '').trim().toLowerCase();
      if (/^(full\s+)?name$/.test(s)) nameCol = j;
      if (/total.+pay|gross.+salary/.test(s)) totalCol = j;
    });
    if (nameCol >= 0 && totalCol >= 0) return { found: true, nameCol, totalCol, rowIdx: i };
  }
  return { found: false, nameCol: 0, totalCol: -1, rowIdx: startRow };
}

export async function parseFtcPayrollXls(
  buf: ArrayBuffer,
  fileName: string,
  targetMonth = 0,
  targetYear = 0,
): Promise<ParsedPayroll> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });

  const sheetName = pickFtcSheet(wb.SheetNames, targetMonth, targetYear);
  const ws = wb.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Locate first header row to determine column positions for the whole sheet
  const { found, nameCol, totalCol, rowIdx: headerIdx } = findFtcHeader(rows, 0);
  if (!found) return { lines: [], totals: {}, fileName };

  const lines: PayrollLine[] = [];
  let grandTotal = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const rawName = String(row[nameCol] ?? '').trim();
    if (!rawName) continue;
    if (/^(prepared|checked|authorised|total)/i.test(rawName)) continue;

    const total = Number(row[totalCol]) || 0;
    // Second header rows (when two blocks share a sheet) have a non-numeric total
    if (total <= 0) continue;

    const key = nameKey(rawName);
    const existing = lines.find(l => l.empCode === key);
    if (existing) {
      // Same employee appearing in a second block on the same sheet — sum totals
      existing.basic += total;
      existing.incomeTotal += total;
      existing.nettPay += total;
    } else {
      lines.push({
        empCode: key, // nameKey-format; display as "—" in the UI
        name: rawName,
        basic: total,
        incomeTotal: total,
        furnmart: 0, cbStores: 0, bodulo: 0,
        pensionEe: 0, paye: 0, medAidEe: 0,
        afritecLoans: 0, toplineLoans: 0, staffLoans: 0,
        deductionTotal: 0,
        nettPay: total,
      });
    }
    grandTotal += total;
  }

  return {
    lines,
    totals: { basic: grandTotal, incomeTotal: grandTotal, nettPay: grandTotal },
    fileName,
  };
}

// ── CFEM Deductions Summary (plain-text/CSV export from CFEM's own payroll system) ──
// CFEM Management runs a separate, confidential payroll from CSL/NL — this file is
// CFEM's own pre-split-by-vendor deductions report, replacing the need to extract
// CFEM's employees out of CSL/NL's combined third-party statements (see the
// "CFE Cross-Reference" comparison in reconciliation/page.tsx, which diffs this
// against CFEM lines embedded in CSL/NL's own statement uploads for the period).
//
// Format: repeated sections, each "LIST OF: <Vendor>  METHOD NO: ALL  (Current period)",
// then a header row, then one row per employee ("EMP.CODE  NAME  CO.CONTRIB  EMP.AMOUNT
// TOTAL", optionally suffixed with "NEW  DD/MM/YYYY"), then a dashed divider, a
// "( N Empls)" section-total row, another divider, and a blank line before the next
// section. Columns are whitespace-padded, not delimited — parsed by locating the three
// trailing "X.XX"-shaped numbers on each line (anchoring on number shape rather than
// whitespace-run boundaries, since employee names occasionally contain accidental
// double-spaces that would otherwise be mis-tokenized as column breaks).

export interface CfemDeductionLine {
  empCode: string;
  name: string;
  coContrib: number;
  empAmount: number;
  total: number;
}

export interface CfemDeductionSection {
  vendor: string;
  lines: CfemDeductionLine[];
  total: number;
}

export interface ParsedCfemDeductions {
  sections: CfemDeductionSection[];
  fileName: string;
}

export function parseCfemDeductions(text: string, fileName: string): ParsedCfemDeductions {
  const numRe = /-?\d*\.\d{2}/g;
  const sections: CfemDeductionSection[] = [];
  let current: CfemDeductionSection | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('LIST OF:')) {
      if (current) sections.push(current);
      const rest = trimmed.slice('LIST OF:'.length).trim();
      const vendor = rest.split(/\s{2,}/)[0]?.trim() || 'Unknown';
      current = { vendor, lines: [], total: 0 };
      continue;
    }
    if (!current) continue;

    // Section-total row: "(    7 Empls)     .00   4398.44   4398.44" (count may be blank)
    if (trimmed.startsWith('(') && /empl/i.test(trimmed)) {
      const nums = [...line.matchAll(numRe)];
      current.total = nums.length
        ? parseFloat(nums[nums.length - 1][0])
        : current.lines.reduce((s, l) => s + l.total, 0);
      continue;
    }

    // Data row: needs at least CO.CONTRIB, EMP.AMOUNT, TOTAL — header/divider rows have none
    const nums = [...line.matchAll(numRe)];
    if (nums.length < 3) continue;

    const [n1, n2, n3] = nums;
    const codeMatch = line.match(/^\s*(\S+)/);
    if (!codeMatch) continue;
    // Normalised the same way as every other parser's empCode (trim + uppercase) so
    // downstream case-insensitive code lookups (e.g. cfeCodeIndex) don't need to guess.
    const empCode = normalizeCode(codeMatch[1]);
    const name = line.slice(codeMatch[0].length, n1.index).replace(/\s+/g, ' ').trim();
    current.lines.push({
      empCode,
      name,
      coContrib: parseFloat(n1[0]) || 0,
      empAmount: parseFloat(n2[0]) || 0,
      total: parseFloat(n3[0]) || 0,
    });
  }
  if (current) sections.push(current);

  return { sections, fileName };
}
