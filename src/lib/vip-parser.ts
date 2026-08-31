// VIP Premier Report 710 (Payslip Register) parser
// Format: fixed-width text, employees separated by ====...==== lines

import { nameTokens } from './recon-parsers';

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

// Header cells may come from either human-readable exports ("First Name", "Grade")
// or snake_case DB-column-style exports ("first_name", "grade_label") — normalise
// underscores to spaces so every keyword match below handles both.
function normalizeHeaderCell(h: string): string {
  return h.trim().replace(/"/g, '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isMedicalAidFile(firstLine: string): boolean {
  const l = normalizeHeaderCell(firstLine);
  const hasName    = l.includes('surname') || l.includes('first name') || l.includes('name');
  const hasMedical = l.includes('medical');
  const hasGross   = l.includes('gross') || l.includes('salary') || l.includes('earnings');
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
  const header = splitCSVLine(lines[0], delim).map(normalizeHeaderCell);

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
  const l = normalizeHeaderCell(firstLine);
  const hasName   = l.includes('surname') || l.includes('first name') || l.includes('name');
  const hasSalary = l.includes('gross')   || l.includes('salary') || l.includes('earnings');
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
  // Comma present, no period: could be a European decimal comma ("652,5") or a
  // thousands separator ("2,400"). A thousands-grouped number always has
  // exactly 3 digits after each comma (optionally repeated, e.g. "1,234,567");
  // a decimal comma has 1-2 trailing digits and only ever appears once. Only
  // the former shape is treated as thousands grouping — anything else falls
  // back to decimal-comma interpretation.
  if (clean.includes(',') && !clean.includes('.')) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(clean)) {
      return parseFloat(clean.replace(/,/g, '')) || 0;
    }
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
  const header = splitCSVLine(lines[0], delim).map(normalizeHeaderCell);
  const idx = {
    surname:   header.findIndex(h => h === 'surname' || h === 'surnmae' || h === 'last name' || h === 'lastname'),
    firstName: header.findIndex(h => h === 'name' || h === 'first name' || h === 'firstname'),
    // Some exports (e.g. "Emp Code, Employee Name, Basic Salary") give one
    // combined "Employee Name" column instead of separate surname/first name —
    // split it token-wise below, same convention as the Leave Balance parser.
    fullName:  header.findIndex(h => h === 'employee name' || h === 'full name'),
    department:header.findIndex(h => h.includes('department') || h.includes('dept')),
    jobTitle:  header.findIndex(h => h.includes('title') || h.includes('position')),
    startDate: header.findIndex(h => h.includes('start') || h.includes('date') || h.includes('commencement')),
    gross:     header.findIndex(h => h.includes('gross') || h.includes('earnings') || (h.includes('salary') && !h.includes('net'))),
    grade:     header.findIndex(h => h === 'grade' || h === 'grade label' || h === 'gradelabel'),
    medical:   header.findIndex(h => h.includes('medical')),
    idNumber:  header.findIndex(h => h.includes('omang') || h === 'id number' || h === 'id_number' || h === 'id no' || h === 'national id' || h.includes('identity')),
    empCode:   header.findIndex(h => h === 'emp code' || h === 'employee code' || h === 'emp no' || h === 'employee no' || h === 'staff no' || h === 'staff code' || h === 'emp #' || h === 'emp#'),
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delim).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.every(c => !c)) continue;
    const get = (k: keyof typeof idx) => idx[k] >= 0 ? cols[idx[k]] ?? '' : '';

    let surname = get('surname');
    let firstName = get('firstName');
    if (!surname && !firstName && idx.fullName >= 0) {
      // Combined name columns run Title FirstName Surname (e.g. "MR Modimoosi
      // Lala Baakile") — strip the salutation, last token is the surname,
      // everything before it is the first name.
      const toTitle = (s: string) => s.split(' ').filter(Boolean).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
      const tokens = nameTokens(get('fullName'));
      if (tokens.length === 1) {
        surname = toTitle(tokens[0]);
      } else if (tokens.length > 1) {
        surname = toTitle(tokens[tokens.length - 1]);
        firstName = toTitle(tokens.slice(0, -1).join(' '));
      }
    }
    if (!surname) continue;
    employees.push({
      surname,
      firstName,
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

// ─── Leave Balance Import (annual, July) ─────────────────────────────────────
// A narrow, dedicated file — name/code + a leave balance in days. Must NOT
// match gross/salary so it can't collide with isMedicalAidFile /
// isTabularEmployeeFile earlier in the detection chain.

export function isLeaveBalanceFile(firstLine: string): boolean {
  const l = normalizeHeaderCell(firstLine);
  const hasName    = l.includes('surname') || l.includes('first name') || l.includes('name');
  const hasLeave   = l.includes('leave');
  const hasSalary  = l.includes('gross') || l.includes('salary') || l.includes('earnings');
  return hasName && hasLeave && !hasSalary;
}

export interface LeaveBalanceEntry {
  surname: string;
  firstName: string;
  employeeCode: string;
  leaveBalanceDays: number;
}

export function parseLeaveBalanceFile(text: string): { employees: LeaveBalanceEntry[]; errors: string[] } {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const delim = detectDelimiter(lines[0] ?? '');
  const header = splitCSVLine(lines[0], delim).map(normalizeHeaderCell);

  const idx = {
    surname:   header.findIndex(h => h === 'surname' || h === 'surnmae' || h === 'last name' || h === 'lastname'),
    firstName: header.findIndex(h => h === 'first name' || h === 'firstname'),
    // Some exports (e.g. "Code,Name,Leave") give one combined "Name" column
    // instead of separate surname/first name — split it token-wise below.
    fullName:  header.findIndex(h => h === 'name'),
    empCode:   header.findIndex(h => h === 'emp code' || h === 'employee code' || h === 'emp no' || h === 'employee no' || h === 'staff no' || h === 'staff code' || h === 'emp #' || h === 'emp#' || h === 'code'),
    leave:     header.findIndex(h => h.includes('leave')),
  };
  // A bare "Name" header alongside a separate Surname column (e.g.
  // "Code,Name,Surname,Leave") is the first-name half, not a combined full
  // name — only treat it as combined when there's no Surname column to pair
  // it with. Mirrors the same disambiguation already used for Afritec/Bodulo.
  if (idx.surname >= 0 && idx.firstName < 0 && idx.fullName >= 0) {
    idx.firstName = idx.fullName;
    idx.fullName = -1;
  }

  const employees: LeaveBalanceEntry[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delim).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.every(c => !c)) continue;
    const get = (k: keyof typeof idx) => idx[k] >= 0 ? cols[idx[k]] ?? '' : '';

    let surname = get('surname');
    let firstName = get('firstName');
    if (!surname && !firstName) {
      // Combined "Name" columns in these files run Title FirstName Surname
      // (e.g. "MISS Masego Maxao") — same convention as
      // reconciliation's splitNameForNewEmployee: strip the salutation,
      // last token is the surname, everything before it is the first name.
      const toTitle = (s: string) => s.split(' ').filter(Boolean).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
      const tokens = nameTokens(get('fullName'));
      if (tokens.length === 1) {
        surname = toTitle(tokens[0]);
      } else if (tokens.length > 1) {
        surname = toTitle(tokens[tokens.length - 1]);
        firstName = toTitle(tokens.slice(0, -1).join(' '));
      }
    }
    if (!surname) continue;
    employees.push({
      surname,
      firstName,
      employeeCode:      get('empCode'),
      leaveBalanceDays:  parseTabularAmount(get('leave')),
    });
  }
  return { employees, errors };
}

// ─── Employee Code Update (annual/ad-hoc re-code) ────────────────────────────
// A narrow, dedicated file — name + a new employee code, nothing else. Used to
// assign/replace employee_code for hotels like CSL/NL whose codes were cleared
// (migration 014). Must NOT match gross/salary/id/leave so it can't collide
// with the other tabular detectors earlier in the detection chain.

export function isEmpCodeUpdateFile(firstLine: string): boolean {
  const l = normalizeHeaderCell(firstLine);
  const hasSurname = l.includes('surname');
  const hasEmpCode = l.includes('empcode') || l.includes('emp code');
  const hasSalary  = l.includes('gross') || l.includes('salary') || l.includes('earnings');
  const hasId      = l.includes('omang') || l.includes('id number') || l.includes('national id') || l.includes('identity');
  const hasLeave   = l.includes('leave');
  const hasMedical = l.includes('medical');
  return hasSurname && hasEmpCode && !hasSalary && !hasId && !hasLeave && !hasMedical;
}

export interface EmpCodeUpdateEntry {
  surname: string;
  firstName: string;
  newEmployeeCode: string;
}

export function parseEmpCodeUpdateFile(text: string): { employees: EmpCodeUpdateEntry[]; errors: string[] } {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const delim = detectDelimiter(lines[0] ?? '');
  const header = splitCSVLine(lines[0], delim).map(normalizeHeaderCell);

  const idx = {
    surname:   header.findIndex(h => h === 'surname' || h === 'surnmae' || h === 'last name' || h === 'lastname'),
    firstName: header.findIndex(h => h === 'name' || h === 'first name' || h === 'firstname'),
    empCode:   header.findIndex(h => h === 'empcode' || h === 'emp code' || h === 'employee code' || h === 'new emp code' || h === 'new employee code'),
  };

  const employees: EmpCodeUpdateEntry[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delim).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.every(c => !c)) continue;
    const get = (k: keyof typeof idx) => idx[k] >= 0 ? cols[idx[k]] ?? '' : '';
    const surname = get('surname');
    const newEmployeeCode = get('empCode');
    if (!surname || !newEmployeeCode) continue;
    employees.push({ surname, firstName: get('firstName'), newEmployeeCode });
  }
  return { employees, errors };
}

// ─── Omang / National ID Update (ad-hoc — CSL/NL style code+ID sheets) ───────
// A narrow, dedicated file — employee code + Omang number, nothing else. Unlike
// the generic HR List format (which requires a separate Surname column), files
// like NL's Omang sheet give one combined "Name" column ("MISS Kenosi Haake")
// with an inconsistent title/first/surname word order that can't be reliably
// split — so this format matches by employee code ONLY and patches ONLY
// id_number, the same "narrow update, one column" pattern as EmpCodeUpdateFile
// above. Must NOT have a surname column (that's the generic HR List/CSL Omang
// shape, already handled by isTabularEmployeeFile) or gross/leave/medical data.

export function isOmangUpdateFile(firstLine: string): boolean {
  const l = normalizeHeaderCell(firstLine);
  const hasCode    = l.includes('code');
  const hasOmang   = l.includes('omang') || l.includes('id number') || l.includes('national id') || l.includes('identity');
  const hasSurname = l.includes('surname');
  const hasSalary  = l.includes('gross') || l.includes('salary') || l.includes('earnings');
  const hasLeave   = l.includes('leave');
  const hasMedical = l.includes('medical');
  return hasCode && hasOmang && !hasSurname && !hasSalary && !hasLeave && !hasMedical;
}

export interface OmangUpdateEntry {
  employeeCode: string;
  idNumber: string;
}

export function parseOmangUpdateFile(text: string): { employees: OmangUpdateEntry[]; errors: string[] } {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const delim = detectDelimiter(lines[0] ?? '');
  const header = splitCSVLine(lines[0], delim).map(normalizeHeaderCell);

  const idx = {
    empCode: header.findIndex(h => h === 'code' || h === 'emp code' || h === 'employee code' || h === 'emp no' || h === 'employee no' || h === 'staff no' || h === 'staff code' || h === 'emp #' || h === 'emp#'),
    idNumber: header.findIndex(h => h.includes('omang') || h === 'id number' || h === 'id_number' || h === 'id no' || h === 'national id' || h.includes('identity')),
  };

  const employees: OmangUpdateEntry[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delim).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.every(c => !c)) continue;
    const get = (k: keyof typeof idx) => idx[k] >= 0 ? cols[idx[k]] ?? '' : '';
    const employeeCode = get('empCode');
    const idNumber = get('idNumber').replace(/\s+/g, '');
    if (!employeeCode || !idNumber) continue;
    employees.push({ employeeCode, idNumber });
  }
  return { employees, errors };
}

// ─── VIP Personal Information Report (RPRT552-style) ─────────────────────────
// A block-per-employee text export from the VIP payroll system ("EMPLOYEE
// SELF-SERVICE" style change form) — one block per employee starting with
// "EMP CODE: <code>", each field on its own two-column line: a label, the
// current VIP value, then a blank "MAKE CHANGES WHERE OUTDATED" fill-in column
// (a run of underscores). Only Surname/First Name/Initials/ID Number are
// extracted; every other field (bank details, address, tax directive, etc.) is
// ignored — this format exists here solely to backfill Omang numbers.
//
// A field's VALUE column is only present when non-blank — the label is always
// followed by ample padding before the underscore fill-in column, so a blank
// field's line has just two whitespace-run-separated segments (label,
// placeholder) while a populated one has three (label, value, placeholder).
// Splitting each line on runs of 2+ spaces and checking segment count is far
// more robust than a regex trying to capture-or-not the value directly, since
// \s (used for the "at least this much padding" gap) also matches the newline
// between lines, which made lazy capture spill across line boundaries.

export function isVipPersonalInfoFile(firstLine: string): boolean {
  const l = firstLine.toUpperCase();
  return l.includes('EMP CODE:') && l.includes('EXISTING INFORMATION');
}

export interface VipPersonalInfoEntry {
  employeeCode: string;
  surname: string;
  firstName: string;
  idNumber: string;
}

function vipInfoFieldValue(blockLines: string[], label: string): string {
  const line = blockLines.find(l => l.replace(/^[*$#\s]+/, '').startsWith(label));
  if (!line) return '';
  const parts = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[1] : '';
}

export function parseVipPersonalInfoFile(text: string): { employees: VipPersonalInfoEntry[]; errors: string[] } {
  const blocks = text.split(/(?=EMP CODE:)/).filter(b => b.trim().startsWith('EMP CODE:'));
  const employees: VipPersonalInfoEntry[] = [];
  const errors: string[] = [];

  for (const block of blocks) {
    const codeMatch = block.match(/EMP CODE:\s*(\S+)/);
    const employeeCode = codeMatch?.[1] ?? '';
    if (!employeeCode) continue;
    const lines = block.split(/\r?\n/);
    const surname = vipInfoFieldValue(lines, 'Surname:');
    const firstName = vipInfoFieldValue(lines, 'First Name:') || vipInfoFieldValue(lines, 'Initials');
    const idNumber = vipInfoFieldValue(lines, 'ID Number:').replace(/\s+/g, '');
    if (!surname || !idNumber) continue;
    employees.push({ employeeCode, surname, firstName, idNumber });
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
