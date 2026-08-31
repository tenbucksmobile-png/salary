// Parsers for payroll reconciliation file uploads.
// All parsers are async and dynamically import xlsx-js-style to avoid SSR issues.

export interface ReconLine {
  empCode: string;
  name: string;
  amount: number;
  section?: string; // section label from multi-section files (e.g. "CSL STAFF", "CSL MGMNT")
  // Pension lines only: the combined EE+ER contribution for this one employee (`amount`
  // stays EE-only, same reasoning as ParsedStatement.bankTotal below). Needed so
  // Consolidation can move a CFE Management employee's pension bank total between
  // hotels (see the CSL/NL/CFEM pension note in reconciliation/page.tsx) without
  // access to only an EE-only per-line figure.
  bankAmount?: number;
}

export interface ParsedStatement {
  uploadType: string;
  lines: ReconLine[];
  unmatchedLines: ReconLine[]; // employees with no recognisable code
  total: number;
  fileName: string;
  matchByName?: boolean; // CB Stores / Topline: empCode is a name-sort key, match against payroll by name
  // Pension only: the combined EE+ER contribution total — what actually gets paid to
  // the fund administrator each month. `total` (and every `lines[].amount`) stays the
  // EE-only figure so the Deductions Check statement-vs-payroll comparison keeps
  // comparing like against like (payroll only ever reports the EE deduction); the
  // Consolidation tab's Pension "System" figure reads bankTotal instead, falling back
  // to `total` when a statement has no EE/ER split at all.
  bankTotal?: number;
}

export interface PayrollLine {
  empCode: string;
  name: string;
  firstName?: string;    // set only when the source has separate name columns (avoids a lossy re-split of `name`)
  surname?: string;
  idNumber: string;      // Omang/National ID, when the payroll source carries one (blank otherwise)
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
  // BURS ITW8 fields — explicit sums from named CSL/NL payroll columns, set
  // ONLY by the Code-anchored parsePayrollXlsx shape (confirmed against real
  // CSL/NL files). Left undefined by every other parser (ILG's report,
  // Pom Pom, CFEM's RPRT739), which have no equivalent granular columns —
  // buildItw8Csv() falls back to its incomeTotal-basic derivation for those.
  otherPayments?: number;       // 1000 - Overtime PPHoliday, 1003 - General Staff Tip, 1004 - Notice pay, 5321/5323 - Overtime — NOT 1001 (Maternity Leave-NegativeIncome, confirmed a different item despite the similar numbering)
  bonusCommission?: number;     // 5300 - Commission
  severanceNonTaxable?: number; // 5771 - Severance Pay - Non Taxable Portion
}

export interface ParsedPayroll {
  lines: PayrollLine[];
  totals: Partial<PayrollLine>;
  fileName: string;
  // FTC exports vary month to month in which vendor-deduction columns they carry at all
  // (see parseFtcPayrollXls) — undefined for the regular payroll parser. When set, marks
  // which of furnmart/bodulo/medAidEe/afritecLoans were actually found as real columns in
  // THIS file, as opposed to the always-0 placeholder used when a column is simply absent.
  // Consumers (reconciliation/page.tsx) use this to decide whether a 0 on an FTC employee
  // means "confirmed zero" or "not tracked by this file" before treating it as comparable
  // payroll-side data.
  ftcColumnsFound?: { furnmart: boolean; bodulo: boolean; medAidEe: boolean; afritecLoans: boolean };
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
// Contract/Balance/SEQ/TOTAL columns has been seen alongside much simpler flat exports
// with one row per employee and no TOTAL column at all — either EMP NO/Name/Surname/
// Deduction, or a bare Code/SURNAME/NAME/Amount variant) — columns are detected from
// the header row by keyword rather than hardcoded positions, with the original
// multi-SEQ layout's fixed indices (1,2,3,10,11) kept as a fallback only for the rare
// case the header row itself can't be located.
// When a TOTAL column exists, it's only populated on the LAST contract row per
// employee (multi-SEQ accumulation); when there's no TOTAL column, DEDUCTION (or
// Amount) is the final per-employee amount directly (one row per employee, nothing
// to accumulate).

export async function parseFurnmart(buf: ArrayBuffer, fileName: string): Promise<ParsedStatement> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const empColPattern = /emp\.?\s*no\.?|^\s*code\s*$/i;
  const headerIdx = rows.findIndex(r =>
    r.some((c: any) => empColPattern.test(String(c || '').trim())),
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 8;
  const hRow = rows[headerIdx >= 0 ? headerIdx : 0] || [];

  function col(pattern: RegExp): number {
    return hRow.findIndex((c: any) => pattern.test(String(c || '').trim()));
  }
  const colEmpFound = col(empColPattern);
  const colNameFound = col(/^name$/i);
  const colSurnameFound = col(/surname/i);
  const colDeductionFound = col(/deduction|^amount$/i);
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
// Column positions vary — the original policy-list export (Custom Policy Number as
// empCode, Premium Due amount, a bottom "TOTAL TO PAY" summary block) has been seen
// alongside much simpler flat exports uploaded to this same slot for other
// funeral/life-insurance-style products (e.g. an Afritec-branded life insurance list
// with just Employee Number/Name/Surname/Premium Due columns and no summary block at
// all) — columns are detected from the header row by keyword, with the original
// hardcoded positions ([4] Custom Policy Number, [9] Premium Due) kept only as a
// fallback when no header row can be located at all. Unlike the legacy layout (which
// has no name column — empCode is repeated into `name` for display only), a detected
// Name/Surname column is used for the real employee name when present.

export async function parseBodulo(buf: ArrayBuffer, fileName: string): Promise<ParsedStatement> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const codeColPattern = /custom|policy.?id|employee.?n(?:umber|o\.?)|emp(?:loyee)?\.?\s*(?:no\.?|#)|staff\.?\s*no\.?|payroll\.?\s*no\.?|^\s*code\s*$/i;
  // Some products on this slot carry no employee code column at all — just a
  // plain Name/Surname/Amount sheet (confirmed live: an "Afritec Bodulo NL"
  // export with exactly those three headers, nothing else). The header row
  // still needs to be found in that case, so detection also accepts a bare
  // Surname/Name header even without a code-shaped column alongside it —
  // otherwise headerIdx stays -1 and the code below falls through to the
  // legacy layout's hardcoded column 4, which doesn't exist on a 3-column
  // sheet, silently discarding every row (row[4] is always undefined).
  const nameHeaderPattern = /surname|^(?:full\s*)?name$|^employee\s*name$|^customer\s*name$/i;
  const headerIdx = rows.findIndex(r =>
    r.some((c: any) => codeColPattern.test(String(c || '').trim())) ||
    r.some((c: any) => nameHeaderPattern.test(String(c || '').trim())),
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 1;
  const hRow = rows[headerIdx >= 0 ? headerIdx : 0] || [];

  function col(pattern: RegExp): number {
    return hRow.findIndex((c: any) => pattern.test(String(c || '').trim()));
  }
  const colCodeFound = col(codeColPattern);
  const colAmtFound = col(/premium\s*due|^amount$|^deduction$/i);
  const colSur = col(/surname/i);
  const colFirstNamed = col(/first.?name|forename/i);
  const colBareName = col(/^(?:full\s*)?name$/i);
  const colCombinedName = col(/^employee\s*name$|^customer\s*name$/i);
  // Same bare-"Name"-vs-"Surname" ambiguity handling as parseAfritecXls — see there.
  const colFullName = colCombinedName >= 0 ? colCombinedName : (colSur < 0 ? colBareName : -1);
  const colFirst = colFirstNamed >= 0 ? colFirstNamed : (colSur >= 0 ? colBareName : -1);
  const hasNameCol = colFullName >= 0 || colFirst >= 0 || colSur >= 0;

  // A header row WAS found (via the name pattern above) but has no code
  // column at all — a genuine no-code product, not the "no header found"
  // legacy case. Falling back to the hardcoded column 4 here would be wrong
  // (there is no column 4), so leave colCode unresolved and match by name
  // only, same as Furnmart's noCodeTotal path.
  const noCodeAtAll = colCodeFound < 0 && headerIdx >= 0 && hasNameCol;
  const colCode = colCodeFound >= 0 ? colCodeFound : (noCodeAtAll ? -1 : 4);
  const colAmt = colAmtFound >= 0 ? colAmtFound : -1;

  const lines: ReconLine[] = [];
  const unmatchedLines: ReconLine[] = [];

  if (noCodeAtAll) {
    const parseAmount = (v: unknown): number => {
      if (typeof v === 'number') return v;
      const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '');
      return Number(cleaned) || 0;
    };
    for (let i = dataStart; i < rows.length; i++) {
      const row = rows[i];
      const name = colFullName >= 0
        ? String(row[colFullName] || '').trim()
        : `${String(row[colFirst] ?? '')} ${String(row[colSur] ?? '')}`.trim();
      if (!name) continue;
      const amount = colAmt >= 0 ? parseAmount(row[colAmt]) : 0;
      if (amount <= 0) continue;
      unmatchedLines.push({ empCode: '', name, amount });
    }
    const total = unmatchedLines.reduce((s, l) => s + l.amount, 0);
    return { uploadType: 'bodulo', lines, unmatchedLines, total, fileName };
  }

  // Tolerant numeric parse — a management/manually-entered row can carry its amount as
  // text with a currency prefix or thousands separator (e.g. "P380.00", "1,234.00")
  // where bare Number(...) returns NaN. Confirmed live: two CFE Management rows on a
  // real NL Bodulo export were silently dropped (see the unmatchedLines note below)
  // despite having genuine, verifiable amounts on CFEM's own report — this is the most
  // likely cause, since 35 other rows on the same file parsed with plain Number(...).
  const parseAmount = (v: unknown): number => {
    if (typeof v === 'number') return v;
    const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '');
    return Number(cleaned) || 0;
  };

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    // Stop when we hit the legacy layout's summary block (no code, has label text) —
    // harmless no-op for the simpler layout, which has no such block.
    if (!row[colCode] && String(row[5] || '').length > 0) continue;
    if (!row[colCode]) continue;

    const rawCode = String(row[colCode] || '').trim();
    const amount = colAmt >= 0 ? parseAmount(row[colAmt]) : (parseAmount(row[9]) || parseAmount(row[3]));
    const name = colFullName >= 0
      ? String(row[colFullName] || '').trim()
      : (colFirst >= 0 || colSur >= 0)
        ? `${String(row[colFirst] ?? '')} ${String(row[colSur] ?? '')}`.trim()
        : rawCode; // legacy policy list has no name column — repeat the code for display
    if (!rawCode || amount <= 0) {
      // Previously discarded with no trace at all — a row that has a real code/name but
      // an amount that still didn't parse (blank, "-", or a format parseAmount can't
      // salvage) at least surfaces here instead of vanishing invisibly from the total.
      if (rawCode && name) unmatchedLines.push({ empCode: normalizeCode(rawCode), name, amount: 0 });
      continue;
    }

    const line: ReconLine = { empCode: normalizeCode(rawCode), name, amount };
    lines.push(line);
  }

  // "TOTAL TO PAY" is in col[6] of the legacy layout's summary block at the bottom
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

// ── Pension/Provident Fund contribution schedule .xlsx ─────────────────────────
// Multi-sheet, one sheet per month (e.g. "April 26" … "July 26"), plus reference
// tabs ("Detailed field discriptions", "Schedule") that aren't monthly data —
// picks the sheet matching the target period via pickFtcSheet (same month/year
// matching the FTC payroll parser uses; defined further below, hoisted).
// Header row (detected by keyword, not a fixed row index): EMPLOYEE NO, FIRST
// NAMES, SURNAME, MEMBER CONTRIBUTION AMOUNT (the employee/EE side — what
// payroll's own pensionEe column represents), EMPLOYER CONTRIBUTION AMOUNT (ER),
// and (some schedules, e.g. the CFEM management template) MEMBER AVC
// CONTRIBUTION — an additional voluntary contribution BY THE MEMBER (i.e. still
// deducted from the employee, on top of their mandatory contribution). Per
// explicit instruction, this is folded into the EE-side total, not treated as a
// third separate bucket: `lines[].amount`/`total` = MEMBER CONTRIBUTION AMOUNT +
// MEMBER AVC CONTRIBUTION. Confirmed live on SHA001 (CFEM management template):
// schedule EE-only (member contribution alone) was 1186.50 against the payroll
// deductions report's 1626.65 — a 440.15 gap that shrinks to 56.52 once SHA001's
// 496.67 AVC is folded in, confirming AVC belongs on the employee side, not
// dropped from the comparison entirely.
// The combined figure ("bankTotal" — what's actually paid to the fund
// administrator, used by Consolidation's Pension System row) is always computed
// directly as EE + ER + AVC, NOT read from the sheet's own printed "Total
// Contributions" column — confirmed live on the CFEM management template that
// its own total column excludes AVC entirely (e.g. a row with EE 1186.50 + ER
// 2135.70 + AVC 496.67 prints a "Total Contributions" of 3322.20, silently
// dropping the AVC).

export async function parsePensionSchedule(
  buf: ArrayBuffer,
  fileName: string,
  targetMonth = 0,
  targetYear = 0,
): Promise<ParsedStatement> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = pickFtcSheet(wb.SheetNames, targetMonth, targetYear);
  const ws = wb.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const codeColPattern = /employee.?n(?:umber|o\.?)|emp(?:loyee)?\.?\s*(?:no\.?|#)|^\s*code\s*$/i;
  const headerIdx = rows.findIndex(r =>
    r.some((c: any) => codeColPattern.test(String(c || '').trim())),
  );
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 1;
  const hRow = rows[headerIdx >= 0 ? headerIdx : 0] || [];

  function col(pattern: RegExp): number {
    return hRow.findIndex((c: any) => pattern.test(String(c || '').trim()));
  }
  const colCode = col(codeColPattern);
  const colFirst = col(/first.?name|forename/i);
  const colSur = col(/surname/i);
  const colMember = col(/member\s*contribution\s*amount|employee\s*contribution\s*amount/i);
  const colEmployer = col(/employer\s*contribution\s*amount/i);
  const colAvc = col(/member\s*avc\s*contribution/i);

  const lines: ReconLine[] = [];
  const unmatchedLines: ReconLine[] = [];
  let eeSum = 0;
  let bankSum = 0;

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    const rawCode = String(row[colCode] || '').trim();
    if (!rawCode) continue;

    // Unlike every other vendor parser in this file (Furnmart/Bodulo/Afritec all
    // explicitly skip a trailing "TOTAL"/"GRAND TOTAL" summary row), this loop had
    // no such guard — a schedule whose bottom totals row carries any text in the
    // Employee No./Name columns would get summed in as if it were another
    // employee, doubling eeSum/bankSum on top of the already-complete per-employee
    // sum. Confirmed as the cause of Consolidation's Pension System total reading
    // higher than the fund administrator's own printed total.
    const first = String(row[colFirst] ?? '').trim();
    const sur = String(row[colSur] ?? '').trim();
    if (/total/i.test(rawCode) || /total/i.test(first) || /total/i.test(sur)) continue;

    const ee = colMember >= 0 ? Number(row[colMember]) || 0 : 0;
    const er = colEmployer >= 0 ? Number(row[colEmployer]) || 0 : 0;
    const avc = colAvc >= 0 ? Number(row[colAvc]) || 0 : 0;
    // Member AVC is a voluntary contribution BY the employee, so it belongs on
    // the EE side alongside the mandatory member contribution, not left out.
    const eeTotal = ee + avc;
    const combined = eeTotal + er;
    if (eeTotal <= 0 && combined <= 0) continue;

    const name = `${first} ${sur}`.trim();
    lines.push({ empCode: normalizeCode(rawCode), name, amount: eeTotal, bankAmount: combined });
    eeSum += eeTotal;
    bankSum += combined;
  }

  return {
    uploadType: 'pension',
    lines,
    unmatchedLines,
    total: eeSum,
    bankTotal: bankSum,
    fileName,
  };
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
  if (headerIdx < 0) {
    // Pom Pom's own export is a differently-shaped tabular layout — separate
    // "Last Name"/"First Name" columns (not one combined name column), the
    // employee code in "Emp. Number" (not column A), and its own "omang"
    // column. Confirmed live (July 2026): "Total Allowances" is actually the
    // GROSS earnings total (Basic Pay + Leave Pay + Overtime + Tip + Unpaid
    // Leave, the last of which can be negative) — despite the misleading
    // name, it's what feeds incomeTotal here, the same role "Income Total"
    // plays in the Code-anchored shape above.
    return parsePomPomPayrollXlsx(rows, fileName);
  }

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
  // BURS ITW8 fields — confirmed against real CSL/NL payroll spreadsheets
  // (column presence varies month to month; a missing column here means no
  // payment of that kind occurred, per explicit instruction, not "unknown").
  // 1001 ("Maternity Leave-NegativeIncome") is deliberately excluded from
  // OtherPayments despite its similar numbering to 1000 — confirmed a
  // different, unrelated item, not overtime.
  const col1000Overtime = col(/\b1000\b/);
  const col1003Tip      = col(/\b1003\b/);
  const col1004Notice   = col(/\b1004\b/);
  const col5321Ot15     = col(/\b5321\b/);
  const col5323Ot2      = col(/\b5323\b/);
  const col5300Comm     = col(/\b5300\b/);
  const col5771Sever    = col(/\b5771\b/);
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
      idNumber: '',
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
      otherPayments: n(row, col1000Overtime) + n(row, col1003Tip) + n(row, col1004Notice) + n(row, col5321Ot15) + n(row, col5323Ot2),
      bonusCommission: n(row, col5300Comm),
      severanceNonTaxable: n(row, col5771Sever),
    });
  }

  return { lines, totals, fileName };
}

// ── Pom Pom Staff Payroll (differently-shaped tabular .xlsx) ─────────────────
// Header row anchored on "Last Name" (col A) instead of "Code" — everything
// else about the layout differs too: employee code lives in "Emp. Number",
// the name is split across "Last Name"/"First Name", and there's a genuine
// "omang" column BURS matching doesn't need but a future Omang import could
// use. Vendor deduction columns (Afritec life/Loan, Curios, Flights,
// Furniture Mart) use PomPom's own vocabulary, not the SA/CSL vendor set —
// irrelevant to BURS (which only reads basic/incomeTotal/pensionEe/paye), so
// left at 0 rather than guessing a mapping with no consumer to verify against.
function parsePomPomPayrollXlsx(rows: any[][], fileName: string): ParsedPayroll {
  const headerIdx = rows.findIndex(r =>
    String(r[0] || '').trim().toLowerCase() === 'last name' &&
    r.some((c: any) => String(c || '').toLowerCase().includes('first name')),
  );
  if (headerIdx < 0) throw new Error('Could not find header row in payroll spreadsheet (expected "Code" or "Last Name" in column A)');

  const hRow = rows[headerIdx];
  function col(keyword: string | RegExp): number {
    return hRow.findIndex((h: any) => {
      const s = String(h || '').trim().toLowerCase();
      return typeof keyword === 'string' ? s.includes(keyword) : keyword.test(s);
    });
  }

  const colSurname   = 0;
  const colFirstName = col('first name');
  const colCode       = col(/emp\.?\s*number|emp\.?\s*no/);
  const colOmang       = col('omang');
  const colBasic       = col('basic pay');
  const colIncome      = col('total allowances'); // misleadingly named — this is the gross earnings total
  const colPension     = col(/pension\s*employee/);
  const colPaye        = col(/paye|pay as you earn/);
  const colMedAid      = col(/medical.*aid.*employee/);
  const colDedTotal    = col('total deductions');
  const colNett        = col('total net pay');
  // BURS OtherPayments — Pom Pom has no numeric account codes (unlike
  // CSL/NL), just plain labels. Explicit per instruction: Leave Pay +
  // Overtime + Tip Pom Pom only. Deliberately NOT the same as `incomeTotal -
  // basic` (= Total Allowances - Basic Pay), since that also folds in Unpaid
  // Leave, which isn't part of this definition.
  const colLeavePay    = col('leave pay');
  const colOvertime    = col(/^overtime$/);
  const colTip         = col(/tip pom pom/);

  function n(row: any[], c: number): number {
    return c >= 0 ? Number(row[c]) || 0 : 0;
  }

  const lines: PayrollLine[] = [];
  let totals: Partial<PayrollLine> = {};

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const surname = String(row[colSurname] || '').trim();
    const firstName = String(row[colFirstName] || '').trim();
    const code = String(row[colCode] || '').trim();

    if (!surname && !firstName) {
      // No name — either a genuinely blank row, or (if there are real
      // numeric totals) the sheet's final totals row.
      const isTotalsRow = n(row, colIncome) > 0 || n(row, colDedTotal) > 0 || n(row, colNett) > 0;
      if (isTotalsRow) {
        totals = {
          basic: n(row, colBasic),
          incomeTotal: n(row, colIncome),
          pensionEe: n(row, colPension),
          paye: n(row, colPaye),
          medAidEe: n(row, colMedAid),
          deductionTotal: n(row, colDedTotal),
          nettPay: n(row, colNett),
        };
      }
      continue;
    }

    lines.push({
      empCode: normalizeCode(code),
      name: `${firstName} ${surname}`.trim(),
      firstName,
      surname,
      idNumber: colOmang >= 0 ? String(row[colOmang] || '').trim() : '',
      basic: n(row, colBasic),
      incomeTotal: n(row, colIncome),
      furnmart: 0,
      cbStores: 0,
      bodulo: 0,
      pensionEe: n(row, colPension),
      paye: n(row, colPaye),
      medAidEe: n(row, colMedAid),
      afritecLoans: 0,
      toplineLoans: 0,
      staffLoans: 0,
      deductionTotal: n(row, colDedTotal),
      nettPay: n(row, colNett),
      otherPayments: n(row, colLeavePay) + n(row, colOvertime) + n(row, colTip),
    });
  }

  return { lines, totals, fileName };
}

// ── CFEM RPRT739 Deductions Report (plain-text, saved as .csv) ───────────────
// A narrow deductions-only export — one row per employee: code, name (surname
// + truncated first-name), current PAYE, current Pension. No salary/gross
// figure at all (CFEM's payroll is confidential — see the Reconciliation
// section — so this report only ever carries the two deduction columns BURS
// needs). Basic salary must come from elsewhere (the employees table) —
// callers enrich `basic`/`incomeTotal` themselves; this parser only returns
// the raw {empCode, name, paye, pensionEe} rows.

export interface Rprt739Entry {
  empCode: string;
  name: string;
  paye: number;
  pensionEe: number;
}

export function isRprt739File(firstLine: string): boolean {
  const l = firstLine.toLowerCase();
  return l.includes('emp number') && l.includes('paye') && l.includes('pension');
}

export function parseRprt739(text: string): Rprt739Entry[] {
  const entries: Rprt739Entry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || /^_+$/.test(trimmed)) continue;
    if (/^emp number/i.test(trimmed) || /^current\b/i.test(trimmed) || /^total\b/i.test(trimmed)) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 3) continue;
    const paye = parseFloat(tokens[tokens.length - 2]);
    const pensionEe = parseFloat(tokens[tokens.length - 1]);
    if (isNaN(paye) || isNaN(pensionEe)) continue;
    entries.push({
      empCode: tokens[0],
      name: tokens.slice(1, tokens.length - 2).join(' '),
      paye,
      pensionEe,
    });
  }
  return entries;
}

// ── ILG "12 Month Analysis Report" (plain-text, saved as .csv) ───────────────
// Not a real delimited CSV — a fixed-width text export from ILG's own payroll
// system. Each employee is a block: a header line (Code, Name, then a bracketed
// [status,periodFrom - periodTo][...] metadata tag) followed by indented label
// lines (Salary/Tips/PROV/PAYE/etc), each showing up to 12 monthly columns
// (headed AUG..JUL — this system's own fiscal year) plus a trailing TOTAL. The
// text is paginated for printing, so "001 Indaba Lodge Gaborone... PAGE n" and
// the repeated "MONTHS AUG SEP ... TOTAL" header line can appear MID-BLOCK,
// splitting an employee's header from its data lines across a page break —
// those must be skipped without ending the current block. Confirmed against a
// real July 2026 file: every employee had at most one populated monthly column
// (this being presumably the first month tracked in this system), so rather
// than trying to map header labels to calendar months (unverified — the one
// populated value for July 2026 data sat under this file's "AUG" column, not
// "JUL", so the header labels don't reliably correspond to real calendar
// months), the LAST non-zero monthly value on each line (i.e. immediately
// before the always-present TOTAL) is taken as "this period's" figure — robust
// whether the report resets every month or accumulates across the fiscal year.
// Caveat: if an employee's most recent month is genuinely a blank cell (not an
// explicit 0) with a nonzero value in an earlier column, this would incorrectly
// pick up the earlier value — unconfirmed with only one month of sample data.

const ILG_REPORT_LABEL_RE = /ANALYSIS REPORT/i;

export function isIlgAnalysisReportFile(text: string): boolean {
  return ILG_REPORT_LABEL_RE.test(text) && /^\s*MONTHS\b/m.test(text);
}

// ── ILG Payroll List (plain-text, saved as .csv) ──────────────────────────────
// A second, distinct ILG payroll export — not the "12 Month Analysis Report"
// above. Same "LIST OF: <Vendor> METHOD NO: ALL (Current period)" sectioned
// shape as CFEM's deductions reports (parseCfemDeductions/parseCfemPensionCsv),
// but for ILG's own payroll system, and (confirmed on a real file) carrying
// THREE sections: "Salary" (basic salary — a genuinely different, narrower
// column shape: just EMP.CODE / EMPLOYEE NAME / EMP.AMOUNT, no CO.CONTRIB/
// TOTAL at all, since there's no employer-side "salary contribution"), "PAYE"
// (EMP.CODE / NAME / CO.CONTRIB / EMP.AMOUNT / TOTAL — CO.CONTRIB always 0,
// PAYE has no employer side), and "PROVIDENT" (same 3-column shape, CO.CONTRIB
// = employer contribution, EMP.AMOUNT = employee contribution). Every section
// needed for a BURS submission (basic, PAYE, pension) is present directly in
// this one file — no DB enrichment needed, unlike CFEM's RPRT739 (which is
// deductions-only with no salary figure at all, since CFEM's payroll is
// confidential — see enrichRprt739WithBasicSalary in burs/page.tsx).
// PAYE only lists employees who actually owe tax that period (8 of the
// Salary section's 37 on the confirmed sample) — union the employee set from
// the Salary section (the full roster) and default PAYE/Provident to 0 for
// anyone missing from those sections. A terminated employee's row can carry
// a trailing "TERM DD/MM/YYYY" note after their amount (e.g. "1717.30
// TERM 19/08/2026") — harmless, since name/values are sliced from the code
// up to the first matched number, well before that trailing text.
const ILG_LIST_HEADER_RE = /^LIST OF:/i;
const ILG_LIST_SUMMARY_RE = /empl/i;
const ILG_LIST_NUM_RE = /-?\d*\.\d{2}/g;

interface IlgListLine {
  empCode: string;
  name: string;
  values: number[];
}

function parseIlgListSections(text: string): Map<string, IlgListLine[]> {
  const sections = new Map<string, IlgListLine[]>();
  let current: IlgListLine[] | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (ILG_LIST_HEADER_RE.test(trimmed)) {
      const rest = trimmed.replace(ILG_LIST_HEADER_RE, '').trim();
      const vendor = rest.split(/\s{2,}/)[0]?.trim().toLowerCase() || 'unknown';
      current = [];
      sections.set(vendor, current);
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith('(') && ILG_LIST_SUMMARY_RE.test(trimmed)) continue; // "( N Empls)" totals row

    const nums = [...raw.matchAll(ILG_LIST_NUM_RE)];
    if (nums.length === 0) continue; // header row, dashed divider, blank line

    const codeMatch = raw.match(/^\s*(\S+)/);
    if (!codeMatch) continue;
    const empCode = normalizeCode(codeMatch[1]);
    const name = raw.slice(codeMatch[0].length, nums[0].index).replace(/\s+/g, ' ').trim();
    if (!name) continue; // guards against a stray numeric-only line
    current.push({ empCode, name, values: nums.map(n => parseFloat(n[0]) || 0) });
  }
  return sections;
}

export function isIlgPayrollListFile(text: string): boolean {
  return /LIST OF:/i.test(text) && /METHOD NO:/i.test(text) && !ILG_REPORT_LABEL_RE.test(text);
}

export function parseIlgPayrollList(text: string, fileName: string): ParsedPayroll {
  const sections = parseIlgListSections(text);
  const salaryLines = sections.get('salary') ?? [];
  const payeLines = sections.get('paye') ?? [];
  const providentLines = sections.get('provident') ?? [];

  const payeByCode = new Map(payeLines.map(l => [l.empCode, l]));
  const providentByCode = new Map(providentLines.map(l => [l.empCode, l]));

  const lines: PayrollLine[] = salaryLines.map(s => {
    const basic = s.values[0] ?? 0;
    const paye = payeByCode.get(s.empCode)?.values[1] ?? 0; // [CO.CONTRIB, EMP.AMOUNT, TOTAL]
    const pensionEe = providentByCode.get(s.empCode)?.values[1] ?? 0;
    return {
      empCode: s.empCode,
      name: s.name,
      idNumber: '',
      basic,
      incomeTotal: basic,
      furnmart: 0, cbStores: 0, bodulo: 0,
      pensionEe,
      paye,
      medAidEe: 0,
      afritecLoans: 0, toplineLoans: 0, staffLoans: 0,
      deductionTotal: paye + pensionEe,
      nettPay: basic - paye - pensionEe,
    };
  });

  return { lines, totals: {}, fileName };
}

const ILG_EMPLOYEE_HEADER_RE = /^([A-Z0-9]{3,10})\s+(.+?)\s*\[/;

function ilgCurrentMonthValue(trimmedLine: string): number {
  const numbers = trimmedLine
    .split(/\s+/)
    .slice(1) // drop the label word
    .map(t => parseFloat(t.replace(/,/g, '')))
    .filter(n => !isNaN(n));
  if (numbers.length === 0) return 0;
  const monthly = numbers.slice(0, -1); // last token is always TOTAL
  return monthly.length ? monthly[monthly.length - 1] : numbers[numbers.length - 1];
}

export function parseIlgAnalysisReport(text: string, fileName: string): ParsedPayroll {
  const lines = text.split(/\r?\n/);
  const result: PayrollLine[] = [];

  let current: { empCode: string; name: string; basic: number; other: number; pensionEe: number; paye: number } | null = null;
  let ended = false;

  const flush = () => {
    if (!current) return;
    result.push({
      empCode: normalizeCode(current.empCode),
      name: current.name,
      idNumber: '',
      basic: current.basic,
      incomeTotal: current.basic + current.other,
      furnmart: 0, cbStores: 0, bodulo: 0,
      pensionEe: current.pensionEe,
      paye: current.paye,
      medAidEe: 0,
      afritecLoans: 0, toplineLoans: 0, staffLoans: 0,
      deductionTotal: 0,
      nettPay: current.basic + current.other - current.pensionEe - current.paye,
    });
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || ended) continue;

    const headerMatch = raw.match(ILG_EMPLOYEE_HEADER_RE);
    if (headerMatch) {
      flush();
      current = {
        empCode: headerMatch[1],
        name: headerMatch[2].trim().replace(/\s+/g, ' '),
        basic: 0, other: 0, pensionEe: 0, paye: 0,
      };
      continue;
    }

    // Page-break boilerplate ("... (Pty) Ltd ... 12 MONTH ANALYSIS REPORT ...
    // PAGE n" and the repeated "MONTHS AUG SEP ... TOTAL" header) — skip
    // without disturbing the in-progress block, since an employee's data
    // lines can resume right after it on the next page.
    if (ILG_REPORT_LABEL_RE.test(raw) || trimmed.startsWith('MONTHS')) {
      continue;
    }

    // Grand-total summary block at the end of the report — flush the last real
    // employee and stop; everything after this belongs to the report totals,
    // not any individual employee.
    if (trimmed === 'TOTAL' || /above Totals include/i.test(raw)) {
      flush();
      current = null;
      ended = true;
      continue;
    }

    if (!current) continue;
    const labelMatch = trimmed.match(/^([A-Za-z][A-Za-z ]*?)\s+[\d.,-]/);
    if (!labelMatch) continue;
    const label = labelMatch[1].trim().toLowerCase();
    const value = ilgCurrentMonthValue(trimmed);
    if (label === 'salary') current.basic += value;
    else if (label === 'prov') current.pensionEe += value;
    else if (label === 'paye') current.paye += value;
    else current.other += value; // Tips and any other variable-pay line item
  }
  flush();

  const totals = result.reduce<Partial<PayrollLine>>((acc, l) => ({
    basic: (acc.basic ?? 0) + l.basic,
    incomeTotal: (acc.incomeTotal ?? 0) + l.incomeTotal,
    pensionEe: (acc.pensionEe ?? 0) + l.pensionEe,
    paye: (acc.paye ?? 0) + l.paye,
  }), {});

  return { lines: result, totals, fileName };
}

// ── FTC / Casual Pay Register parser ─────────────────────────────────────────
// Handles the bespoke multi-sheet "FIXED SERVICE PAY" xls format — also single-sheet
// exports (pickFtcSheet falls back to the only sheet when there's just one).
// Column count and positions vary across sheets (3–14 cols); detection finds
// "NAME"/"FULL NAME" and "TOTAL PAY"/"GROSS SALARY"/"NETT PAY" header cells each time.
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
): {
  found: boolean; nameCol: number; totalCol: number; basicCol: number;
  furnmartCol: number; boduloCol: number; medAidCol: number; afritecLoanCol: number;
  rowIdx: number;
} {
  for (let i = startRow; i < Math.min(startRow + 15, rows.length); i++) {
    let nameCol = -1, totalCol = -1, basicCol = -1;
    let furnmartCol = -1, boduloCol = -1, medAidCol = -1, afritecLoanCol = -1;
    rows[i].forEach((cell: any, j: number) => {
      const s = String(cell ?? '').trim().toLowerCase();
      // "Employee Name" added after a real CSL FTC export used that header instead of
      // a bare "Name"/"Full Name" — the same silent-zero-rows failure mode as the
      // "NETT PAY" fix below.
      if (/^(full\s+)?name$|^employee\s*name$/.test(s)) nameCol = j;
      // "NETT PAY" added after a real CSL FTC export used that header instead of
      // "TOTAL PAY"/"GROSS SALARY" — without it findFtcHeader never locates the header
      // row at all (found stays false) and the file parses to zero rows silently.
      // Bare "Amount" (anchored, so it never matches e.g. "Loan Amount") covers a
      // minimal two-column CSL FTC export (Employee Name / Amount, no other columns
      // at all) confirmed live.
      if (/total.+pay|gross.+salary|^nett\s*pay\b|^amount$/.test(s)) totalCol = j;
      // A distinct basic-pay column, when present, is genuine basic pay — the total/
      // nett-pay column is NOT basic (real CSL FTC exports have both side by side: one
      // month headers it "Basic Salary" + "NETT PAY", another headers the same concept
      // just "Salary" + "NETT PAY" — both confirmed on real CSL FTC exports). Without
      // this, .basic silently took on Net Pay's value, which then fed the Employees
      // tab's Basic Salary Mismatch comparison and any other consumer expecting genuine
      // basic salary. Anchored (^...$) so it never matches "GROSS SALARY" (already
      // claimed by totalCol above) or any other multi-word phrase containing "salary".
      if (/^(basic\s+)?salary$/.test(s)) basicCol = j;
      // Vendor-deduction columns — present on some FTC exports (a real CSL FTC file has
      // Funeral Cover/Afritec loan/Furnmart/Medical aid columns alongside Salary/NETT
      // PAY), absent on others (the original bespoke multi-sheet format, and the simpler
      // CSL_FTC.xlsx variant with only Afritec columns). ftcColumnsFound on the return
      // value tells callers which of these were actually read vs left at the default 0.
      if (/furnmart/.test(s)) furnmartCol = j;
      if (/funeral|bodulo/.test(s)) boduloCol = j;
      if (/medical/.test(s)) medAidCol = j;
      if (/afritec/.test(s)) afritecLoanCol = j;
    });
    if (nameCol >= 0 && totalCol >= 0) {
      return { found: true, nameCol, totalCol, basicCol, furnmartCol, boduloCol, medAidCol, afritecLoanCol, rowIdx: i };
    }
  }
  return { found: false, nameCol: 0, totalCol: -1, basicCol: -1, furnmartCol: -1, boduloCol: -1, medAidCol: -1, afritecLoanCol: -1, rowIdx: startRow };
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
  const { found, nameCol, totalCol, basicCol, furnmartCol, boduloCol, medAidCol, afritecLoanCol, rowIdx: headerIdx } =
    findFtcHeader(rows, 0);
  if (!found) return { lines: [], totals: {}, fileName };

  const lines: PayrollLine[] = [];
  let grandTotal = 0;
  let grandBasic = 0;
  let grandFurnmart = 0;
  let grandBodulo = 0;
  let grandAfritecLoans = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const rawName = String(row[nameCol] ?? '').trim();
    if (!rawName) continue;
    if (/^(prepared|checked|authorised|total)/i.test(rawName)) continue;

    const total = Number(row[totalCol]) || 0;
    // Second header rows (when two blocks share a sheet) have a non-numeric total
    if (total <= 0) continue;
    // Falls back to total (unchanged prior behaviour) for FTC formats with no distinct
    // basic-pay column — the original bespoke multi-sheet format this parser targets.
    const basic = basicCol >= 0 ? Number(row[basicCol]) || 0 : total;
    const furnmart = furnmartCol >= 0 ? Number(row[furnmartCol]) || 0 : 0;
    const bodulo = boduloCol >= 0 ? Number(row[boduloCol]) || 0 : 0;
    const medAidEe = medAidCol >= 0 ? Number(row[medAidCol]) || 0 : 0;
    const afritecLoans = afritecLoanCol >= 0 ? Number(row[afritecLoanCol]) || 0 : 0;

    const key = nameKey(rawName);
    const existing = lines.find(l => l.empCode === key);
    if (existing) {
      // Same employee appearing in a second block on the same sheet — sum totals
      existing.basic += basic;
      existing.incomeTotal += total;
      existing.nettPay += total;
      existing.furnmart += furnmart;
      existing.bodulo += bodulo;
      existing.medAidEe += medAidEe;
      existing.afritecLoans += afritecLoans;
      existing.staffLoans += afritecLoans;
    } else {
      lines.push({
        empCode: key, // nameKey-format; display as "—" in the UI
        name: rawName,
        idNumber: '',
        basic,
        incomeTotal: total,
        furnmart, cbStores: 0, bodulo,
        pensionEe: 0, paye: 0, medAidEe,
        afritecLoans, toplineLoans: 0, staffLoans: afritecLoans,
        deductionTotal: 0,
        nettPay: total,
      });
    }
    grandTotal += total;
    grandBasic += basic;
    grandFurnmart += furnmart;
    grandBodulo += bodulo;
    grandAfritecLoans += afritecLoans;
  }

  return {
    lines,
    // furnmart/bodulo/afritecLoans/staffLoans included so the top-level Deductions Check
    // Summary (mergedTotals in reconciliation/page.tsx, which reads .totals.<field> per
    // vendor) reflects these FTC-sourced figures too, not just the per-employee rows —
    // otherwise the Summary's Statement-vs-Payroll diff would stay off by the FTC portion
    // even after individual FTC employees resolve correctly.
    totals: {
      basic: grandBasic, incomeTotal: grandTotal, nettPay: grandTotal,
      furnmart: grandFurnmart, bodulo: grandBodulo,
      afritecLoans: grandAfritecLoans, staffLoans: grandAfritecLoans,
    },
    fileName,
    ftcColumnsFound: {
      furnmart: furnmartCol >= 0, bodulo: boduloCol >= 0,
      medAidEe: medAidCol >= 0, afritecLoans: afritecLoanCol >= 0,
    },
  };
}

// ── Increase List (CSL/NL salary review workbook, cross-referenced against payroll) ──
// A two-sheet workbook (sheet names "CSL" and "NL"), one row per employee: Surname,
// First Name, (NL only: Job Title), Yrs Service, Grade, Department, Current Gross (P),
// New Gross (P), and a trailing free-text remarks column (e.g. "resigned",
// "new employee DNQ") that has no header label of its own in a real confirmed file.
// Column positions are detected by keyword per sheet rather than hardcoded, since the
// two sheets don't share an identical column set (NL adds Job Title).

export interface IncreaseRow {
  surname: string;
  firstName: string;
  currentGross: number;
  newGross: number;
  comment: string;
}

function parseIncreaseSheet(rows: any[][]): IncreaseRow[] {
  if (!rows.length) return [];
  const header = rows[0].map((c: any) => String(c ?? '').trim().toLowerCase());
  const surnameCol = header.findIndex(h => h === 'surname');
  const firstNameCol = header.findIndex(h => /first\s*name/.test(h));
  const currentCol = header.findIndex(h => /current.*gross/.test(h));
  const newCol = header.findIndex(h => /new.*gross/.test(h));
  // The remarks column carries no header label of its own in the confirmed file — it's
  // simply the column right after New Gross.
  const commentCol = newCol >= 0 ? newCol + 1 : -1;
  if (surnameCol < 0 || currentCol < 0 || newCol < 0) return [];

  const out: IncreaseRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const surname = String(row[surnameCol] ?? '').trim();
    // Skips the sheet's own trailing "Total  employees" summary row (confirmed on a
    // real CSL sheet) — not a real employee.
    if (!surname || /^total/i.test(surname)) continue;
    out.push({
      surname,
      firstName: firstNameCol >= 0 ? String(row[firstNameCol] ?? '').trim() : '',
      currentGross: Number(row[currentCol]) || 0,
      newGross: Number(row[newCol]) || 0,
      comment: commentCol >= 0 ? String(row[commentCol] ?? '').trim() : '',
    });
  }
  return out;
}

export async function parseIncreaseList(buf: ArrayBuffer): Promise<{ CSL: IncreaseRow[]; NL: IncreaseRow[] }> {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const result: { CSL: IncreaseRow[]; NL: IncreaseRow[] } = { CSL: [], NL: [] };
  (['CSL', 'NL'] as const).forEach(code => {
    const sheetName = wb.SheetNames.find((n: string) => n.trim().toUpperCase() === code);
    if (!sheetName) return;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    result[code] = parseIncreaseSheet(rows);
  });
  return result;
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

// ── CFEM Pension Deductions report (plain text/CSV, from CFEM's own payroll system) ──
// NOT the fund administrator's Schedule (see parsePensionSchedule above, a different
// document from a different source) — this is CFEM's own payroll system's pension
// deductions report, in the exact same "LIST OF: <Vendor> METHOD NO: ALL (Current
// period)" sectioned shape as the combined CFEM Deductions Summary (see
// parseCfemDeductions above), just for its own single "Pension Fund" section. Uploaded
// to the separate "Pension Deductions (Payroll)" slot and checked against the Pension
// Schedule upload — the two used to share one upload slot (CSV vs xlsx routing),
// silently clobbering each other since only one recon_uploads row exists per
// period/upload_type. Reuses parseCfemDeductions's section/line scanner rather than
// duplicating the whitespace-vs-number-anchor parsing.
//
// Column order is EMP.CODE / NAME / CO.CONTRIB (employer) / EMP.AMOUNT (employee) /
// TOTAL (EE+ER) — same as every other CFEM deductions section. `lines[].amount` and
// `total` here are EE-only (empAmount), matching the Schedule's own EE-only figure so
// the Pension Employee Detail table compares like-for-like; `bankTotal` carries the
// combined EE+ER figure (the section's own TOTAL-column total).
export function parseCfemPensionCsv(text: string, fileName: string): ParsedStatement {
  const { sections } = parseCfemDeductions(text, fileName);
  const section = sections.find(s => /pension/i.test(s.vendor)) ?? sections[0];
  if (!section) return { uploadType: 'pension_deductions', lines: [], unmatchedLines: [], total: 0, fileName };

  const lines: ReconLine[] = section.lines.map(l => ({ empCode: l.empCode, name: l.name, amount: l.empAmount, bankAmount: l.total }));
  const eeSum = lines.reduce((s, l) => s + l.amount, 0);
  const bankSum = section.total || section.lines.reduce((s, l) => s + l.total, 0);

  return { uploadType: 'pension_deductions', lines, unmatchedLines: [], total: eeSum, bankTotal: bankSum, fileName };
}
