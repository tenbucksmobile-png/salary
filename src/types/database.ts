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
  leave_provision_divisor?: number | null;
  // BURS-only hotel (currently just Pom Pom) — excluded from every hotel list
  // app-wide by sortHotels() unless explicitly opted back in. See BURS page.
  is_burs_only?: boolean | null;
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
  last_seen_at: string | null;
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
  allowed_tabs: string[] | null;
  created_at: string;
}

// Joined view type
export interface EmployeeWithSalary extends Employee {
  hotel?: Hotel;
  latest_salary?: SalaryRecord;
}

// Reconciliation types
export type ReconUploadType = 'payroll' | 'ftc_payroll' | 'afritec' | 'topline' | 'furnmart' | 'cbstores' | 'bodulo' | 'pension' | 'medical' | 'cfem_deductions';
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

// Terminations tracking — candidate terminations detected by comparing the DB
// active roster against a month's uploaded payroll. Never writes back to
// employees; purely a record/log. See migration 020_recon_terminations.sql.
export type ReconTerminationStatus = 'flagged' | 'confirmed' | 'reinstated';

export interface ReconTermination {
  id: string;
  hotel_id: string;
  employee_id: string | null;
  employee_name: string;
  employee_code: string | null;
  detected_year: number;
  detected_month: number;
  note: string | null;
  status: ReconTerminationStatus;
  created_at: string;
  created_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_note: string | null;
}

// Consolidation: director-facing monthly bank release sign-off. One row per
// (period, hotel, line item). system_amount is a manual override, only used
// where no automatic source exists in this app (CFEM's Basic Salary — CFEM's
// payroll is never uploaded here); bank_amount is always manual, reflecting
// what was actually paid to the bank. See migration 021_recon_consolidation.sql.
export interface ReconConsolidationEntry {
  id: string;
  period_year: number;
  period_month: number;
  hotel_short_code: string;
  line_item: string;
  system_amount: number | null;
  bank_amount: number | null;
  updated_at: string;
  updated_by: string | null;
}

// Employees tab approvals: per-record tickbox state (Basic Salary Mismatch / New
// Appointment / Termination), captured via the Employees tab's own Submit button.
// Staging/audit only — a later admin-only "commit" step reads approved=true rows from
// here and applies them to employees/salary_records. See migration 022.
export type ReconApprovalCategory = 'basic_mismatch' | 'new_appointment' | 'termination';

export interface ReconEmployeeApproval {
  id: string;
  hotel_id: string;
  period_year: number;
  period_month: number;
  category: ReconApprovalCategory;
  employee_name: string;
  employee_code: string | null;
  detail: Record<string, number> | null;
  approved: boolean;
  submitted_at: string | null;
  submitted_by: string | null;
  committed_at: string | null;
  committed_by: string | null;
  created_at: string;
  updated_at: string;
}

// Leave Provision: annual (July) leave balance import + daily-rate payout calc.
// Standalone from salary_records — see leave_accrual (forward monthly estimate)
// and leave_provision (legacy VIP passthrough), which this is unrelated to.
export interface LeaveProvision {
  id: string;
  employee_id: string;
  hotel_id: string;
  period_year: number;
  leave_balance_days: number;
  daily_rate: number;
  provision_value: number;
  basic_at_calc: number; // despite the name, this is gross salary (total_earnings, inclusive of structure) — never basic or CTC
  import_id: string | null;
  imported_at: string;
}

// Manually-entered "what's currently on the books" figure per hotel/year —
// compared against the summed leave_provisions.provision_value to compute
// the adjustment needed at year-end.
export interface LeaveProvisionBookBalance {
  id: string;
  hotel_id: string;
  period_year: number;
  book_provision: number;
  updated_at: string;
}

// Same shape as LeaveProvisionBookBalance, for the Bonus Provision page's
// Book Adjustment table.
export interface BonusProvisionBookBalance {
  id: string;
  hotel_id: string;
  period_year: number;
  book_provision: number;
  updated_at: string;
}

// Same shape again, for the Severance Provision page's Book Adjustment table.
export interface SeveranceProvisionBookBalance {
  id: string;
  hotel_id: string;
  period_year: number;
  book_provision: number;
  updated_at: string;
}

// BURS PAYE submission: one row per period per upload group ('ilg' or
// 'combined' — CSL/NL/CFEM/PomPom share one file). parsed_data holds the
// ParsedPayroll shape from recon-parsers.ts's parsePayrollXlsx().
export interface BursUpload {
  id: string;
  period_year: number;
  period_month: number;
  upload_group: 'ilg' | 'combined';
  file_name: string | null;
  parsed_data: unknown;
  uploaded_at: string;
}

// WCA reconciliation — one consolidated row per hotel per year (not a
// line-by-line ledger) summarising that year's Compensation Fund statement
// activity. The confirmed cycle: an employer submits a provisional
// assessment for the year ahead; once the actual is submitted, the
// provisional is reversed and a fresh invoice raised against actual payroll
// × the Tourism ROE % (see WcaRoeRate). Penalty is the ~10%-of-invoice
// late-submission charge; dispute_credit covers credits passed due to
// historical disputes. Closing balance for a year is computed client-side
// as: prior year's closing + opening_balance + provisional_invoice +
// actual_invoice + penalty + interest + other − reversal − payment −
// dispute_credit.
export interface WcaAnnualConsolidation {
  id: string;
  hotel_id: string;
  period_year: number;
  opening_balance: number;
  provisional_invoice: number;
  reversal: number;
  actual_invoice: number;
  penalty: number;
  interest: number;
  payment: number;
  dispute_credit: number;
  other: number;
  notes: string | null;
  updated_at: string;
}

// The company's own reconciling records — what the Fund's statement doesn't
// yet reflect: a payment made but not posted, a dispute raised, or a
// free-text discrepancy note. `period_year` is an optional tag (not a
// foreign key — there's no per-line statement data to link to).
export type WcaManualEntryType = 'payment_not_reflected' | 'dispute_raised' | 'discrepancy_note' | 'provision_held';
export type WcaManualEntryStatus = 'open' | 'resolved';

export interface WcaManualEntry {
  id: string;
  hotel_id: string;
  entry_date: string;
  period_year: number | null;
  entry_type: WcaManualEntryType;
  amount: number;
  status: WcaManualEntryStatus;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// Tourism ROE % per hotel per year — used to independently check a year's
// Actual Invoice (payroll submitted × rate%) against what the Fund billed.
export interface WcaRoeRate {
  id: string;
  hotel_id: string;
  period_year: number;
  rate_pct: number;
  updated_at: string;
}

// The company's periodic provision cascade, layered on top of the
// Reconciliation tab's Adjusted Balance. Provision Required is computed
// live (not stored) as: Adjusted Balance + accrual_not_invoiced
// − penalty_dispute_amount × penalty_risk_pct/100
// − interest_dispute_amount × interest_risk_pct/100
export interface WcaProvisionCalc {
  id: string;
  hotel_id: string;
  period_year: number;
  accrual_not_invoiced: number;
  penalty_dispute_amount: number;
  penalty_risk_pct: number;
  interest_dispute_amount: number;
  interest_risk_pct: number;
  provision_on_hand: number;
  updated_at: string;
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
