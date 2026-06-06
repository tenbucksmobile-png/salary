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
}

function parseTSVDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const month = TSV_MONTH_MAP[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

// Detect whether a tabular employee file is TSV or CSV
function detectDelimiter(firstLine: string): '\t' | ',' {
  const tabs   = (firstLine.match(/\t/g)  ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs >= commas ? '\t' : ',';
}

// Split a CSV line correctly (handles quoted fields with commas inside)
function splitCSVLine(line: string, delim: '\t' | ','): string[] {
  if (delim === '\t') return line.split('\t');
  const cols: string[] = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

export function isTabularEmployeeFile(firstLine: string): boolean {
  const l = firstLine.toLowerCase().replace(/"/g, '');
  return l.startsWith('surname') && (l.includes('gross') || l.includes('salary'));
}

// Keep old export name for compatibility
export const isTSVEmployeeFile = isTabularEmployeeFile;

export function parseTSVEmployeeFile(text: string): { employees: TSVEmployee[]; errors: string[] } {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const delim = detectDelimiter(lines[0] ?? '');
  const errors: string[] = [];
  const employees: TSVEmployee[] = [];

  // Find column indices from header (flexible — column order may vary)
  const header = splitCSVLine(lines[0], delim).map(h => h.trim().replace(/"/g, '').toLowerCase());
  const idx = {
    surname:   header.findIndex(h => h === 'surname'),
    firstName: header.findIndex(h => h === 'name' || h === 'first name' || h === 'firstname'),
    department:header.findIndex(h => h.includes('department') || h.includes('dept')),
    jobTitle:  header.findIndex(h => h.includes('title') || h.includes('position')),
    startDate: header.findIndex(h => h.includes('start') || h.includes('date') || h.includes('commencement')),
    gross:     header.findIndex(h => h.includes('gross') || (h.includes('salary') && !h.includes('net'))),
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
      grossSalary:    parseFloat(get('gross').replace(/[\s,R]/g, '')) || 0,
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
