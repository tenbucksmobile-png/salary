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

export function buildEmployeeCsv(
  employees: Employee[],
  latestSalary: Map<string, SalaryRecord>,
): string {
  const header = CSV_COLUMNS.join(',');

  const rows = employees.map(e => {
    const s = latestSalary.get(e.id);
    return [
      cell(e.employee_code),
      cell(e.surname),
      cell(e.first_name),
      cell(e.aka),
      cell(e.job_title),
      cell(e.department_code),
      cell(e.grade_label),
      cell(e.employment_date),
      cell(e.status),
      cell(e.nmw_applicable),
      cell(e.severance_applicable),
      cell(e.incentive_applicable),
      cell(e.incentive_multiplier),
      cell(e.gratuity_applicable),
      cell(e.gratuity_rate),
      cell(e.comments),
      cell(s?.period_month  ?? ''),
      cell(s?.period_year   ?? ''),
      cell(s?.basic_salary  ?? ''),
      s ? cell(s.allowances as Record<string, unknown>) : '{}',
      cell(s?.total_earnings        ?? ''),
      cell(s?.tax_paye              ?? ''),
      cell(s?.uif_employee          ?? ''),
      cell(s?.medical_employee      ?? ''),
      cell(s?.ancilla_employee      ?? ''),
      cell(s?.provident_employee    ?? ''),
      cell(s?.total_deductions      ?? ''),
      cell(s?.uif_company           ?? ''),
      cell(s?.medical_company       ?? ''),
      cell(s?.provident_company     ?? ''),
      cell(s?.sdl_company           ?? ''),
      cell(s?.ancilla_company       ?? ''),
      cell(s?.total_company_contrib ?? ''),
      cell(s?.wca_company           ?? ''),
      cell(s?.staff_meals           ?? ''),
      cell(s?.bonus_provision       ?? ''),
      cell(s?.incentive             ?? ''),
      cell(s?.leave_provision       ?? ''),
      cell(s?.other_company_contrib ?? ''),
      cell(s?.total_payroll_burden  ?? ''),
      cell(s?.total_cost            ?? ''),
      cell(s?.leave_days            ?? ''),
      cell(s?.leave_accrual         ?? ''),
      cell(s?.bonus_payout_factor   ?? ''),
      cell(s?.bonus_accrual_dec     ?? ''),
      cell(s?.bonus_accrual_july    ?? ''),
      cell(s?.mgmt_incentive        ?? ''),
      cell(s?.severance             ?? ''),
      cell(s?.gratuity              ?? ''),
      cell(s?.net_salary            ?? ''),
      cell(s?.ctc                   ?? ''),
    ].join(',');
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
  existing: { id: string; employee_code: string }[],
): { rows: RoundtripRow[]; errors: string[] } {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length < 2) return { rows: [], errors: ['File appears empty'] };

  const delim = detectDelimiter(nonEmpty[0]);
  const headers = parseCSVLine(nonEmpty[0], delim);
  const idx = (col: string) => headers.indexOf(col);
  const get = (cols: string[], col: string) => cols[idx(col)] ?? '';

  const codeMap = new Map(existing.map(e => [e.employee_code.toUpperCase(), e.id]));
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
