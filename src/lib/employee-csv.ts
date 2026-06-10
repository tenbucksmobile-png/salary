// Round-trip CSV: employee + salary snapshot for offsite editing and re-import

import type { Employee, SalaryRecord } from '@/types/database';

// ── Public types ──────────────────────────────────────────────────────────────

export interface RoundtripRow {
  action: 'update' | 'add';
  existingEmployeeId?: string;
  // Employee
  employeeCode: string;
  surname: string;
  firstName: string;
  aka: string;
  jobTitle: string;
  department: string;
  gradeLabel: string;
  employmentDate: string | null;
  status: string;
  nmwApplicable: boolean;
  severanceApplicable: boolean;
  incentiveApplicable: boolean;
  incentiveMultiplier: number;
  gratuityApplicable: boolean;
  gratuityRate: number;
  comments: string;
  // Salary period
  periodMonth: number;
  periodYear: number;
  // Salary fields (all columns from salary_records)
  basicSalary: number;
  allowances: Record<string, number>;
  totalEarnings: number;
  taxPaye: number;
  uifEmployee: number;
  medicalEmployee: number;
  ancillaEmployee: number;
  providentEmployee: number;
  totalDeductions: number;
  uifCompany: number;
  medicalCompany: number;
  providentCompany: number;
  sdlCompany: number;
  ancillaCompany: number;
  totalCompanyContrib: number;
  wcaCompany: number;
  staffMeals: number;
  bonusProvision: number;
  incentive: number;
  leaveProvision: number;
  otherCompanyContrib: number;
  totalPayrollBurden: number;
  totalCost: number;
  leaveDays: number;
  leaveAccrual: number;
  bonusPayoutFactor: number;
  bonusAccrualDec: number;
  bonusAccrualJuly: number;
  mgmtIncentive: number;
  severance: number;
  gratuity: number;
  netSalary: number;
  ctc: number;
}

// ── Column list (defines export order; import uses header matching) ────────────

export const CSV_COLUMNS = [
  'employee_code', 'surname', 'first_name', 'aka', 'job_title', 'department',
  'grade_label', 'employment_date', 'status', 'nmw_applicable', 'severance_applicable',
  'incentive_applicable', 'incentive_multiplier', 'gratuity_applicable', 'gratuity_rate',
  'comments', 'period_month', 'period_year', 'basic_salary', 'allowances',
  'total_earnings', 'tax_paye', 'uif_employee', 'medical_employee', 'ancilla_employee',
  'provident_employee', 'total_deductions', 'uif_company', 'medical_company',
  'provident_company', 'sdl_company', 'ancilla_company', 'total_company_contrib',
  'wca_company', 'staff_meals', 'bonus_provision', 'incentive', 'leave_provision',
  'other_company_contrib', 'total_payroll_burden', 'total_cost', 'leave_days',
  'leave_accrual', 'bonus_payout_factor', 'bonus_accrual_dec', 'bonus_accrual_july',
  'mgmt_incentive', 'severance', 'gratuity', 'net_salary', 'ctc',
] as const;

// ── Export builder ────────────────────────────────────────────────────────────

function cell(v: string | number | boolean | null | undefined | Record<string, unknown>): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    const json = JSON.stringify(v).replace(/"/g, '""');
    return `"${json}"`;
  }
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowValue(col: string, e: Employee, s: SalaryRecord | undefined): string {
  switch (col) {
    case 'employee_code':         return cell(e.employee_code);
    case 'surname':               return cell(e.surname);
    case 'first_name':            return cell(e.first_name);
    case 'aka':                   return cell(e.aka);
    case 'job_title':             return cell(e.job_title);
    case 'department':            return cell(e.department_code);
    case 'grade_label':           return cell(e.grade_label);
    case 'employment_date':       return cell(e.employment_date);
    case 'status':                return cell(e.status);
    case 'nmw_applicable':        return cell(e.nmw_applicable);
    case 'severance_applicable':  return cell(e.severance_applicable);
    case 'incentive_applicable':  return cell(e.incentive_applicable);
    case 'incentive_multiplier':  return cell(e.incentive_multiplier);
    case 'gratuity_applicable':   return cell(e.gratuity_applicable);
    case 'gratuity_rate':         return cell(e.gratuity_rate);
    case 'comments':              return cell(e.comments);
    case 'period_month':          return cell(s?.period_month         ?? '');
    case 'period_year':           return cell(s?.period_year          ?? '');
    case 'basic_salary':          return cell(s?.basic_salary         ?? '');
    case 'allowances':            return s ? cell(s.allowances as Record<string, unknown>) : '{}';
    case 'total_earnings':        return cell(s?.total_earnings        ?? '');
    case 'tax_paye':              return cell(s?.tax_paye              ?? '');
    case 'uif_employee':          return cell(s?.uif_employee          ?? '');
    case 'medical_employee':      return cell(s?.medical_employee      ?? '');
    case 'ancilla_employee':      return cell(s?.ancilla_employee      ?? '');
    case 'provident_employee':    return cell(s?.provident_employee    ?? '');
    case 'total_deductions':      return cell(s?.total_deductions      ?? '');
    case 'uif_company':           return cell(s?.uif_company           ?? '');
    case 'medical_company':       return cell(s?.medical_company       ?? '');
    case 'provident_company':     return cell(s?.provident_company     ?? '');
    case 'sdl_company':           return cell(s?.sdl_company           ?? '');
    case 'ancilla_company':       return cell(s?.ancilla_company       ?? '');
    case 'total_company_contrib': return cell(s?.total_company_contrib ?? '');
    case 'wca_company':           return cell(s?.wca_company           ?? '');
    case 'staff_meals':           return cell(s?.staff_meals           ?? '');
    case 'bonus_provision':       return cell(s?.bonus_provision       ?? '');
    case 'incentive':             return cell(s?.incentive             ?? '');
    case 'leave_provision':       return cell(s?.leave_provision       ?? '');
    case 'other_company_contrib': return cell(s?.other_company_contrib ?? '');
    case 'total_payroll_burden':  return cell(s?.total_payroll_burden  ?? '');
    case 'total_cost':            return cell(s?.total_cost            ?? '');
    case 'leave_days':            return cell(s?.leave_days            ?? '');
    case 'leave_accrual':         return cell(s?.leave_accrual         ?? '');
    case 'bonus_payout_factor':   return cell(s?.bonus_payout_factor   ?? '');
    case 'bonus_accrual_dec':     return cell(s?.bonus_accrual_dec     ?? '');
    case 'bonus_accrual_july':    return cell(s?.bonus_accrual_july    ?? '');
    case 'mgmt_incentive':        return cell(s?.mgmt_incentive        ?? '');
    case 'severance':             return cell(s?.severance             ?? '');
    case 'gratuity':              return cell(s?.gratuity              ?? '');
    case 'net_salary':            return cell(s?.net_salary            ?? '');
    case 'ctc':                   return cell(s?.ctc                   ?? '');
    default:                      return '';
  }
}

// columns defaults to the full CSV_COLUMNS list for backward-compatible round-trip exports.
// Pass a filtered list to emit only specific columns (e.g. matching the column picker selection).
export function buildEmployeeCsv(
  employees: Employee[],
  latestSalary: Map<string, SalaryRecord>,
  columns: readonly string[] = CSV_COLUMNS,
): string {
  const header = columns.join(',');
  const rows = employees.map(e => {
    const s = latestSalary.get(e.id);
    return columns.map(col => rowValue(col, e, s)).join(',');
  });
  return [header, ...rows].join('\r\n');
}

// ── Import detection & parsing ────────────────────────────────────────────────

export function isEmployeeCsvExport(firstLine: string): boolean {
  const l = firstLine.trimStart();
  return (l.startsWith('employee_code,') || l.startsWith('employee_code;')) && l.includes('period_month');
}

function detectDelimiter(headerLine: string): ',' | ';' {
  // Count occurrences; whichever appears more is the delimiter
  const commas     = (headerLine.match(/,/g)   ?? []).length;
  const semicolons = (headerLine.match(/;/g)   ?? []).length;
  return semicolons > commas ? ';' : ',';
}

function parseCSVLine(line: string, delim: ',' | ';' = ','): string[] {
  const result: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { result.push(''); break; }
    if (line[i] === '"') {
      i++;
      let field = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"')                    { i++; break; }
        else                                          { field += line[i++]; }
      }
      result.push(field);
      if (line[i] === delim) i++;
    } else {
      const end = line.indexOf(delim, i);
      if (end === -1) { result.push(line.slice(i)); break; }
      result.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return result;
}

const num = (s: string) => parseFloat(s) || 0;
const bool = (s: string) => s.trim().toUpperCase() === 'TRUE';
const str = (s: string) => s.trim();

export function parseEmployeeCsvExport(
  text: string,
  existing: { id: string; employee_code: string | null }[],
): { rows: RoundtripRow[]; errors: string[] } {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length < 2) return { rows: [], errors: ['File appears empty'] };

  const delim = detectDelimiter(nonEmpty[0]);
  const headers = parseCSVLine(nonEmpty[0], delim);
  const idx = (col: string) => headers.indexOf(col);
  const get = (cols: string[], col: string) => cols[idx(col)] ?? '';

  const codeMap = new Map(existing.filter(e => e.employee_code).map(e => [e.employee_code!.toUpperCase(), e.id]));
  const rows: RoundtripRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < nonEmpty.length; i++) {
    const cols = parseCSVLine(nonEmpty[i], delim);
    const empCode = str(get(cols, 'employee_code'));
    if (!empCode) { errors.push(`Row ${i + 1}: missing employee_code — skipped`); continue; }

    let allowances: Record<string, number> = {};
    try {
      const raw = get(cols, 'allowances');
      if (raw && raw !== '{}') allowances = JSON.parse(raw) as Record<string, number>;
    } catch {
      errors.push(`Row ${i + 1} (${empCode}): could not parse allowances — using empty`);
    }

    const existingId = codeMap.get(empCode.toUpperCase());

    rows.push({
      action:              existingId ? 'update' : 'add',
      existingEmployeeId:  existingId,
      employeeCode:        empCode,
      surname:             str(get(cols, 'surname')),
      firstName:           str(get(cols, 'first_name')),
      aka:                 str(get(cols, 'aka')),
      jobTitle:            str(get(cols, 'job_title')),
      department:          str(get(cols, 'department')),
      gradeLabel:          str(get(cols, 'grade_label')),
      employmentDate:      str(get(cols, 'employment_date')) || null,
      status:              str(get(cols, 'status')) || 'active',
      nmwApplicable:       bool(get(cols, 'nmw_applicable')),
      severanceApplicable: bool(get(cols, 'severance_applicable')),
      incentiveApplicable: bool(get(cols, 'incentive_applicable')),
      incentiveMultiplier: num(get(cols, 'incentive_multiplier')),
      gratuityApplicable:  bool(get(cols, 'gratuity_applicable')),
      gratuityRate:        num(get(cols, 'gratuity_rate')),
      comments:            str(get(cols, 'comments')),
      periodMonth:         num(get(cols, 'period_month')) || (new Date().getMonth() + 1),
      periodYear:          num(get(cols, 'period_year'))  || new Date().getFullYear(),
      basicSalary:         num(get(cols, 'basic_salary')),
      allowances,
      totalEarnings:       num(get(cols, 'total_earnings')),
      taxPaye:             num(get(cols, 'tax_paye')),
      uifEmployee:         num(get(cols, 'uif_employee')),
      medicalEmployee:     num(get(cols, 'medical_employee')),
      ancillaEmployee:     num(get(cols, 'ancilla_employee')),
      providentEmployee:   num(get(cols, 'provident_employee')),
      totalDeductions:     num(get(cols, 'total_deductions')),
      uifCompany:          num(get(cols, 'uif_company')),
      medicalCompany:      num(get(cols, 'medical_company')),
      providentCompany:    num(get(cols, 'provident_company')),
      sdlCompany:          num(get(cols, 'sdl_company')),
      ancillaCompany:      num(get(cols, 'ancilla_company')),
      totalCompanyContrib: num(get(cols, 'total_company_contrib')),
      wcaCompany:          num(get(cols, 'wca_company')),
      staffMeals:          num(get(cols, 'staff_meals')),
      bonusProvision:      num(get(cols, 'bonus_provision')),
      incentive:           num(get(cols, 'incentive')),
      leaveProvision:      num(get(cols, 'leave_provision')),
      otherCompanyContrib: num(get(cols, 'other_company_contrib')),
      totalPayrollBurden:  num(get(cols, 'total_payroll_burden')),
      totalCost:           num(get(cols, 'total_cost')),
      leaveDays:           num(get(cols, 'leave_days')),
      leaveAccrual:        num(get(cols, 'leave_accrual')),
      bonusPayoutFactor:   num(get(cols, 'bonus_payout_factor')),
      bonusAccrualDec:     num(get(cols, 'bonus_accrual_dec')),
      bonusAccrualJuly:    num(get(cols, 'bonus_accrual_july')),
      mgmtIncentive:       num(get(cols, 'mgmt_incentive')),
      severance:           num(get(cols, 'severance')),
      gratuity:            num(get(cols, 'gratuity')),
      netSalary:           num(get(cols, 'net_salary')),
      ctc:                 num(get(cols, 'ctc')),
    });
  }

  return { rows, errors };
}
