// IHG CFE Payroll Burden Calculator

const UIF_RATE          = 0.01;
const UIF_MONTHLY_CAP   = 177.12;   // 1% of R17,712 earnings ceiling
const SDL_RATE          = 0.01;
const PF_RATE             = 0.07;   // Provident Fund EE + ER — SA
const PF_EE_BW            = 0.05;   // Botswana EE — fixed 5%
const PF_ER_BW_JUNIOR     = 0.045;  // Botswana ER: < 5 years service
const PF_ER_BW_SENIOR     = 0.09;   // Botswana ER: >= 5 years service
const PF_ER_APA_DIRECTOR  = 0.14;   // APA Director ER: 14% of gross earnings
const MEALS_MANAGER     = 380;
const MEALS_STANDARD    = 330;
const LEAVE_DAYS_SA     = 24;
const LEAVE_DAYS_BW     = 21;
const BONUS_DAYS_SA     = 30.42; // 13th cheque equivalent (SA)
const BONUS_DAYS_BW     = 26;    // 13th cheque equivalent (Botswana)
const CALENDAR_DAYS_PA  = 365;

export function isBotswana(country: string): boolean {
  const c = country.toLowerCase();
  return c.includes('botswana') || c === 'bw';
}

export function isManager(title: string | null): boolean {
  return /manager|mngr|mgr/i.test(title ?? '');
}

export function isDirector(title: string | null): boolean {
  return /director/i.test(title ?? '');
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
  // Severance accrual (Botswana, per-employee flag)
  severance: number;
  // Bonus provision (13th cheque accrual — omitted when incentive_applicable)
  bonus_provision: number;
  // Incentive provision (gross × multiplier / 12 per month)
  incentive: number;
  // Gratuity provision (gross × rate% per month)
  gratuity: number;
  // Rolled-up totals
  total_company_contrib: number;
  total_payroll_burden: number;
  total_cost: number;
  // CTC: total_earnings + ER contributions/provisions flagged for inclusion
  ctc: number;
}

export interface BurdenInput {
  basic: number;
  totalEarnings: number;
  jobTitle: string | null;
  country: string;
  wcaRate: number;
  // Hotel short code — used for entity-specific rules (e.g. APA Director PF override)
  hotelShortCode?: string;
  // Years of service — drives Botswana PF ER tier (< 5 yrs = 4.5%, >= 5 yrs = 9%)
  // and Botswana severance accrual (< 5 yrs = 1 day/month, >= 5 yrs = 2 days/month)
  yearsOfService?: number;
  // Severance accrual — Botswana only, toggled per employee
  severanceApplicable?: boolean;
  // Incentive provision — toggled per employee; multiplier 2/3/4
  incentiveApplicable?: boolean;
  incentiveMultiplier?: number;
  // Gratuity provision — toggled per employee; rate entered as % e.g. 25
  gratuityApplicable?: boolean;
  gratuityRate?: number;
  // Pass through values we do not auto-calculate (medical, ancilla — imported separately)
  taxPaye: number;
  medicalEmployee: number;
  medicalCompany: number;
  ancillaEmployee: number;
  ancillaCompany: number;
  // Provisions we are omitting for now — pass current values so totals stay correct
  leaveProvision: number;
  otherCompanyContrib: number;
  mgmtIncentive: number;
  bonusAccrualDec: number;
  bonusAccrualJuly: number;
  // Configurable rates — fall back to built-in constants when not provided
  providentEeRate?: number;
  providentErRate?: number;
  providentErRateSenior?: number;
  uifRate?: number;
  uifCap?: number;
  sdlRate?: number;
  mealsStandard?: number;
  mealsManager?: number;
  leaveDays?: number;
  bonusDays?: number;
  // CTC inclusion flags — defaults maintain current behaviour (provisions excluded from CTC)
  ctcProvidentEr?: boolean;
  ctcUifEr?: boolean;
  ctcSdl?: boolean;
  ctcWca?: boolean;
  ctcMeals?: boolean;
  ctcLeaveAccrual?: boolean;
  ctcBonus?: boolean;
  // Percentage multipliers: (basic × days/365) × pct = monthly accrual; default 1.0 = 100%
  leaveAccrualPct?: number;
  bonusProvisionPct?: number;
}

export function calculateBurden(input: BurdenInput): BurdenResult {
  const bw      = isBotswana(input.country);
  const manager = isManager(input.jobTitle);

  // Resolve configurable rates — fall back to built-in constants when not provided
  const pfEeRate_       = input.providentEeRate       ?? (bw ? PF_EE_BW        : PF_RATE);
  const pfErRateJunior_ = input.providentErRate       ?? (bw ? PF_ER_BW_JUNIOR : PF_RATE);
  const pfErRateSenior_ = input.providentErRateSenior ?? (bw ? PF_ER_BW_SENIOR : PF_RATE);
  const uifRate_        = input.uifRate               ?? UIF_RATE;
  const uifCap_         = input.uifCap                ?? UIF_MONTHLY_CAP;
  const sdlRate_        = input.sdlRate               ?? SDL_RATE;
  const mealsStd_       = input.mealsStandard         ?? MEALS_STANDARD;
  const mealsMgr_       = input.mealsManager          ?? MEALS_MANAGER;
  const leaveDaysPA_    = input.leaveDays             ?? (bw ? LEAVE_DAYS_BW : LEAVE_DAYS_SA);
  const bonusDaysPA_    = input.bonusDays             ?? (bw ? BONUS_DAYS_BW : BONUS_DAYS_SA);

  // ── Provident Fund ───────────────────────────────────────────────────────
  // SA: EE = ER = configurable (default 7%). Botswana: EE 5%, ER junior/senior split.
  // APA Director override: ER = gross_earnings * 14% (EE unchanged).
  // Botswana rule: severance_applicable employees have PF EE + ER = 0.
  const isApaDirector = input.hotelShortCode?.toUpperCase() === 'APA' && isDirector(input.jobTitle);
  const bwSeveranceNoPf = bw && !!input.severanceApplicable;
  const pfEeRate = pfEeRate_;
  const pfErRate = bw
    ? ((input.yearsOfService ?? 0) >= 5 ? pfErRateSenior_ : pfErRateJunior_)
    : pfErRateJunior_;
  const provident_employee = bwSeveranceNoPf ? 0 : r2(input.basic * pfEeRate);
  const provident_company  = bwSeveranceNoPf ? 0 : isApaDirector
    ? r2(input.totalEarnings * PF_ER_APA_DIRECTOR)
    : r2(input.basic * pfErRate);

  // ── UIF (SA only) ────────────────────────────────────────────────────────
  const uifBase     = Math.min(input.basic, uifCap_ / uifRate_);
  const uif_employee = bw ? 0 : r2(Math.min(uifBase * uifRate_, uifCap_));
  const uif_company  = bw ? 0 : r2(Math.min(uifBase * uifRate_, uifCap_));

  // ── SDL + WCA (SA only) ──────────────────────────────────────────────────
  const sdl_company = bw ? 0 : r2(input.totalEarnings * sdlRate_);
  const wca_company = bw ? 0 : r2(input.totalEarnings * input.wcaRate);

  // ── Staff Meals ──────────────────────────────────────────────────────────
  const staff_meals = manager ? mealsMgr_ : mealsStd_;

  // ── Leave accrual ────────────────────────────────────────────────────────
  // Formula: basic × (days / 365) × pct
  const leave_days    = r2(leaveDaysPA_ / 12);
  const leave_accrual = r2(input.basic * leaveDaysPA_ / CALENDAR_DAYS_PA * (input.leaveAccrualPct ?? 1));

  // ── Bonus provision (13th cheque monthly accrual) ────────────────────────
  // Formula: gross × (days / 365) × pct; skipped when incentive_applicable = true
  const bonus_provision = input.incentiveApplicable
    ? 0
    : r2(input.totalEarnings * bonusDaysPA_ / CALENDAR_DAYS_PA * (input.bonusProvisionPct ?? 1));

  // ── Severance accrual (Botswana, per-employee flag) ───────────────────────
  // < 5 yrs: 1 day/month = basic/26; >= 5 yrs: 2 days/month = (basic/26)*2
  const dailyRate = r2(input.basic / 26);
  const severance = bw && input.severanceApplicable
    ? r2(dailyRate * ((input.yearsOfService ?? 0) >= 5 ? 2 : 1))
    : 0;

  // ── Incentive provision ───────────────────────────────────────────────────
  // Annual incentive = gross × multiplier; stored as monthly accrual ÷ 12
  const incentive = input.incentiveApplicable
    ? r2(input.totalEarnings * (input.incentiveMultiplier ?? 2) / 12)
    : 0;

  // ── Gratuity provision ────────────────────────────────────────────────────
  // Monthly accrual = gross × rate%
  const gratuity = input.gratuityApplicable
    ? r2(input.totalEarnings * (input.gratuityRate ?? 0) / 100)
    : 0;

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
    bonus_provision +
    input.leaveProvision +
    leave_accrual +
    severance +
    incentive +
    gratuity +
    input.mgmtIncentive +
    input.bonusAccrualDec +
    input.bonusAccrualJuly
  );

  const total_cost = r2(input.totalEarnings + total_payroll_burden);

  // ── CTC ──────────────────────────────────────────────────────────────────
  // Defaults keep backward-compatible behaviour: ER contributions in CTC, provisions out.
  const ctc = r2(
    input.totalEarnings
    + (input.ctcProvidentEr  ?? true  ? provident_company  : 0)
    + (input.ctcUifEr        ?? true  ? uif_company        : 0)
    + (input.ctcSdl          ?? true  ? sdl_company        : 0)
    + (input.ctcWca          ?? true  ? wca_company        : 0)
    + input.medicalCompany
    + input.ancillaCompany
    + input.otherCompanyContrib
    + (input.ctcMeals        ?? false ? staff_meals        : 0)
    + (input.ctcLeaveAccrual ?? false ? leave_accrual      : 0)
    + (input.ctcBonus        ?? false ? bonus_provision     : 0)
  );

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
    bonus_provision,
    severance,
    incentive,
    gratuity,
    total_company_contrib,
    total_payroll_burden,
    total_cost,
    ctc,
  };
}
