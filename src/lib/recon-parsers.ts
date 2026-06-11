// Parsers for payroll reconciliation file uploads.
// All parsers are async and dynamically import xlsx-js-style to avoid SSR issues.

export interface ReconLine {
  empCode: string;
  name: string;
  amount: number;
}

export interface ParsedStatement {
  uploadType: string;
  lines: ReconLine[];
  unmatchedLines: ReconLine[]; // employees with no recognisable code
  total: number;
  fileName: string;
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
  staffLoans: number;
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

async function getXLSX() {
  const mod = await import('xlsx-js-style');
  return (mod as any).default ?? mod;
}

// ── Afritec / Topline .xls loan schedule ─────────────────────────────────────
// Row 0-1: title rows; Row 2: header; Data rows start at row 3.
// Col 5 = Employee Number; Col 10 = Regular Instalment (monthly deduction)
// Totals row: col 5 is empty, col 10 has the total

export async function parseAfritecXls(
  buf: ArrayBuffer,
  fileName: string,
  uploadType = 'afritec',
): Promise<ParsedStatement> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const lines: ReconLine[] = [];
  const unmatchedLines: ReconLine[] = [];
  let stmtTotal = 0;

  // Find header row (contains "Employee Number" or "Surname")
  const headerIdx = rows.findIndex(r =>
    r.some((c: any) => /employee.?number|employee.?no/i.test(String(c || ''))),
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 3;

  // Detect column indices from header
  const hRow = rows[headerIdx >= 0 ? headerIdx : 2] || [];
  const colEmp = hRow.findIndex((c: any) => /employee.?number|employee.?no/i.test(String(c || '')));
  const colAmt = hRow.findIndex((c: any) => /regular.?instal|instalment/i.test(String(c || '')));
  const colSur = hRow.findIndex((c: any) => /surname/i.test(String(c || '')));
  const colFirst = hRow.findIndex((c: any) => /first.?name|forename/i.test(String(c || '')));

  const eCol = colEmp >= 0 ? colEmp : 5;
  const aCol = colAmt >= 0 ? colAmt : 10;
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

    const name = `${String(row[fCol] || '')} ${String(row[sCol] || '')}`.trim();
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

// ── NataLodge payroll spreadsheet .xlsx ───────────────────────────────────────
// Row 0-1: title. Header row detected by col[0]="Code". Employee rows: col[0] non-empty.
// Department subtotal rows: col[0] empty. Final total: col[1]="Total".

export async function parsePayrollXlsx(buf: ArrayBuffer, fileName: string): Promise<ParsedPayroll> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Find header row
  const headerIdx = rows.findIndex(r =>
    String(r[0] || '').trim().toLowerCase() === 'code' &&
    String(r[1] || '').toLowerCase().includes('employee'),
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

  const colBasic       = col('5000');
  const colIncome      = col('income total');
  const colFurnmart    = col('furnmart');
  const colCbStores    = col(/cb.?stores/);
  const colBodulo      = col(/funeral|bodulo/);
  const colPension     = col(/pension.?ee|4010/);
  const colPaye        = col(/paye|8001/);
  const colMedAid      = col(/med.*aid|8090/);
  const colStaffLoans  = col(/staff.?loan|8150/);
  const colDedTotal    = col('deduction total');
  const colNett        = col('nett pay');

  function n(row: any[], c: number): number {
    return c >= 0 ? Number(row[c]) || 0 : 0;
  }

  const lines: PayrollLine[] = [];
  let totals: Partial<PayrollLine> = {};

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const code = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();

    if (!code && name.toLowerCase() === 'total') {
      totals = {
        basic: n(row, colBasic),
        incomeTotal: n(row, colIncome),
        furnmart: n(row, colFurnmart),
        cbStores: n(row, colCbStores),
        bodulo: n(row, colBodulo),
        pensionEe: n(row, colPension),
        paye: n(row, colPaye),
        medAidEe: n(row, colMedAid),
        staffLoans: n(row, colStaffLoans),
        deductionTotal: n(row, colDedTotal),
        nettPay: n(row, colNett),
      };
      continue;
    }

    if (!code) continue; // Department header or blank row

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
      staffLoans: n(row, colStaffLoans),
      deductionTotal: n(row, colDedTotal),
      nettPay: n(row, colNett),
    });
  }

  return { lines, totals, fileName };
}
