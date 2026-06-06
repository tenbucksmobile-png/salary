// IHG CFE Payroll Burden Calculator

const UIF_RATE          = 0.01;
const UIF_MONTHLY_CAP   = 177.12;   // 1% of R17,712 earnings ceiling
const SDL_RATE          = 0.01;
const PF_RATE           = 0.07;     // Provident Fund — 7% both EE and ER
const MEALS_MANAGER     = 380;
const MEALS_STANDARD    = 330;
const LEAVE_DAYS_SA     = 24;
const LEAVE_DAYS_BW     = 21;
const CALENDAR_DAYS_PA  = 365;

export function isBotswana(country: string): boolean {
  const c = country.toLowerCase();
  return c.includes('botswana') || c === 'bw';
}

export function isManager(title: string | null): boolean {
  return /manager|mngr|mgr/i.test(title ?? '');
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface BurdenResult {
  // Employee deduction side
  provident_employee: number;
  uif_employee: number;
  total_deductions: number;
  net_salary: number;
  // Company contribution side
  provident_company: number;
  uif_company: number;
  sdl_company: number;
  wca_company: number;
  // Provisions
  staff_meals: number;
  leave_days: number;
  leave_accrual: number;
  // Rolled-up totals
  total_company_contrib: number;
  total_payroll_burden: number;
  total_cost: number;
}

export interface BurdenInput {
  basic: number;
  totalEarnings: number;
  jobTitle: string | null;
  country: string;
  wcaRate: number;
  // Pass through values we do not auto-calculate (medical, ancilla — imported separately)
  taxPaye: number;
  medicalEmployee: number;
  medicalCompany: number;
  ancillaEmployee: number;
  ancillaCompany: number;
  // Provisions we are omitting for now — pass current values so totals stay correct
  bonusProvision: number;
  leaveProvision: number;
  otherCompanyContrib: number;
  mgmtIncentive: number;
  bonusAccrualDec: number;
  bonusAccrualJuly: number;
}

export function calculateBurden(input: BurdenInput): BurdenResult {
  const bw      = isBotswana(input.country);
  const manager = isManager(input.jobTitle);

  // ── Provident Fund ───────────────────────────────────────────────────────
  const provident_employee = r2(input.basic * PF_RATE);
  const provident_company  = r2(input.basic * PF_RATE);

  // ── UIF (SA only) ────────────────────────────────────────────────────────
  const uifBase     = Math.min(input.basic, UIF_MONTHLY_CAP / UIF_RATE);
  const uif_employee = bw ? 0 : r2(Math.min(uifBase * UIF_RATE, UIF_MONTHLY_CAP));
  const uif_company  = bw ? 0 : r2(Math.min(uifBase * UIF_RATE, UIF_MONTHLY_CAP));

  // ── SDL + WCA (SA only) ──────────────────────────────────────────────────
  const sdl_company = bw ? 0 : r2(input.totalEarnings * SDL_RATE);
  const wca_company = bw ? 0 : r2(input.totalEarnings * input.wcaRate);

  // ── Staff Meals ──────────────────────────────────────────────────────────
  const staff_meals = manager ? MEALS_MANAGER : MEALS_STANDARD;

  // ── Leave accrual ────────────────────────────────────────────────────────
  const leaveDaysPA  = bw ? LEAVE_DAYS_BW : LEAVE_DAYS_SA;
  const leave_days   = r2(leaveDaysPA / 12);
  const leave_accrual = r2(input.basic * leaveDaysPA / CALENDAR_DAYS_PA);

  // ── Employee totals ──────────────────────────────────────────────────────
  const total_deductions = r2(
    input.taxPaye + uif_employee + input.medicalEmployee +
    input.ancillaEmployee + provident_employee
  );
  const net_salary = r2(input.totalEarnings - total_deductions);

  // ── Company contribution total ────────────────────────────────────────────
  const total_company_contrib = r2(
    uif_company + input.medicalCompany + provident_company +
    input.ancillaCompany + sdl_company + wca_company + input.otherCompanyContrib
  );

  // ── Payroll burden total ──────────────────────────────────────────────────
  const total_payroll_burden = r2(
    total_company_contrib +
    staff_meals +
    input.bonusProvision +
    input.leaveProvision +
    leave_accrual +
    input.mgmtIncentive +
    input.bonusAccrualDec +
    input.bonusAccrualJuly
  );

  const total_cost = r2(input.totalEarnings + total_payroll_burden);

  return {
    provident_employee,
    uif_employee,
    total_deductions,
    net_salary,
    provident_company,
    uif_company,
    sdl_company,
    wca_company,
    staff_meals,
    leave_days,
    leave_accrual,
    total_company_contrib,
    total_payroll_burden,
    total_cost,
  };
}
