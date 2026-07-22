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

// Sorts the words in a name so "BEAUTY LISEHU" and "LISEHU BEAUTY" produce the same key.
// Used for name-based matching where the statement may store names as First Last or Last First.
export function nameKey(raw: string): string {
  return (raw || '').toUpperCase()
    .replace(/[^A-Z\s]/g, '').trim()
    .split(/\s+/).filter(Boolean).sort().join('|');
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
  // Always include management sections — they appear on CSL/NL statements but belong
  // to CFE Management payroll; isMgt() separates them downstream
  if (/mgmt|management/i.test(l)) return true;
  if (hotelCode === 'CSL') return l.startsWith('CSL');
  if (hotelCode === 'NL')  return l.startsWith('NSL') || l.startsWith('NL ');
  if (hotelCode === 'CFE') return l.startsWith('CFE');
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

  // Find header row — matches Afritec/Topline ("Employee Number/No") and
  // CB Stores-style files ("Emp No", "Staff No", "Payroll No")
  const headerIdx = rows.findIndex(r =>
    r.some((c: any) =>
      /employee.?n(?:umber|o\.?)|emp\.?\s*no\.?|staff\.?\s*no\.?|payroll\.?\s*no\.?/i.test(String(c || '')),
    ),
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 3;

  // Detect column indices from header
  const hRow = rows[headerIdx >= 0 ? headerIdx : 2] || [];
  const colEmp = hRow.findIndex((c: any) =>
    /employee.?n(?:umber|o\.?)|emp\.?\s*no\.?|staff\.?\s*no\.?|payroll\.?\s*no\.?/i.test(String(c || '')),
  );
  // Afritec/Topline: "Regular Instalment"; CB Stores: "Amount", "Deduction", "Monthly Amount" etc.
  const colAmt = hRow.findIndex((c: any) =>
    /regular.?instal|instalment|^amount$|^deduction$|^monthly\s+(?:amount|inst)|amount\s+due|^due$/i.test(String(c || '')),
  );
  const colSur = hRow.findIndex((c: any) => /surname/i.test(String(c || '')));
  const colFirst = hRow.findIndex((c: any) => /first.?name|forename/i.test(String(c || '')));
  // CB Stores may use a single "Name" or "Employee Name" column instead of surname + first name
  const colFullName = hRow.findIndex((c: any) => /^(?:full\s*)?name$|^employee\s*name$/i.test(String(c || '')));

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

// ── Furnmart .xlsx multi-SEQ purchase deductions ──────────────────────────────
// Header at the row containing "EMP NO".
// Cols: [1]=EMP NO, [2]=Name, [3]=Surname, [6]=SEQ, [10]=DEDUCTION, [11]=TOTAL
// TOTAL (col 11) is only populated on the LAST contract row per employee.
// For single-contract employees col[11] = col[10].

export async function parseFurnmart(buf: ArrayBuffer, fileName: string): Promise<ParsedStatement> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const headerIdx = rows.findIndex(r =>
    String(r[1] || '').toLowerCase().includes('emp no') ||
    String(r[0] || '').toLowerCase().includes('identity'),
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 8;

  // For each employee: find the row where col[11] (TOTAL) > 0
  const empTotal = new Map<string, { name: string; total: number }>();
  const noCodeTotal = new Map<string, { name: string; total: number }>();

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    const rawCode = String(row[1] || '').trim();
    if (String(row[0] || '').toLowerCase().includes('total')) continue;

    const name = `${String(row[2] || '')} ${String(row[3] || '')}`.trim();
    const total = Number(row[11]) || 0;
    const deduction = Number(row[10]) || 0;

    if (!rawCode) {
      // Employee with no code in Furnmart system
      if (total > 0 && name) noCodeTotal.set(name, { name, total });
      else if (deduction > 0 && name && !noCodeTotal.has(name))
        noCodeTotal.set(name, { name, total: deduction });
      continue;
    }

    if (total > 0) {
      // This is the summary row for this employee (has accumulated TOTAL)
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

  // Statement total from TOTALS row (col 11)
  const totalsRow = rows.find(r => String(r[0] || '').toLowerCase().includes('total'));
  const total = totalsRow ? Number(totalsRow[11]) || 0 : [...lines, ...unmatchedLines].reduce((s, l) => s + l.amount, 0);

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
