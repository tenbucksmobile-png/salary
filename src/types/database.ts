export interface Hotel {
  id: string;
  name: string;
  short_code: string;
  country: string;
  wca_rate: number;
  // Configurable method rates (added in 009_hotel_methods migration; null if migration not yet applied)
  provident_ee_rate?: number | null;
  provident_er_rate?: number | null;
  provident_er_rate_senior?: number | null;
  uif_rate?: number | null;
  uif_cap?: number | null;
  sdl_rate?: number | null;
  meals_standard?: number | null;
  meals_manager?: number | null;
  leave_days?: number | null;
  bonus_days?: number | null;
  ctc_provident_er?: boolean | null;
  ctc_uif_er?: boolean | null;
  ctc_sdl?: boolean | null;
  ctc_wca?: boolean | null;
  ctc_meals?: boolean | null;
  ctc_leave_accrual?: boolean | null;
  ctc_bonus?: boolean | null;
  leave_accrual_pct?: number | null;
  bonus_provision_pct?: number | null;
  created_at: string;
}

export interface Employee {
  id: string;
  hotel_id: string;
  employee_code: string | null;
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
  severance_applicable: boolean;
  incentive_applicable: boolean;
  incentive_multiplier: number;
  gratuity_applicable: boolean;
  gratuity_rate: number;
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
  // Provisions (Botswana / CFEM)
  severance: number;
  gratuity: number;
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
  status: 'draft' | 'approved' | 'applied' | 'committed';
  created_at: string;
  committed_at: string | null;
  effective_month: number | null;
  effective_year: number | null;
  applied_at: string | null;
  hotel_id?: string | null;
  settings_json?: Record<string, unknown> | null;
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

export interface AppUser {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'sub';
  hotel_ids: string[] | null;
  created_at: string;
}

// Joined view type
export interface EmployeeWithSalary extends Employee {
  hotel?: Hotel;
  latest_salary?: SalaryRecord;
}

// Reconciliation types
export type ReconUploadType = 'payroll' | 'twelve_months' | 'afritec' | 'topline' | 'furnmart' | 'cbstores' | 'bodulo' | 'medical';
export type ReconStatus = 'open' | 'submitted' | 'approved';

export interface ReconciliationPeriod {
  id: string;
  hotel_id: string;
  period_year: number;
  period_month: number;
  status: ReconStatus;
  notes: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
}

export interface ReconUpload {
  id: string;
  period_id: string;
  upload_type: ReconUploadType;
  file_name: string | null;
  parsed_data: any;
  row_count: number | null;
  total_amount: number | null;
  uploaded_at: string;
  uploaded_by: string | null;
}

export interface ReconQuery {
  id: string;
  period_id: string;
  message: string;
  created_at: string;
  author_name: string | null;
  resolved_at: string | null;
  resolver_name: string | null;
  resolved_message: string | null;
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
