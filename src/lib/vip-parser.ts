// VIP Premier Report 710 (Payslip Register) parser
// Format: fixed-width text, employees separated by ====...==== lines

export interface VipEmployee {
  employeeCode: string;
  fullName: string;
  surname: string;
  firstName: string;
  aka: string;
  paypoint: string;
  departmentCode: string;
  category: number;
  jobGrade: number;
  idNumber: string;
  jobTitle: string;
  periodMonth: number;
  periodYear: number;

  // Earnings
  basicSalary: number;
  allowances: Record<string, number>;
  totalEarnings: number;

  // Employee deductions
  taxPaye: number;
  uifEmployee: number;
  medicalEmployee: number;
  ancillaEmployee: number;
  providentEmployee: number;
  totalDeductions: number;

  // Company contributions
  uifCompany: number;
  medicalCompany: number;
  providentCompany: number;
  sdlCompany: number;
  ancillaCompany: number;
  totalCompanyContrib: number;

  // Summary
  netSalary: number;
  ctc: number;
}

export interface ParseResult {
  employees: VipEmployee[];
  errors: string[];
  periodMonth: number;
  periodYear: number;
}

const SKIP_LABELS = new Set(['BASIC', 'TOTAL', 'NET', 'EARNINGS', 'DEDUCTIONS']);

function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  return parseFloat(s.replace(/,/g, '')) || 0;
}

function parseTxDate(txDt: string): { month: number; year: number } {
  // Format: DDMMYYYY e.g. "01032026"
  if (txDt.length === 8) {
    return {
      month: parseInt(txDt.substring(2, 4)),
      year: parseInt(txDt.substring(4, 8)),
    };
  }
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

function parseBlock(block: string): VipEmployee | null {
  if (!block.includes('EMPL.CODE')) return null;

  // ── Header fields ──────────────────────────────────────────────────────────
  const empCode = block.match(/EMPL\.CODE:\s*(\S+)/)?.[1] ?? '';
  const empName = block.match(/EMP NAME:(.{1,45}?)(?:\s{3,}AKA\s*:|[\r\n])/)?.[1]?.trim() ?? '';
  const aka     = block.match(/AKA\s*:\s*([^\r\n]{1,30})/)?.[1]?.trim() ?? '';

  const paypoint = block.match(/Paypoint:\s*(\S+)/)?.[1] ?? '';
  const deptCode = block.match(/Department:\s*(\S+)/)?.[1] ?? '';
  const category = parseInt(block.match(/Category:\s*(\d+)/)?.[1] ?? '0');
  const jobGrade = parseInt(block.match(/Job Grade:\s*(\d+)/)?.[1] ?? '0');

  const idNumber = block.match(/ID NUMBER:\s*(\S+)/)?.[1] ?? '';
  const jobTitle = block.match(/Job Title\s*:\s*(.{1,40}?)(?:\s{3,}DOB\s*:|[\r\n])/)?.[1]?.trim() ?? '';
  const txDtStr  = block.match(/TxDt:\s*(\d{8})/)?.[1] ?? '';

  if (!empCode) return null;

  const { month: periodMonth, year: periodYear } = parseTxDate(txDtStr);

  // Split name into surname + first name (VIP stores as "SURNAME FIRSTNAME")
  const nameParts = empName.split(/\s+/);
  const surname   = nameParts[0] ?? empName;
  const firstName = nameParts.slice(1).join(' ');

  // ── Earnings ───────────────────────────────────────────────────────────────
  // BASIC and TOTAL are in the left earnings column (start of line)
  const basicSalary   = parseAmount(block.match(/^BASIC\s+([\d,]+\.\d{2})/m)?.[1]);
  const totalEarnings = parseAmount(block.match(/^TOTAL\s+([\d,]+\.\d{2})/m)?.[1]);

  // Allowances: other labels at start of line (not BASIC/TOTAL/NET SAL)
  const allowances: Record<string, number> = {};
  for (const m of block.matchAll(/^([A-Z][A-Z &]{0,12}?)\s{2,}([\d,]+\.\d{2})/gm)) {
    const label = m[1].trim();
    if (SKIP_LABELS.has(label)) continue;
    allowances[label] = parseAmount(m[2]);
  }

  // ── Deductions (label is in the MIDDLE of lines, not at col 0) ────────────
  // TAX — only employee amount
  const taxPaye = parseAmount(block.match(/\bTAX\s+([\d,]+\.\d{2})/)?.[1]);

  // U.I.F — "U.I.F  {emp}  {co}" on same text segment
  const uifMatch      = block.match(/U\.I\.F\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  const uifEmployee   = parseAmount(uifMatch?.[1]);
  const uifCompany    = parseAmount(uifMatch?.[2]);

  // MEDICAL — "{emp}  {co}"
  const medMatch      = block.match(/\bMEDICAL\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  const medicalEmployee = parseAmount(medMatch?.[1]);
  // Company medical: prefer the inline second amount; fall back to "Medical Aid Benefit" label
  const medicalCompany  = parseAmount(medMatch?.[2])
    || parseAmount(block.match(/Medical Aid Benefit\s+([\d,]+\.\d{2})/)?.[1]);

  // ANCILLA — "{emp}  {co}"
  const ancMatch      = block.match(/\bANCILLA\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  const ancillaEmployee = parseAmount(ancMatch?.[1]);
  const ancillaCompany  = parseAmount(ancMatch?.[2]);

  // PROV — "{emp}  {co}"
  const provMatch       = block.match(/\bPROV\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  const providentEmployee = parseAmount(provMatch?.[1]);
  const providentCompany  = parseAmount(provMatch?.[2])
    || parseAmount(block.match(/Provident Fund DC Only\s+([\d,]+\.\d{2})/)?.[1]);

  // SDL — company only (no employee deduction)
  const sdlCompany = parseAmount(block.match(/\bSDL\s+([\d,]+\.\d{2})/)?.[1]);

  const totalDeductions    = taxPaye + uifEmployee + medicalEmployee + ancillaEmployee + providentEmployee;
  const totalCompanyContrib = uifCompany + medicalCompany + providentCompany + sdlCompany + ancillaCompany;

  // ── Net salary ─────────────────────────────────────────────────────────────
  const netSalary = parseAmount(block.match(/NET SAL\s+([\d,]+\.\d{2})/)?.[1]);
  const ctc       = totalEarnings + totalCompanyContrib;

  return {
    employeeCode: empCode,
    fullName: empName,
    surname,
    firstName,
    aka: aka.replace(/\s+$/, ''),
    paypoint,
    departmentCode: deptCode,
    category,
    jobGrade,
    idNumber,
    jobTitle,
    periodMonth,
    periodYear,
    basicSalary,
    allowances,
    totalEarnings,
    taxPaye,
    uifEmployee,
    medicalEmployee,
    ancillaEmployee,
    providentEmployee,
    totalDeductions,
    uifCompany,
    medicalCompany,
    providentCompany,
    sdlCompany,
    ancillaCompany,
    totalCompanyContrib,
    netSalary,
    ctc,
  };
}

// ─── Employee Details TSV parser ──────────────────────────────────────────────

const TSV_MONTH_MAP: Record<string, number> = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

export interface TSVEmployee {
  surname: string;
  firstName: string;
  department: string;
  jobTitle: string;
  employmentDate: string | null;  // ISO date string
  grossSalary: number;
  gradeLabel: string | null;
  medicalCompany: number;
  idNumber: string;
  employeeCode: string;
}

function parseTSVDate(s: string): string | null {
  const t = s.trim();
  // "DD Mon YYYY" — original space-separated 4-digit-year format
  let m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (m) {
    const month = TSV_MONTH_MAP[m[2].toLowerCase()];
    if (!month) return null;
    return `${m[3]}-${String(month).padStart(2, '0')}-${String(parseInt(m[1])).padStart(2, '0')}`;
  }
  // "DD-Mon-YY" or "DD-Mon-YYYY" — Excel short date with dashes
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const month = TSV_MONTH_MAP[m[2].toLowerCase()];
    if (!month) return null;
    const yr = parseInt(m[3]);
    const year = yr < 100 ? (yr >= 50 ? 1900 + yr : 2000 + yr) : yr;
    return `${year}-${String(month).padStart(2, '0')}-${String(parseInt(m[1])).padStart(2, '0')}`;
  }
  // "DD.MM.YYYY" — dot-separated numeric (strip stray spaces first)
  m = t.replace(/\s/g, '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    return `${m[3]}-${String(parseInt(m[2])).padStart(2, '0')}-${String(parseInt(m[1])).padStart(2, '0')}`;
  }
  // "D/M/YYYY" or "DD/MM/YYYY" — slash-separated numeric
  m = t.replace(/\s/g, '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${String(parseInt(m[2])).padStart(2, '0')}-${String(parseInt(m[1])).padStart(2, '0')}`;
  }
  return null;
}

// Detect delimiter — supports tab, comma, or semicolon (common in African/European Excel locales)
function detectDelimiter(firstLine: string): '\t' | ',' | ';' {
  const tabs      = (firstLine.match(/\t/g)  ?? []).length;
  const commas    = (firstLine.match(/,/g)   ?? []).length;
  const semis     = (firstLine.match(/;/g)   ?? []).length;
  if (tabs >= commas && tabs >= semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

// Split a delimited line (handles quoted fields)
function splitCSVLine(line: string, delim: '\t' | ',' | ';'): string[] {
  if (delim === '\t') return line.split('\t');
  const cols: string[] = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === delim && !inQuote) { cols.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

export function isMedicalAidFile(firstLine: string): boolean {
  const l = firstLine.trim().toLowerCase().replace(/"/g, '');
  const hasName    = l.includes('surname') || l.includes('first name') || l.includes('firstname') || l.includes('name');
  const hasMedical = l.includes('medical');
  const hasGross   = l.includes('gross') || l.includes('salary');
  return hasName && hasMedical && !hasGross;
}

export interface MedicalAidEntry {
  firstName: string;
  surname: string;
  medicalCompany: number;
}

export function parseMedicalAidFile(text: string): { employees: MedicalAidEntry[]; errors: string[] } {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const delim = detectDelimiter(lines[0] ?? '');
  const header = splitCSVLine(lines[0], delim).map(h => h.trim().replace(/"/g, '').toLowerCase());

  const idx = {
    firstName: header.findIndex(h => h === 'name' || h === 'first name' || h === 'firstname'),
    surname:   header.findIndex(h => h === 'surname' || h === 'surnmae' || h === 'last name' || h === 'lastname'),
    medical:   header.findIndex(h => h.includes('medical')),
  };

  const employees: MedicalAidEntry[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delim).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.every(c => !c)) continue;
    const get = (k: keyof typeof idx) => idx[k] >= 0 ? cols[idx[k]] ?? '' : '';
    const firstName = get('firstName');
    const surname   = get('surname');
    if (!firstName && !surname) continue;
    employees.push({ firstName, surname, medicalCompany: parseTabularAmount(get('medical')) });
  }
  return { employees, errors };
}

export function isTabularEmployeeFile(firstLine: string): boolean {
  const l = firstLine.trim().toLowerCase().replace(/"/g, '');
  const hasName   = l.includes('surname') || l.includes('first name') || l.includes('firstname');
  const hasSalary = l.includes('gross')   || l.includes('salary');
  const hasId     = l.includes('omang')   || l.includes('id number')  || l.includes('national id') || l.includes('identity');
  const hasDept   = (l.includes('department') || l.includes('dept'))  && (l.includes('title') || l.includes('position'));
  return hasName && (hasSalary || hasId || hasDept);
}

// Keep old export name for compatibility
export const isTSVEmployeeFile = isTabularEmployeeFile;

// Parse a monetary amount that may use either comma-as-decimal (European: "652,5")
// or comma-as-thousands-separator (standard: "1,234"). Strips currency symbols and spaces.
function parseTabularAmount(s: string): number {
  const clean = s.replace(/[\s R]/g, '');
  if (!clean || clean === '-') return 0;
  // European decimal comma: comma present, no period → replace comma with dot
  if (clean.includes(',') && !clean.includes('.')) {
    return parseFloat(clean.replace(',', '.')) || 0;
  }
  // Standard: comma is thousands separator → strip it
  return parseFloat(clean.replace(/,/g, '')) || 0;
}

export function parseTSVEmployeeFile(text: string): { employees: TSVEmployee[]; errors: string[] } {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const delim = detectDelimiter(lines[0] ?? '');
  const errors: string[] = [];
  const employees: TSVEmployee[] = [];

  // Find column indices from header (flexible — column order may vary)
  const header = splitCSVLine(lines[0], delim).map(h => h.trim().replace(/"/g, '').toLowerCase());
  const idx = {
    surname:   header.findIndex(h => h === 'surname' || h === 'surnmae' || h === 'last name' || h === 'lastname'),
    firstName: header.findIndex(h => h === 'name' || h === 'first name' || h === 'firstname'),
    department:header.findIndex(h => h.includes('department') || h.includes('dept')),
    jobTitle:  header.findIndex(h => h.includes('title') || h.includes('position')),
    startDate: header.findIndex(h => h.includes('start') || h.includes('date') || h.includes('commencement')),
    gross:     header.findIndex(h => h.includes('gross') || (h.includes('salary') && !h.includes('net'))),
    grade:     header.findIndex(h => h === 'grade' || h === 'grade label' || h === 'gradelabel'),
    medical:   header.findIndex(h => h.includes('medical')),
    idNumber:  header.findIndex(h => h === 'omang' || h === 'id number' || h === 'id_number' || h === 'id no' || h === 'national id' || h.includes('identity')),
    empCode:   header.findIndex(h => h === 'emp code' || h === 'employee code' || h === 'emp no' || h === 'employee no' || h === 'staff no' || h === 'staff code' || h === 'emp #' || h === 'emp#'),
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delim).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.every(c => !c)) continue;
    const get = (k: keyof typeof idx) => idx[k] >= 0 ? cols[idx[k]] ?? '' : '';
    const surname = get('surname');
    if (!surname) continue;
    employees.push({
      surname,
      firstName:      get('firstName'),
      department:     get('department'),
      jobTitle:       get('jobTitle'),
      employmentDate: parseTSVDate(get('startDate')),
      grossSalary:    parseTabularAmount(get('gross')),
      gradeLabel:     get('grade') || null,
      medicalCompany: parseTabularAmount(get('medical')),
      idNumber:       get('idNumber'),
      employeeCode:   get('empCode'),
    });
  }
  return { employees, errors };
}

// ─── VIP Report 710 parser ────────────────────────────────────────────────────

export function parseVIPReport(text: string): ParseResult {
  const blocks  = text.split(/={10,}/);
  const employees: VipEmployee[] = [];
  const errors: string[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    try {
      const emp = parseBlock(block);
      if (emp) employees.push(emp);
    } catch (e) {
      const code = block.match(/EMPL\.CODE:\s*(\S+)/)?.[1] ?? 'unknown';
      errors.push(`Failed to parse employee ${code}: ${e}`);
    }
  }

  const periodMonth = employees[0]?.periodMonth ?? new Date().getMonth() + 1;
  const periodYear  = employees[0]?.periodYear  ?? new Date().getFullYear();

  return { employees, errors, periodMonth, periodYear };
}

// ─── CSL / Payroll Schedule xlsx parser ──────────────────────────────────────
// Multi-sheet workbook where each sheet is one payroll month.
// Sheet names like "July25", "Aug25", "Jan 26", "April 26".
// Column layout varies per sheet — detect header row and column positions dynamically.

export interface PayrollScheduleRow {
  empCode: string;
  name: string;
  surname: string;
  department: string;
  basic: number;
}

export interface PayrollSchedulePeriod {
  month: number;
  year: number;
  sheetName: string;
  rows: PayrollScheduleRow[];
}

const PAYROLL_MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

export async function parseCslPayrollSchedule(buffer: ArrayBuffer): Promise<PayrollSchedulePeriod[]> {
  const XLSX = (await import('xlsx-js-style')).default;
  const wb = XLSX.read(buffer, { type: 'array' });

  const results: PayrollSchedulePeriod[] = [];

  for (const sheetName of wb.SheetNames) {
    const nameClean = sheetName.trim().toLowerCase();
    const match = nameClean.match(/^([a-z]+)\s*(\d{2,4})$/);
    if (!match) continue;

    const month = PAYROLL_MONTH_MAP[match[1]];
    if (!month) continue;

    const yy = parseInt(match[2]);
    const year = match[2].length <= 2 ? (yy < 50 ? 2000 + yy : 1900 + yy) : yy;

    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];

    // Find header row: first row where col 0-3 contains "EMP #", "EMP#", or "CODE"
    let headerRowIdx = -1;
    let empCodeCol = -1;

    for (let i = 0; i < Math.min(data.length, 10); i++) {
      const row = data[i];
      for (let col = 0; col < Math.min(row.length, 4); col++) {
        const cell = String(row[col] ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
        if (cell === 'EMP #' || cell === 'EMP#' || cell === 'CODE') {
          headerRowIdx = i;
          empCodeCol = col;
          break;
        }
      }
      if (headerRowIdx >= 0) break;
    }

    if (headerRowIdx < 0 || empCodeCol < 0) continue;

    const headerRow = data[headerRowIdx];
    let nameCol = -1, surnameCol = -1, deptCol = -1, basicCol = -1;

    for (let i = 0; i < headerRow.length; i++) {
      const h = String(headerRow[i] ?? '').toUpperCase().replace(/[^A-Z ]/g, '').trim().replace(/\s+/g, ' ');
      if (h.includes('SURNAME'))                          { surnameCol = i; continue; }
      if (h === 'NAME' && nameCol < 0)                   { nameCol = i; continue; }
      if (h.includes('NAME') && !h.includes('SURNAME') && nameCol < 0) { nameCol = i; continue; }
      if (h.includes('DEPARTMENT'))                       { deptCol = i; }
      if (h.includes('BASIC') && h.includes('SALARY'))   { basicCol = i; }
      else if (h === 'BASIC SALARY' || h === 'BASIC')     { if (basicCol < 0) basicCol = i; }
    }

    if (basicCol < 0) continue;

    const sheetRows: PayrollScheduleRow[] = [];
    for (let i = headerRowIdx + 1; i < data.length; i++) {
      const row = data[i];
      const rawCode = String(row[empCodeCol] ?? '').trim();
      if (!rawCode) continue;
      // Skip summary/total rows — employee codes never start with these words
      const uc = rawCode.toUpperCase();
      if (uc.startsWith('TOTAL') || uc.startsWith('GRAND') || uc.startsWith('SUB-') || uc === 'EMP #' || uc === 'EMP#' || uc === 'CODE') continue;

      const rawBasic = row[basicCol];
      const basic = typeof rawBasic === 'number' ? rawBasic : parseFloat(String(rawBasic ?? '0')) || 0;

      sheetRows.push({
        empCode:    rawCode,
        name:       nameCol >= 0    ? String(row[nameCol]    ?? '').trim() : '',
        surname:    surnameCol >= 0 ? String(row[surnameCol] ?? '').trim() : '',
        department: deptCol >= 0    ? String(row[deptCol]    ?? '').trim() : '',
        basic,
      });
    }

    if (sheetRows.length > 0) {
      results.push({ month, year, sheetName, rows: sheetRows });
    }
  }

  return results;
}
