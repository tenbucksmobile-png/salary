export interface Hotel {
  id: string;
  name: string;
  short_code: string;
  country: string;
  wca_rate: number;
  created_at: string;
}

export interface Employee {
  id: string;
  hotel_id: string;
  employee_code: string;
  surname: string;
  first_name: string;
  aka: string | null;
  id_number: string | null;
  job_title: string | null;
  department_code: string | null;
  paypoint: string | null;
  category: number | null;
  job_grade: number | null;
  grade_label: string | null;
  employment_date: string | null;
  status: 'active' | 'terminated' | 'on_leave';
  comments: string | null;
  nmw_applicable: boolean;
  created_at: string;
  updated_at: string;
}

export interface SalaryRecord {
  id: string;
  employee_id: string;
  import_id: string | null;
  period_month: number;
  period_year: number;
  // Earnings
  basic_salary: number;
  allowances: Record<string, number>;
  total_earnings: number;
  // Employee deductions
  tax_paye: number;
  uif_employee: number;
  medical_employee: number;
  ancilla_employee: number;
  provident_employee: number;
  total_deductions: number;
  // Core company contributions
  uif_company: number;
  medical_company: number;
  provident_company: number;
  sdl_company: number;
  ancilla_company: number;
  total_company_contrib: number;
  // Payroll burden & provisions
  wca_company: number;
  staff_meals: number;
  bonus_provision: number;
  incentive: number;
  leave_provision: number;
  other_company_contrib: number;
  total_payroll_burden: number;
  total_cost: number;
  // Leave & bonus accruals
  leave_days: number;
  leave_accrual: number;
  bonus_payout_factor: number;
  bonus_accrual_dec: number;
  bonus_accrual_july: number;
  mgmt_incentive: number;
  // Increase scenario fields
  increase_amount: number;
  adjustment: number;
  increase_pct: number;
  new_basic: number;
  new_ctc: number;
  // Summary
  net_salary: number;
  ctc: number;
  created_at: string;
}

export interface PayrollImport {
  id: string;
  hotel_id: string;
  filename: string;
  period_month: number;
  period_year: number;
  employees_added: number;
  employees_updated: number;
  employees_flagged: number;
  status: 'confirmed' | 'rejected';
  imported_at: string;
}

export interface IncreaseScenario {
  id: string;
  name: string;
  description: string | null;
  effective_date: string;
  status: 'draft' | 'committed';
  created_at: string;
  committed_at: string | null;
}

export interface ScenarioLine {
  id: string;
  scenario_id: string;
  employee_id: string;
  hotel_id: string;
  increase_pct: number;
  current_basic: number;
  new_basic: number;
  increase_amount: number;
  current_ctc: number;
  new_ctc: number;
}

// Joined view type
export interface EmployeeWithSalary extends Employee {
  hotel?: Hotel;
  latest_salary?: SalaryRecord;
}

// Dashboard stat per hotel
export interface HotelStats {
  hotel: Hotel;
  headcount: number;
  total_basic: number;
  total_ctc: number;
  total_earnings: number;
  last_import: string | null;
  by_grade: Record<string, number>;
}
