# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A web-based **HR salary management system** for 6 IHG CFE hotel properties, replacing an Excel-based salary review workflow. Built with Next.js (App Router) + Supabase + Shadcn UI. Multi-user access-controlled (admin + sub-user roles; username/password login via HMAC-signed cookie).

Core workflows:
- **Import HR List** — update employee records (names, Omang/ID, grade, department, start date) from xlsx/CSV HR lists; also writes a minimal salary record so employees appear in Salary Review. Nav tab is "Import HR List". Also supports VIP Report 710 payroll files, Medical Aid update files, round-trip employee CSV exports, and CSL Payroll Schedule xlsx workbooks
- **View & edit** employees across all 6 properties with flexible column visibility
- **Export** employees per hotel as a CSV, edit offsite, and re-import
- **Calculate payroll burden** automatically (provident fund, UIF, SDL, WCA, staff meals, leave accrual, bonus, incentive, severance, gratuity)
- **Salary review** forecasting — per-hotel % or flat increase with per-employee overrides and exclusions; save drafts persistently; commit to salary records
- **Reports** — flexible builder: pick hotels, fields, individual vs summary view, period; export to Excel or PDF
- **Reconciliation** — monthly three-way cross-check for CSL, NL, CFE: third-party statements vs payroll, prior-month headcount and salary changes; query/response workflow
- **Methods** — configure all statutory rates and CTC inclusion flags per hotel; "Save & Update All" recalculates every active employee
- **Access** — admin-only user management; assign sub-users to specific hotels

---

## Hotels

| Short Code | Country | Notes |
|-----------|---------|-------|
| IH | South Africa | InterContinental Hazyview |
| ILRB | South Africa | |
| CSL | Botswana | Chobe Safari Lodge — exempt from UIF/SDL/WCA |
| NL | Botswana | Nata Lodge — exempt from UIF/SDL/WCA |
| CFE | Botswana | exempt from UIF/SDL/WCA |
| ILG | Botswana | exempt from UIF/SDL/WCA |

Botswana hotels are detected via `hotel.country` — `isBotswana()` in `src/lib/payroll-calc.ts` is the canonical check. It matches if the lowercased country includes `"botswana"` **or** equals `"bw"`. Always use this function — never hardcode short codes for the exemption check.

The hotel seed data in `001_initial_schema.sql` uses older names and includes an "APA" entry not present in production. Trust the live `hotels` table, not the seed.

**Hotel sort order** (applied via `sortHotels()` in `src/lib/utils.ts` — use on every page that lists hotels):
African Procurement Agencies → Indaba Hotel → Indaba Lodge Richards Bay → Indaba Lodge Gaborone → CFE Management → Chobe Safari Lodge → Nata Lodge

---

## Tech Stack

- **Next.js 16** (App Router, TypeScript, React 19)
- **Supabase** — project ref `fnpfgrpaxoedzvfjrlky` (separate from all other projects)
- **Shadcn UI v4** — style: base-nova, uses `@base-ui/react`. No `asChild` on Button.
- **Tailwind CSS v4** with oklch colour tokens
- **Auth**: multi-user HMAC-SHA256 cookie; cookie payload = base64url(UserContext JSON) + "." + HMAC hex. Logic in `src/lib/auth.ts`. Password hash = `HMAC-SHA256(COOKIE_SECRET, "username:password")`.

---

## Commands

```bash
npm install
npm run dev        # localhost:3000
npm run build      # also runs TypeScript type-check (no separate tsc script)
npm run start
```

There is no dedicated `typecheck` or `lint` script — `npm run build` is the fastest way to catch type errors. There are no tests and no test runner configured.

**Deploy to Vercel** (corporate SSL proxy requires the env var for the CLI too):
```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED="0"; vercel --prod
```
Production URL: **https://ihg-salary-topaz.vercel.app** — Vercel project `marius-projects-ce903021/ihg-salary`, connected to `tenbucksmobile-png/salary` on GitHub (auto-deploys on push to `master`).

---

## Critical Rules

- **Never run `supabase db push --linked`** — apply migrations individually via Supabase Dashboard → SQL Editor.
- **`SITE_PASSWORD` must be quoted in `.env.local` if it contains `#`** — unquoted `#` is treated as a comment: `SITE_PASSWORD="#IHG_HRMngmt2026"`.
- **`$VAR` strings in env blocks are not shell-expanded** — keep secrets in `.env.local` only.
- **RLS uses `anon_all` policies** — security is enforced by the middleware cookie check, not Supabase auth.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0` must be in `.env.local`** — the dev machine has a corporate SSL inspection proxy; Node.js cannot verify Supabase's TLS cert without this. Browser-side Supabase calls work fine; only server-side API routes and server components are affected. Also required as a shell env var when running the Vercel CLI (`$env:NODE_TLS_REJECT_UNAUTHORIZED="0"; vercel --prod`).

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=https://fnpfgrpaxoedzvfjrlky.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SITE_PASSWORD="<password>"        # wrap in quotes if it contains special chars
COOKIE_SECRET=<32+ char random>   # used for HMAC cookie signing
NODE_TLS_REJECT_UNAUTHORIZED=0    # required — corporate SSL proxy on dev machine
```

---

## Architecture Notes

**Server vs client split**: `src/app/dashboard/page.tsx` (the main dashboard) is a trivial React Server Component — it does no data fetching of its own and just renders `SalarySummaryTable`. `SalarySummaryTable.tsx` is `'use client'` and runs its own parallel Supabase queries client-side (hotels, employees, salary records, and scenarios). All other dashboard sub-pages (`employees/`, `import/`, `methods/`, `salary-review/`) are `'use client'` and query Supabase directly via `src/lib/supabase/client.ts`.

**`latest_salary` DB view** — this view exists in the database but is not queried by the app. All pages compute the latest salary record client-side by sorting `salary_records` by `period_year` desc / `period_month` desc and taking the first match per `employee_id`.

**Salary records are period-keyed** — the unique constraint is `(employee_id, period_year, period_month)`. Imports upsert on this key. The Salary Review commit creates a new record for the target month.

**Auth flow**: `POST /api/auth/login` queries the `users` table, verifies HMAC password hash, issues signed cookie (`ihg-salary-auth`, 30-day max-age). `middleware.ts` verifies the cookie and enforces role-based access. `POST /api/auth/logout` clears the cookie. `GET /api/auth/me` returns the current `UserContext`. Admin CRUD for users at `POST/PATCH/DELETE /api/access`.

**UserContext** (encoded in cookie): `{ id, username, role: 'admin'|'sub', hotelIds: string[]|null, allowedTabs: string[]|null }`. `hotelIds: null` means all hotels (admin). `allowedTabs: null` means "use `DEFAULT_SUB_TABS`" for a sub user (admins ignore this field — always full access). See Access Control below for the full configurable-tabs system.

**Bootstrap**: if the `users` table is empty when login is attempted, the first login auto-creates an admin using the submitted credentials + `SITE_PASSWORD` check.

**Composite types in `types/database.ts`**: `EmployeeWithSalary` extends `Employee` with optional `hotel?: Hotel` and `latest_salary?: SalaryRecord` — used across dashboard pages. `HotelStats` is defined in `database.ts` but nothing in the dashboard imports it any longer (the per-hotel `HotelCard`/`getHotelStats` breakdown that used to justify it was removed — see the Dashboard section below); it should be considered stale/dead.

**Dashboard "Current Gross"/"New Gross" figures**: `scenario_lines.current_basic`/`new_basic` store `basic_salary` only (excludes the structure allowance — see "Basic Salary = Total Earnings − allowances.structure" above). `SalarySummaryTable.tsx`'s `computeEmployeeFigures()` helper adds back `sal.allowances?.structure ?? 0` to these values to reconstruct true gross, since structure doesn't change with an increase. When no scenario line exists for an employee, `sal.total_earnings` is used directly instead. This same helper is shared by both the per-hotel rollup and the per-employee drill-down (see below), so the two always agree.

---

## Database

### Key Tables

| Table | Purpose |
|-------|---------|
| `hotels` | 6 properties; `country`, `short_code`, `wca_rate`, + configurable method rate columns (see migration 009) |
| `employees` | One row per employee; `hotel_id`, `employee_code` (**nullable** — ANO positions have no employee yet; CSL and NL have no codes), `surname`, `first_name`, `aka`, `id_number`, `job_title`, `department_code`, `paypoint`, `category`, `job_grade`, `grade_label`, `employment_date`, `status` (`active`/`terminated`/`on_leave`), `nmw_applicable`, `severance_applicable`, `incentive_applicable`, `incentive_multiplier`, `gratuity_applicable`, `gratuity_rate`, `comments` |
| `salary_records` | One row per employee per payroll period; full earnings, deductions, contributions, provisions, accruals |
| `payroll_imports` | Audit log of each import |
| `increase_scenarios` | Salary review scenarios; `status` = `draft`/`approved`/`applied`/`committed`; `hotel_id` identifies per-hotel draft; `settings_json` stores hotel-level UI state for draft reconstruction |
| `scenario_lines` | One row per employee per scenario; stores before/after basic and CTC |
| `users` | App users; `username`, `password_hash` (HMAC), `role` (`admin`/`sub`), `hotel_ids` (uuid[], null = all) |

### Migrations

Applied to production via Supabase Dashboard → SQL Editor only. Files in `supabase/migrations/`:

| File | Purpose |
|------|---------|
| `001_initial_schema.sql` | Hotels, employees, salary_records, payroll_imports, increase_scenarios, scenario_lines, latest_salary view |
| `002_financial_columns.sql` | Payroll burden columns (wca, meals, bonus, leave, accruals, increase scenarios) |
| `003_hotel_rates.sql` | `wca_rate` column on `hotels` |
| `004_severance.sql` | `severance` column on `salary_records` |
| `005_severance_applicable.sql` | `severance_applicable` on `employees` |
| `006_cfem_hotel.sql` | CFE/ILG hotel entries |
| `007_incentive_gratuity.sql` | `incentive_applicable`, `incentive_multiplier`, `gratuity_applicable`, `gratuity_rate` on `employees`; `incentive`, `gratuity` on `salary_records` |
| `008_scenario_workflow.sql` | `effective_month`, `effective_year`, `applied_at` on `increase_scenarios`; migrates `committed` → `applied` |
| `009_hotel_methods.sql` | Configurable rate columns + CTC flags on `hotels` (see Methods section) |
| `010_accrual_pct.sql` | `leave_accrual_pct` + `bonus_provision_pct` decimal columns on `hotels` (default 1.0 = 100%) |
| `011_users.sql` | `users` table for multi-user auth |
| `012_draft_scenarios.sql` | `hotel_id` + `settings_json` on `increase_scenarios` for per-hotel persistent drafts |
| `013_employee_code_nullable.sql` | `ALTER TABLE employees ALTER COLUMN employee_code DROP NOT NULL` — allows ANO positions without an employee |
| `014_clear_csl_nl_employee_codes.sql` | Clears `employee_code` to NULL for all CSL and NL employees (codes were incorrectly generated) |
| `015_reconciliation.sql` | `reconciliation_periods`, `recon_uploads`, `recon_queries` tables for the monthly payroll reconciliation workflow |
| `016_user_allowed_tabs.sql` | `allowed_tabs text[]` on `users` — per-sub-user configurable tab access (Employees/Import/Reconciliation), backfilled to the prior fixed set for existing sub users |
| `017_employee_last_seen.sql` | `last_seen_at timestamptz` on `employees` — tracks the last full-roster import that matched/added the employee; powers the "not in last import" red flag on the Employees page |
| `018_ftc_to_fixed_term.sql` | Updates `employees.grade_label = 'FTC'` rows to `'Fixed Term'` (canonical grade value rename) |
| `019_leave_provisions.sql` | `hotels.leave_provision_divisor`; new `leave_provisions` table (annual leave balance provisioning — see Leave Provision section) |
| `020_recon_terminations.sql` | New `recon_terminations` table — Reconciliation's Terminations log (see Reconciliation section) |
| `021_recon_consolidation.sql` | New `recon_consolidation` table — Reconciliation's Consolidation tab (director bank-release sign-off) |
| `022_recon_employee_approvals.sql` | New `recon_employee_approvals` table — Reconciliation Employees tab's per-record Submit tickbox state |
| `023_recon_approvals_commit.sql` | Adds `committed_at`/`committed_by` to `recon_employee_approvals` — tracks the admin-only Commit step |

### `hotels` configurable method columns (from migration 009)

All rates stored as decimals (e.g. 0.07 = 7%). All displayed as percentages in the Methods UI.

`provident_ee_rate`, `provident_er_rate`, `provident_er_rate_senior` (BW tenure split), `uif_rate`, `uif_cap` (R amount), `sdl_rate`, `meals_standard`, `meals_manager`, `leave_days`, `bonus_days`, `leave_accrual_pct`, `bonus_provision_pct`

`leave_provision_divisor` (migration 019) is a related but separate configurable rate — it feeds the standalone Leave Provision tab, not `calculateBurden()`. See the Leave Provision section below.

CTC inclusion flags (boolean, default false for provisions): `ctc_provident_er`, `ctc_uif_er`, `ctc_sdl`, `ctc_wca`, `ctc_meals`, `ctc_leave_accrual`, `ctc_bonus`

### `salary_records` column groups

**Earnings**: `basic_salary`, `allowances` (jsonb), `total_earnings`
**Employee deductions**: `tax_paye`, `uif_employee`, `medical_employee`, `ancilla_employee`, `provident_employee`, `total_deductions`
**Company contributions**: `uif_company`, `medical_company`, `provident_company`, `sdl_company`, `ancilla_company`, `total_company_contrib`
**Provisions**: `wca_company`, `staff_meals`, `bonus_provision`, `incentive`, `leave_provision`, `leave_accrual`, `other_company_contrib`, `total_payroll_burden`, `total_cost`

**`allowances` JSONB shape** — stores arbitrary named allowances from VIP imports (`Record<string, number>`). The special key `structure` holds the Structure Allowance component shown on the employee detail page. `Basic Salary = Total Earnings − allowances.structure` is derived read-only. All other keys (e.g. `"HOUSING"`, `"TRANSPORT"`) come verbatim from the VIP 710 earnings block.

**`leave_provision` vs `leave_accrual`** — two distinct columns. `leave_provision` is populated directly from VIP 710 imports and passed through `BurdenInput.leaveProvision` unchanged (not recomputed by `calculateBurden`). `leave_accrual` IS computed by `calculateBurden()` using `basic × (days/365) × pct`. The Employees page "Leave" column shows `leave_accrual`; `leave_provision` is a legacy VIP figure.
**Leave & accruals**: `leave_days`, `bonus_payout_factor`, `bonus_accrual_dec`, `bonus_accrual_july`, `mgmt_incentive`
**Botswana provisions**: `severance`, `gratuity`
**Increase scenario**: `increase_amount`, `adjustment`, `increase_pct`, `new_basic`, `new_ctc`
**Summary**: `net_salary`, `ctc`

---

## Payroll Burden Calculations

All logic lives in `src/lib/payroll-calc.ts`. The `calculateBurden()` function takes a `BurdenInput` and returns a `BurdenResult`.

### Configurable rates (per hotel, stored in `hotels` table via Methods page)

All rates have fallback constants used when the hotel hasn't had migration 009 applied. Passed as optional fields in `BurdenInput`; if absent, hardcoded defaults apply.

| Item | Default | Notes |
|------|---------|-------|
| Provident Fund EE | SA 7%, BW 5% | × Basic |
| Provident Fund ER | SA 7%, BW 4.5% / 9% | BW splits on 5 yrs service |
| UIF EE + ER | 1%, cap R177.12 | SA only |
| SDL | 1% × Gross | SA only |
| WCA | 0.50% × Gross | SA only; from `hotels.wca_rate` |
| Staff Meals — Manager | R380 | title contains manager/mngr/mgr |
| Staff Meals — Standard | R330 | all others |
| Leave Accrual | SA 24 days, BW 21 days | `basic × (days / 365) × leave_accrual_pct` |
| Bonus Provision | SA 30.42 days, BW 26 days | `gross × (days / 365) × bonus_provision_pct`; 0 when `incentive_applicable` |

### `BurdenResult.ctc`

`calculateBurden()` now returns `ctc` directly. It equals `total_earnings` + all ER items where the hotel's CTC flag is `true`. Defaults preserve backward-compatible behaviour (ER contributions in CTC, provisions out). All call sites should use `burden.ctc` — do not recompute `total_earnings + total_company_contrib`.

**Always-in-CTC (no flag)**: `medical_company`, `ancilla_company`, and `otherCompanyContrib` are unconditionally included in CTC regardless of any flag. Only the items listed in `hotels` configurable CTC flags are togglable.

**CTC flag defaults in `calculateBurden`**: `ctcProvidentEr`, `ctcUifEr`, `ctcSdl`, `ctcWca` all default to `true` (in CTC); `ctcMeals`, `ctcLeaveAccrual`, `ctcBonus` default to `false` (out of CTC). These defaults are overridden by the values stored in `hotels` and passed via `BurdenInput`.

### Per-employee flags

- `incentiveApplicable` — sets `incentive = gross × multiplier / 12`; skips `bonus_provision`
- `severanceApplicable` (BW) — `severance = basic/26 × (1 or 2 days/month based on tenure)`; also sets `provident_employee` and `provident_company` to 0 (BW rule: severance employees have no PF contributions)
- `gratuityApplicable` — `gratuity = gross × rate%`

**`yearsOfService` is not stored** — computed at render from `employment_date`: `Math.floor(ms / (365.25 days in ms) * 10) / 10` (1 decimal). Passed as `BurdenInput.yearsOfService` to drive the Botswana PF ER junior/senior tier split (< 5 yrs = 4.5%, ≥ 5 yrs = 9%) and severance rate (< 5 yrs = 1 day/month, ≥ 5 yrs = 2 days/month). The `yearsOfService()` helper is defined locally in `employees/page.tsx` — not a shared util.

### APA Director override

`isDirector()` (exported from `payroll-calc.ts`) detects `"director"` in job title. When `hotelShortCode === 'APA'` and `isDirector()` is true, ER provident fund is calculated as `gross × 14%` (`PF_ER_APA_DIRECTOR`) instead of the standard rate. APA is not a live hotel but the constant is retained.

---

## Import Formats

The import page (`/dashboard/import`) — nav label **"Import HR List"** — auto-detects the file format on upload (hotel must be selected first).

Detection order: CSL Payroll Schedule xlsx (by file extension + sheet names) → round-trip CSV → medical aid → leave balance → employee code update → HR List / employee details → VIP 710.

**Non-CSL xlsx files** fall through: after failing the CSL schedule detection, the first sheet is extracted as CSV via `xlsx-js-style` and fed into the text-based detectors below.

**Import performance**: `confirmPayrollSchedule` and `confirmImport` both batch salary record upserts into a single Supabase call (not one per employee). Employee updates run in parallel via `Promise.all`. Both functions wrap in `try/catch/finally` — errors surface as a visible message rather than freezing the "Importing…" button.

### CSL Payroll Schedule (multi-sheet xlsx)

- Parser: `src/lib/vip-parser.ts` → `parseCslPayrollSchedule(buffer: ArrayBuffer)`
- Detected: file has `.xlsx`/`.xls` extension **and** sheet names match month patterns (e.g. "July25", "Jan 26")
- Each sheet = one payroll month; header row and column positions are detected dynamically (vary across sheets)
- Employee code column matched by cell value "EMP #", "EMP#", or "Code" in the first 10 rows, first 4 columns
- Row filter: skips empty codes and summary rows (Total, Grand Total, Sub-) — does NOT require codes to start with "EMP"
- UI shows a month selector dropdown; imports `basic_salary` only — run Calculate Burden afterwards
- Matching: employee code first; falls back to surname + first_name for hotels whose DB codes are NULL (CSL, NL — cleared by migration 014). When matched by name and the file has a code, that code is written back to the DB for future imports.
- Also dynamically imports `xlsx-js-style` (same SSR-safe pattern as recon parsers)

### VIP Report 710 (fixed-width payroll register)

- Parser: `src/lib/vip-parser.ts` → `parseVIPReport()`
- Splits on `={10,}` separator lines; period detected from `TxDt:` field
- Matched by `employee_code` within the selected hotel

### HR List / Employee Details (xlsx, CSV, or TSV)

Previously called "Employee Details". The nav tab and page title are "Import HR List".

- Parser: `src/lib/vip-parser.ts` → `parseTSVEmployeeFile()`
- Detected by `isTabularEmployeeFile()`: first line contains surname/first name indicators AND (gross/salary OR omang/ID OR dept+title). More flexible than "must contain Gross" so files with only HR fields (no salary) are accepted.
- **No period selector** — period auto-sets to current month/year (HR lists are not payroll; period is only needed for the salary record anchor)
- **Columns parsed**: Surname, First Name, Employee Code, Omang / National ID (`id_number`), Gross Salary, Medical Company, Department, Job Title, Grade, Start Date
- **Matching**: employee code first (from file), falls back to surname + first_name. Synthetic code (`makeSyntheticCode` in `import/page.tsx`) only used when no match found: first 3 chars surname + first 3 chars first name, uppercased, deduplicated with numeric suffix.
- **Update path** (existing employees): writes surname, first_name, job_title, department_code, employee_code (if in file), id_number (if in file), grade_label, employment_date. HR list is treated as authoritative for names — surname/first_name are updated.
- **Salary record**: a minimal record is written for each employee with `basic_salary > 0` (gross from file, zeros for all contributions). This makes employees visible in Salary Review. Run **Calculate Burden** or **Methods → Save & Update** afterwards to populate contributions and provisions.
- New employees are inserted and get an active status (DB default)

### Medical Aid Update (CSV from medical aid provider)

- Parser: `src/lib/vip-parser.ts` → `parseMedicalAidFile()`
- Detected: first line starts with "Surname" and contains "Medical"
- Updates `medical_company` on the latest salary record; adjusts `total_company_contrib`, `total_payroll_burden`, `total_cost`, `ctc`

### Employee CSV Round-trip (exported from Employees page)

- Parser: `src/lib/employee-csv.ts` → `parseEmployeeCsvExport()`
- Detected: first line starts with `employee_code,` **or** `employee_code;` and contains `period_month`
- Delimiter auto-detected (comma vs semicolon) — Excel on SA/EU locales saves CSVs with `;`
- Matches by `employee_code` within the selected hotel; updates all employee fields + upserts the full salary record
- After import, run Calculate Burden or Methods → Save & Update to recalculate contributions

### Leave Provision Balance Import (annual, July)

- Parser: `src/lib/vip-parser.ts` → `isLeaveBalanceFile()` / `parseLeaveBalanceFile()`
- Detected: header has a name field + a "leave" column mentioning balance/days/accrual, and **no** gross/salary/earnings column (distinguishes it from the generic HR List detector)
- **Columns parsed**: Surname, First Name, Employee Code (optional — falls back to name match), Leave Balance (days)
- Matching: employee code first, falls back to surname + first_name
- Handled as its own preview/confirm pair (`leaveRows` state, `confirmLeaveProvision()`) on the Import page — mirrors the Medical Aid Update branch, does **not** go through the shared `ImportRow`/`confirmImport()` pipeline used by VIP/HR List/CSL/round-trip
- At preview time, computes `dailyRate = gross ÷ hotel.leave_provision_divisor` (fallback: 26 Botswana / 30.42 South Africa, configurable per hotel on the Methods page) and `provisionValue = dailyRate × min(leaveBalanceDays, LEAVE_PROVISION_CAP_DAYS)` — the provision is only ever calculated up to the cap (24 days, `LEAVE_PROVISION_CAP_DAYS` in `payroll-calc.ts`), using each employee's latest `salary_records.total_earnings` (gross salary, inclusive of the structure allowance — **never** `basic_salary` or `ctc`). The preview table shows both "Actual Leave Balance" (uncapped, as imported) and "Capped Leave Balance" (what the calc actually used) side by side.
- Confirm upserts into the `leave_provisions` table (not `salary_records`) on conflict `(employee_id, period_year)`, `period_year = new Date().getFullYear()`. Only the **actual** (uncapped) `leave_balance_days` is stored — the cap is applied at calc time, not at import time, so raising `LEAVE_PROVISION_CAP_DAYS` later and hitting Recalculate re-derives a larger provision from the same stored balance — see the Leave Provision section below

### Employee Code Update (ad-hoc — used to (re)assign codes for CSL/NL)

- Parser: `src/lib/vip-parser.ts` → `isEmpCodeUpdateFile()` / `parseEmpCodeUpdateFile()`
- Detected: header has a Surname column + an "EmpCode"/"Emp Code" column, and **no** gross/salary/earnings, omang/ID, or leave column (keeps it from colliding with the HR List and Leave Balance detectors, which are checked earlier in the chain)
- **Columns parsed**: Surname, Name (first name), EmpCode (the new code to write). Any other column (e.g. a legacy "Code" column carried over from a payroll export) is ignored.
- **Matching is name-only** (surname + first name, case-insensitive) — this format has no reliable existing code to match on, which is exactly the CSL/NL scenario (migration 014 cleared their codes to NULL)
- Handled as its own preview/confirm pair (`empCodeRows` state, `confirmEmpCodeUpdate()`) — does **not** go through `confirmImport()`. The DB patch is `{ employee_code, updated_at }` only — no other employee fields are touched, and no salary record is written. Rows where the imported code matches the employee's current code are skipped (shown as "Unchanged" in the preview) so the update is a no-op for anyone already correct.

---

## Key Files

```
src/
  app/
    api/
      auth/
        login/route.ts    — POST: queries users table, verifies HMAC hash, issues signed cookie
        logout/route.ts   — POST: clears cookie
        me/route.ts       — GET: returns current UserContext from cookie
      access/route.ts     — POST/PATCH/DELETE: admin-only user CRUD
    page.tsx              — Root page; immediately redirects to /dashboard
    login/page.tsx        — Login form (username + password)
    dashboard/
      page.tsx            — Dashboard: renders only SalarySummaryTable (no server-side data fetching of its own)
      SalarySummaryTable.tsx — Filterable hotel-level before/after table with a per-employee expand/collapse drill-down; reads draft scenarios first, then committed
      InflationHistoryCard.tsx — CPI + historic increases + NMW reference card; data stored in localStorage only; rendered at the bottom of Methods page (not dashboard)
      layout.tsx          — Reads cookie server-side; passes role+username to NavSidebar
      access/page.tsx     — Admin-only user management UI; per-sub-user Tab Access + Hotel Access checkboxes
      employees/
        page.tsx          — Employee list; column picker, hotel CSV export, Calculate Burden
        [id]/page.tsx     — Employee detail + edit form; salary section has Structure (stored in allowances.structure) + Total (Gross) inputs; Basic Salary = Total − Structure is derived read-only; provident fund uses basic for EE and ER (APA Director exception: 14% of gross)
      leave-provision/page.tsx — Standalone annual leave balance provisioning; hotel + year selector, Recalculate button; reads the leave_provisions table, populated only via Import HR List
      import/page.tsx     — Multi-format import (HR List xlsx/CSV/TSV, VIP, Medical Aid, Leave Balance, Round-trip CSV, CSL Payroll Schedule xlsx); nav label "Import HR List"; no period selector for HR List type
      methods/page.tsx    — Configurable payroll rates + CTC flags per hotel; Save & Update All; InflationHistoryCard rendered at bottom
      settings/page.tsx   — Redirects to /dashboard/methods
      salary-review/page.tsx — Per-hotel increase builder; drafts persist to DB; commit to salary_records
      reports/page.tsx    — Flexible report builder; Excel + PDF export
      reconciliation/page.tsx — Monthly payroll reconciliation for CSL/NL/CFE (admin-only)
  lib/
    auth.ts               — UserContext, makeToken(), verifyToken(), hashPassword() — Edge-compatible
    payroll-calc.ts       — calculateBurden(); isBotswana(), isManager(); BurdenInput/BurdenResult
    vip-parser.ts         — VIP 710, HR List (parseTSVEmployeeFile / isTabularEmployeeFile), medical aid parsers, parseCslPayrollSchedule
    employee-csv.ts       — Round-trip CSV export builder (buildEmployeeCsv) + import parser
    excel-export.ts       — Salary review Excel export (xlsx-js-style)
    reports-export.ts     — Reports Excel + PDF export (exportReport, exportPdf)
    recon-parsers.ts      — Reconciliation file parsers: parseAfritecXls, parseFurnmart, parseBodulo, parsePensionSchedule, parsePayrollXlsx
    supabase/
      client.ts           — Browser Supabase client (used by all dashboard pages)
      server.ts           — Server-side Supabase client (used only in RSC `dashboard/page.tsx`)
    utils.ts              — fmtZAR(), fmtCurrency(), fmtNumber(), MONTH_NAMES, sortHotels(), hotelSortIndex(), cn()
  components/
    nav-sidebar.tsx       — Role-aware navigation; admin sees all tabs, sub sees whichever tabs their `allowedTabs` grants
  middleware.ts           — HMAC cookie auth gate; always blocks sub-users from Salary Review/Access; gates Dashboard/Employees/Import/Reconciliation/Reports/Methods per-user via allowedTabs
  types/
    database.ts           — Hotel, Employee, SalaryRecord, PayrollImport, IncreaseScenario, ScenarioLine, AppUser, ReconciliationPeriod, ReconUpload, ReconQuery
```

---

## Salary Review

`/dashboard/salary-review` — per-hotel increase scenario builder.

**State pattern**: settings are stored per hotel in a `Map<string, HotelSettings>` + a `hotelSettingsRef` (React ref) to avoid stale closure issues on hotel-tab switches. A parallel `hotelDraftIds` map tracks the DB scenario ID for each hotel's draft.

**Save button** — async; writes a `draft` row to `increase_scenarios` (with `hotel_id` + `settings_json`) and replaces `scenario_lines` for that hotel. On page load, all drafts are fetched in the initial `Promise.all` and refs are populated before `setHotelFilter` fires, so the form restores correctly on return. Both this page's draft-loading query and `SalarySummaryTable`'s both filter `.not('hotel_id', 'is', null)` — see the incident note below for why.

**Delete button** — trash icon per row in the Saved Increases table; removes the draft scenario + its lines from DB.

**Exclusions** — checkbox per employee row. Excluded employees show `opacity-45` + "excluded" badge; they are skipped in scenario_lines and on Commit (no salary record written for them).

**Employee table sort** — `computeRows()` sorts its return by surname then first name, so the line-by-line table on this page is always alphabetical (previously unordered — DB return order).

**Incident: orphaned pre-migration-012 draft scenario contaminated dashboard figures** — a scenario row with `hotel_id: null` / `settings_json: null` (predating the per-hotel draft model) still had `status: 'draft'` and stale `scenario_lines`. This page's own load already skipped it silently (`if (!draft.hotel_id || !draft.settings_json) continue`) so it was invisible here and undeletable from any UI — but `SalarySummaryTable`'s draft query had no such filter, so it merged the orphan's stale lines into the `employee_id → scenario_line` map dashboard-wide. Any employee excluded from the *current* real draft but present in the orphan showed the orphan's stale increase (this is what caused APA's ANO grade to show an increase that was never applied); employees present in *both* the orphan and the current draft were subject to a non-deterministic overwrite race depending on query result order. Fixed by deleting the orphaned row/lines and adding `.not('hotel_id', 'is', null)` to both queries so a stray orphan can't recur. If dashboard/hotel-summary figures ever look wrong again in a way Salary Review itself doesn't show, check `increase_scenarios` for rows with `hotel_id IS NULL`.

**Commit** — updates each hotel's draft scenario status to `committed` (sets `effective_month`, `effective_year`, `committed_at`); writes new `salary_records` for the target month/year; automatically writes each hotel's increase to `ihg-salary-increases` in localStorage (so the Inflation & Increase History table on the Methods page updates without manual entry); clears all draft state. Does NOT create a new scenario row — the existing draft row is promoted. When the committed scenario used a threshold, the full `≥`/`<` breakdown is carried through (`pct`/`flat` become the "above" tier via `settings.abovePct || settings.pct` / `settings.aboveFlat || settings.flat`, plus `threshold`/`belowPct`/`belowFlat`) rather than flattening to a single rate — see `IncreaseEntry` below.

**Increase calculation** — all % increases are applied to `total_earnings` (Gross salary), not `basic_salary`. The resulting amount is added to `basic_salary`; allowances remain unchanged. Formula: `increase = total_earnings × pct + flat → newBasic = round(basic + increase, 10)`. `ForecastRow.currentGross` = `total_earnings`; the table shows "Current Gross" / "New Gross" columns and the Excel export uses the same labels.

**Threshold** — optional second tier within a hotel's scenario. `threshold` compares against `basic_salary` (not gross). Divides employees into two bands:
- Basic **< threshold**: uses `belowPct`/`belowFlat` applied to gross; otherwise **0** (no increase).
- Basic **≥ threshold**: uses `abovePct`/`aboveFlat` applied to gross; otherwise falls back to the global `pct`/`flat`.

Grade-level exclusions (`excludedGrades`) and per-employee exclusions (`excluded`) both set `isExcluded = true` — excluded employees are kept in the table with 0 increase and are included in totals/consolidations but receive no salary change on Commit.

**Dashboard** — `SalarySummaryTable` reads all `draft` scenario lines first (shows pending increases before commit). Falls back to the most recent `committed`/`applied` scenario if no drafts exist. Three-tier drill-down, each level with its own "+"/"−" toggle: **Hotel row** (filtered total) → **Grade rows** (one per grade present among the filtered employees at that hotel, sorted by `GRADE_ORDER`, each a subtotal) → **Employee rows** (individuals making up that grade's subtotal). All three levels share the same `computeEmployeeFigures()` logic, so hotel, grade, and employee figures always reconcile. This replaced the old per-hotel `HotelCard` grade-breakdown cards that used to render below the summary table.

**Dashboard HC vs. Salary Review "Saved Increases" count — deliberately different semantics**: the Dashboard's `headcount` (hotel-row and grade-row) is the **total headcount** per grade/hotel matching the Hotel/Grade filters, irrespective of whether any salary adjustment applies to a given employee — it does not filter by exclusion or by whether `increaseAdj` is nonzero. Salary Review's "Saved Increases" table's **Employees** column is the opposite: `rows.filter(r => !r.isExcluded && r.increaseAmount > 0).length` — only employees genuinely **effected** by the saved increase. These must stay different: a threshold scenario can legitimately compute a 0 increase for an employee who is still *included* (not excluded) — e.g. ILRB's saved scenario has `threshold: 5901, belowPct: 0, abovePct: 6`, so 24 of its 26 Frontline employees are included but land at exactly 0 (below threshold, 0% band) while only 2 clear the threshold. Dashboard HC counts all 26 (total headcount for that grade); Salary Review's count counts only the 2 actually affected. Do not "fix" one to match the other — this was tried and reverted once already.

**`InflationHistoryCard`** (`src/app/dashboard/InflationHistoryCard.tsx`) — `'use client'` card rendered at the **bottom of the Methods page** (not the dashboard). Stores all data in `localStorage` (never in the DB):

| Key | Content |
|-----|---------|
| `ihg-salary-cpi` | `Record<country, Record<year, string>>` — CPI % per country per year |
| `ihg-salary-increases` | `Record<hotelId, Record<year, IncreaseEntry>>` — historic increases; see `IncreaseEntry` shape below |
| `ihg-salary-nmw` | `Record<year, string>` — SA National Minimum Wage reference value (shared across all SA hotels) |
| `ihg-salary-cpi-month` | `string` — month label for CPI header (e.g. `"July"`) |
| `ihg-salary-increase-notes` | `string` — free-text notes |
| `ihg-salary-union-adj` | `Record<hotelId, Record<year, string>>` — union-negotiated adjustment; CSL and NL only |

**`IncreaseEntry` shape** (defined in both `InflationHistoryCard.tsx` and `excel-export.ts` — keep in sync): `{ pct: string; flat: string; threshold?: string; belowPct?: string; belowFlat?: string }`. `threshold`/`belowPct`/`belowFlat` are optional — when a threshold is entered for a given hotel/year, `pct`/`flat` are reinterpreted as the "≥ threshold" (above) band and `belowPct`/`belowFlat` become the "< threshold" (below) band, mirroring the two-tier structure of the Salary Review Saved Increases table (`threshold`/`belowPct`/`belowFlat`/`abovePct`/`aboveFlat` on `HotelSettings`). Entries without a threshold behave exactly as before (a single flat rate).

NMW indicator shows only for SA hotels where `short_code !== 'APA'` and `!isBotswana(country)`. Union Adjustment indicator shows only where `short_code` is `CSL` or `NL` (`showUnion()`). NMW and Union are mutually exclusive per hotel (no hotel is ever both Botswana-union and SA-NMW), which the row-alignment logic below relies on. The `YEARS` constant covers 6 years: last 5 completed + current year — used by the CPI table and must match `BENCHMARK_YEARS` in `excel-export.ts`. `HISTORIC_YEARS` is now the same as `YEARS` (includes the current in-progress year) — Salary Review commits write into it mid-year, so hiding the current year just meant recent commits were invisible until year-end.

**Historic increases row alignment** — each year cell renders a variable number of stacked inputs depending on whether that year has a threshold: 3 rows (`pct`, `flat`, `threshold`) normally, or 5 when `belowPct`/`belowFlat` are also shown. Because a `<tr>`'s row height is set by its tallest cell but each cell's own content is independently top-aligned, a hotel row where only *some* years have a threshold would otherwise show the NMW/Union input at a different height per column. `entryRowCount()` + a per-hotel `maxRows` (computed across that hotel's `HISTORIC_YEARS`) drives two paddings: years without a threshold render two invisible `SpacerRow`s in place of the missing below-band rows when a sibling year needs them (`needsPad`), and the hotel-name cell pads with `spacerCount = maxRows - 1` `SpacerRow`s before the NMW/Union label so the label lines up with its input. If the Union/NMW boxes ever look staggered again across a hotel's year columns, check this padding math rather than assuming it's a one-off CSS glitch.

The salary review Excel export reads the CPI/increases/NMW/notes/month localStorage keys in `handleExport()` and passes a `BenchmarkData` object to `exportSalaryReview()`, which prepends a CPI table, historic increases table (with NMW row), and optional notes above the summary table in the **Overview** sheet. `incCell()` in `excel-export.ts` renders the same `≥`/`<`/`Thresh` breakdown as the on-screen table (multi-line wrapped text) when an entry has a threshold; rows containing a threshold breakdown get extra height via `ws['!rows']`. Union adjustments are UI-only on the Methods page and are not currently included in this export.

### Excel export structure (`src/lib/excel-export.ts`)

**Per-hotel sheets** (one per hotel with rows):

| Col | Content | Behaviour |
|-----|---------|-----------|
| D — Yrs Service | Static, computed from `employment_date` | Read-only; `—` if no start date |
| E — Grade | Static | Read-only |
| G — Current Gross | Static (DB value) | Read-only |
| H — % Increase | Editable input | **Amber header + yellow cell** — change here to model scenarios |
| I — Flat Adj | Editable input | Same — amber/yellow |
| J — New Gross | `=ROUND(G*(1+H/100)+I,-1)` | Recalculates live |
| K — Monthly Inc | `=J-G` | Live |
| L — Current CTC | Static | Too complex for Excel formulas |
| M — New CTC | Static | Same |
| N — Monthly CTC Δ | `=M-L` | Live |
| O — Annual CTC Δ | `=(M-L)*12` | Live |

Totals row uses `SUM(col_first:col_last)` formulas for J, K, N, O.  
AutoFilter on `A1:O1` — use column E (Grade) dropdown to filter by grade.

**`% Increase` stored as display value** (e.g. `6.0`, not `0.06`) with format `'0.0"%"'` — formulas must divide by 100: `G*(1+H/100)`.

**Overview sheet** — 14 columns A–N:

| Col | Content |
|-----|---------|
| A–D | Hotel, Short Code, Currency, Headcount |
| E | Increase % — configured rate (`settings.pct` + `settings.flat`) from `ExportHotel.increase` |
| F | Current Gross (static) |
| G | New Gross — `='SheetName'!J{totRow}` — cross-sheet formula, updates when hotel tab edited |
| H | Monthly Inc — `='SheetName'!K{totRow}` |
| I | Annual Inc — `='SheetName'!K{totRow}*12` |
| J–M | CTC columns (static) |
| N | % Change — `=IFERROR((G/F-1)*100,0)` within Overview |

Grand Total row uses `SUM(G{first}:G{last})` etc. so it aggregates live hotel values.

`exportSalaryReview` builds the `sheetNames: Map<string, string>` first (short code, single quotes stripped) and passes it to `buildSummarySheet` so cross-sheet formula strings are correct. Sheet names strip `[:\\/?\*\[\]']` and truncate at 31 chars.

**`ExportHotel` interface** — `increase?: IncreaseEntry` carries the hotel-level configured rate. `ExportHotelRow` carries both `currentGross` (formula base) and `currentBasic` (needed for increase-amount column).

---

## Reconciliation

`/dashboard/reconciliation` — admin-only monthly payroll cross-check for **CSL, NL, and CFE Management** only (hotel tabs are filtered to these three short codes: `RECON_CODES = ['CFEM', 'CSL', 'NL']`).

**CFE Management's `hotels.short_code` is `"CFEM"`, not `"CFE"`.** A prior version of this page filtered/matched on the literal string `'CFE'` everywhere (the top hotel-tab filter, the Deductions Check "Management" section's employee lookup) — since no hotel actually has that short code, CFE Management silently never appeared anywhere on this page despite the code and comments claiming it did. Fixed by matching on `'CFEM'` throughout. If CFE Management data ever looks missing again on this page, check for a stray literal `'CFE'` comparison before assuming a data problem.

**Workflow (current)**: Upload tab → Deductions Check tab → **Employees tab** → **Consolidation tab**. Status moves Open → Submitted → Approved.

**Intended end-to-end flow** (Employees tab's writeback to `employees` — the "Update" step — is not yet built, deliberately, per explicit instruction to build it last): monthly payroll upload → reconcile/validate on the Employees tab → Submit locks the period for sub-users (admin can still edit) → an admin-only "commit" action will apply New Appointments/Basic Salary Mismatch/Terminations to the `employees` table, so the HR List only ever changes as a *result* of a reconciled period, never independently. Corrections are made by re-uploading the affected month's file (current or prior period) via **Replace** on the Upload tab — every comparison is computed live from whatever is currently stored, nothing is frozen at upload time, so a corrected file automatically flows through on next view. There is currently no lock preventing a Replace after Submit/Approve — worth revisiting once the commit step exists, since replacing a file post-approval would silently change the comparison without re-triggering review.

**Removed**: the "12 Months Payroll Report" PDF upload slot (`twelve_months` upload type) was removed entirely — it was never parsed for any calculation (only stored as a base64 blob with a "View" button to open it), and once Consolidation replaced it with an actual reconciliation mechanism, keeping a salary-adjacent PDF upload around served no purpose. The Prior Month Changes and Terminations tabs, and the old Employees tab (DB-vs-payroll comparison), were removed/merged into the new Employees tab (see below). The Queries tab was removed from the UI in favour of Consolidation — `recon_queries` and `recon_terminations` (and their `addQuery`/`resolveQuery`/`flagTermination`/`resolveTermination` logic) are no longer referenced by the page at all, but neither table was dropped; both still exist in the DB with any historical data intact, simply unreachable from the UI now.

**Upload tab**: Period selector (month/year) is the first element. File slots:

| Slot | Type | Format | Notes |
|------|------|--------|-------|
| Payroll Spreadsheet | `payroll` | `.xlsx` | Required; NataLodge-style department-grouped export |
| Fixed Term Contract Payroll | `ftc_payroll` | `.xlsx` | Optional; multi-sheet (one sheet per month, picked by target period); matched by name only (no employee codes) |
| Afritec Loan Statement | `afritec` | `.xls` | Loan instalment schedule |
| Topline Loan Statement | `topline` | `.xls` | Same format as Afritec |
| Furnmart Deductions | `furnmart` | `.xlsx` | Multi-SEQ rows per employee |
| CB Stores Deductions | `cbstores` | `.xls/.xlsx` | Optional; omit if no deductions that month |
| Bodulo Funeral Scheme | `bodulo` | `.xlsx` | Policy list |
| Pension Contributions | `pension` | `.xls/.xlsx` | Monthly pension/provident fund statement; **uploaded per hotel, including CFEM** — unlike the other 5 vendors, pension is never mixed into CSL's/NL's shared statements, so it isn't part of the CFEM Deductions Summary or the CFE Cross-Reference below |
| CFEM Deductions Summary | `cfem_deductions` | `.csv/.txt` | **CFEM only** — replaces the 5 shared-vendor slots above (Afritec/Topline/Furnmart/CB Stores/Bodulo) and Payroll Spreadsheet for that hotel; see "CFE Management" below |

Re-uploading any slot replaces it (upsert on `period_id, upload_type`). `visibleUploadConfigs` filters which slots render per hotel: CFEM sees `cfem_deductions` + `pension` (`CFEM_UPLOAD_TYPES`) — no other slot, since Payroll Spreadsheet is a salary document CFEM must never upload here. Every other hotel sees everything except `cfem_deductions` (`NON_CFEM_UPLOAD_TYPES`).

Pension has its own dedicated parser, `parsePensionSchedule` (`handleUpload` dispatches `type === 'pension'` to it directly, not through the `parseAfritecXls` catch-all) — the fund administrator's contribution schedule export is structurally unlike every other vendor file:

- **Multi-sheet**, one sheet per month (e.g. `"April 26"` … `"July 26"`), plus non-data reference tabs (`"Detailed field discriptions"`, `"Schedule"`). The sheet matching the target period is picked via `pickFtcSheet()` — the same month/year sheet-name matcher `parseFtcPayrollXls` uses (a `function` declaration, hoisted, so `parsePensionSchedule` can call it despite being defined earlier in the file).
- The monthly sheet's header (detected by keyword, not a fixed row) has `EMPLOYEE NO`, `FIRST NAMES`, `SURNAME`, `MEMBER CONTRIBUTION AMOUNT` (the **employee/EE** side — what payroll's own `pensionEe` column represents), `EMPLOYER CONTRIBUTION AMOUNT` (**ER**), and `TOTAL CONTRIBUTION AMOUNT` (EE+ER; computed locally as `ee + er` if this column is ever absent).
- **`lines[].amount` and `ParsedStatement.total` are EE-only** — the Deductions Check summary/Employee Detail tables compare this against payroll's `pensionEe` exactly like Furnmart/Bodulo (code-based matching only, no `matchByName`), so the two sides are always like-for-like (payroll never reports an employer contribution at all).
- The combined EE+ER figure is carried separately on `ParsedStatement.bankTotal` — **only the Consolidation tab's Pension "System" figure reads this** (via `getPensionBank()` in `loadSystemTotals`, falling back to `total` for any statement with no EE/ER split), since that combined amount is what's actually paid to the fund administrator each month, not the EE-only deduction. Every other vendor's Consolidation figure and the Deductions Check comparison both read the same `total` — pension is the only line item where those two numbers deliberately differ.

**Parsers** (`src/lib/recon-parsers.ts`):
- `parseAfritecXls(buf, fileName, uploadType, hotelCode)` — detects header row by keyword (`empColPattern`: "Employee Number/No", "Emp No", "Staff No", "Payroll No", "Employee #", or a bare `"Code"` cell — the `#`/bare-`Code` alternatives were added after real CB Stores/Topline exports showed up with those exact headers instead of "Emp No"); falls back to col 5 = Employee Number, col 10 = Regular Instalment only when no header row is found at all. Name-column detection also handles the case where a bare `"Name"` header coexists with a separate `"Surname"` column (an Afritec life-insurance export does this) — a bare `"Name"` is only treated as a *combined* full name when there's no separate Surname column to pair it with; otherwise it's the first-name half and gets joined with Surname, so a co-existing Surname column is never silently dropped. `"Employee Name"`/`"Customer Name"` are always unambiguous full-name headers regardless. Amount-column keywords also include `"Premium Due"` (seen on a life/insurance-style statement) alongside "Regular Instalment"/"Amount"/"Deduction". **If the file contains a "CUSTOMER NAME" header specifically in column 0 it delegates to `parseCbToplineFormat`** — so this function is the catch-all for afritec, topline, and cbstores. Dispatch in `handleUpload`: `payroll`→`parsePayrollXlsx`, `furnmart`→`parseFurnmart`, `bodulo`→`parseBodulo`, all others→`parseAfritecXls(buf, name, type, hotelCode)`
- `parseCbToplineFormat` — handles the multi-section `CUSTOMER NAME / CUST.# / AMOUNT` format used by CB Stores and Topline. Sections are identified by `TO: <label>` rows above each header. `sectionMatchesHotel()` filters which sections to include per hotel (CSL→"CSL\*", NL→"NSL\*", CFEM→"CFE\*") — both the section label and the `hotelCode` argument are uppercased before comparing, and `hotelCode === 'CFEM'` (the real `hotels.short_code`) is accepted alongside the shorter `'CFE'` label prefix it's matched against, so this can't silently fall through to "include everything" the way the rest of this page's `'CFE'` vs `'CFEM'` mixup did before it was fixed elsewhere (see "CFE Management" below) — now reachable for CFEM too via the Pension upload if a hotel's pension statement happens to be in this multi-section format. **MGMT/Management sections are always passed through regardless of hotel** — they appear on CSL/NL statements but are separated downstream by `isMgt()` into the Management section. Each employee line is stored with `empCode = nameKey(name)` (CUST.# ignored) and `section = sectionLabel`. Returns `matchByName: true`.
- `parseFurnmart` — column positions vary across hotel/month exports (a richer multi-SEQ format with Contract/Balance/SEQ/TOTAL columns has been seen alongside much simpler flat exports with one row per employee and no TOTAL column at all — either `EMP NO / Name / Surname / Deduction`, or a bare `Code / SURNAME / NAME / Amount` variant, seen on a real July 2026 Chobe export), so columns are detected from the header row by keyword (`emp\s*no` or bare `code`, `name`, `surname`, `deduction` or bare `amount`, `total`) rather than hardcoded positions — the original layout's fixed indices (`[1],[2],[3],[10],[11]`) are kept only as a fallback for the rare case the header row can't be located at all. When a `TOTAL` column exists it's only populated on the last SEQ row per employee (multi-row accumulation, last-non-zero-wins); when there's no `TOTAL` column at all, `DEDUCTION`/`Amount` is already the final per-employee amount (one row per employee, nothing to accumulate). Employees with no code go to `unmatchedLines`.
- `parseBodulo` — column positions vary the same way as `parseFurnmart`: the original policy-list layout (Custom Policy Number as empCode at col 4, Premium Due at col 9, no name column at all, "TOTAL TO PAY" in a bottom summary block) is detected and used as a fallback only when no header row is found; simpler flat exports uploaded to this same slot for other funeral/life-insurance-style products (e.g. an Afritec-branded life insurance list with Employee Number/Name/Surname/Premium Due columns) are detected by header keyword instead, and — unlike the legacy layout — get a real name from the Name/Surname columns rather than the code repeated as a placeholder. Same bare-`"Name"`-vs-`"Surname"` ambiguity handling as `parseAfritecXls`.
- `parsePayrollXlsx` — header detected by `col[0]="Code"` **and** "employee" appearing anywhere in that header row (not pinned to a fixed column — CSL's format has a secondary short-code column at col[1] and pushes "Employee Name" to col[2]). The employee-name column itself (`colName`) is keyword-detected (`/employee.*name|^name$/`), falling back to col[1] for older formats. All other columns detected by keyword (e.g. "furnmart", "cb stores", "funeral", "staff loan", "afritec", "topline", "cbh" — CSL's payroll export labels the Afritec loan column "8150 - CBH - Loan") — robust across hotel format variants. `afritecFromStaff` flag: when payroll has a Topline column but no dedicated Afritec/CBH column, the Staff Loans column is used as Afritec amounts. **Totals-row detection** is also column-agnostic: a blank-code row is treated as the sheet's final totals row if it has a non-zero Income Total, Deduction Total, or Nett Pay (rather than requiring the name cell to literally read `"Total"`, which some exports leave blank) — otherwise it's skipped as a department subtotal/header row.
- `parseFtcPayrollXls(buf, fileName, targetMonth, targetYear)` — picks the sheet matching the target period (`pickFtcSheet`), then reads name + total columns only (`findFtcHeader`); rows are keyed by `nameKey(name)` (no employee codes exist for FTC staff), and a name repeated in a second block on the same sheet has its total summed rather than overwritten.
- `parsePensionSchedule(buf, fileName, targetMonth, targetYear)` — see "Pension Contributions" under Upload tab above for the full multi-sheet/EE-vs-EE+ER breakdown. Also uses `pickFtcSheet` for month/year sheet selection.

**`PayrollLine` loan columns**: `afritecLoans` (Afritec-specific, 0 if absent) + `toplineLoans` (Topline-specific, 0 if absent) + `staffLoans` (combined = `afritecLoans + toplineLoans`, or the single combined column when the payroll has no split). In the Deductions Check summary: if the payroll has non-zero separate columns, Afritec and Topline are compared independently; if only the combined `staffLoans` column exists and both statements are uploaded, a single "Total Loans" row is shown instead.

**`nameKey(raw)`** (exported from `recon-parsers.ts`) — normalises a name to a sorted word-set key: `"BEAUTY LISEHU"` and `"LISEHU BEAUTY"` both produce `"BEAUTY|LISEHU"`. Used for order-agnostic name matching.

All parsers are async and dynamically import `xlsx-js-style` (avoids SSR issues — any new parser must follow this pattern).

**Deductions Check tab**: requires payroll upload. Page loads on CSL by default. Shows:
1. **Orange callout** (top) — statement entries that could not be matched to any payroll employee by code or name. Entries resolved by the second-pass name match are excluded from this callout.
2. **Summary table** — statement total vs payroll total + difference per vendor.
3. **Employee Detail table** — colour-coded vendor filter tabs (All / Furnmart / Afritec / Topline / CB Stores / Bodulo / Pension). Each tab filters both columns AND rows — clicking Furnmart shows only employees with a Furnmart deduction. Only employees with at least one non-zero deduction are shown.
4. **Management (CFE) section** (below staff table) — employees from MGMT-labelled sections of CB Stores / Topline statements, shown separately (no payroll comparison; these are CFE Management employees on a separate payroll).

**Employee matching in the Deductions Check tab** uses a two-pass strategy:
- *Pass 1 (code-based)*: match statement `empCode` against payroll `empCode`. CB Stores / Topline with `matchByName=true` skip this and go to pass 2.
- *Pass 2 (name-based)*: for all `unmatchedLines` from every statement (Afritec numeric codes, Furnmart no-code entries, old-format CB/Topline), try `nameKey(payrollEmployee.name)` lookup. Resolved entries populate the employee table. Truly absent entries (no payroll counterpart) are appended as extra rows (Code = —).

**Upload label**: "Topline Loan Statement" was renamed to "Topline Deductions" in `UPLOAD_CONFIGS`.

### CFE Management (CFEM) — separate confidential payroll

CFEM runs its own confidential payroll — **no Payroll Spreadsheet is ever uploaded for CFEM** (CSL/NL users must not see CFEM salaries), but CFEM's deductions are physically mixed into CSL's and NL's shared third-party vendor statements (Afritec, Topline, Furnmart, CB Stores). CFEM's own HR system can export a pre-split-by-vendor deductions report instead — that single file replaces the need to extract CFEM's slice out of the shared CSL/NL statements.

**Parser**: `parseCfemDeductions(text, fileName)` in `recon-parsers.ts` — parses a plain-text/CSV export with repeated sections (`LIST OF: <Vendor>  METHOD NO: ALL  (Current period)`, a header row, one row per employee, a dashed divider, a `( N Empls)` section-total row). Anchors on the three trailing `X.XX`-shaped numbers per data row (`EMP.CODE`, name, `CO.CONTRIB`, `EMP.AMOUNT`, `TOTAL`) rather than whitespace-run column boundaries, because employee names occasionally contain an accidental double-space that would otherwise get mis-split as a column break. `.00` (no leading digit) required widening the number regex from `\d+\.\d{2}` to `\d*\.\d{2}`.

**Vendor mapping** (`CFEM_VENDOR_TO_TYPE`): CFEM's own vendor labels map onto the existing `furnmart`/`afritec`/`topline`/`cbstores`/`bodulo` upload types so all the existing Deductions Check rendering works unchanged — `"Afri Insurance"` maps to `bodulo` (same kind of deduction as CSL/NL's Bodulo Funeral Scheme, different vendor name for CFEM). `"Taku"` has no current equivalent slot (zero entries so far) and is parsed but intentionally left unmapped/unused until it has real data. Lookups always go through `lookupCfemVendorType()`, a case-insensitive wrapper (`CFEM_VENDOR_TO_TYPE_UPPER`) — an exact-key miss here silently drops that vendor's section with no error, so a casing mismatch between `CFEM_VENDOR_TO_TYPE`'s labels and whatever a given month's CFEM export actually uses (e.g. `"FURNMART"` vs `"Furnmart"`) would otherwise fail invisibly.

**Rendering**: rather than storing 5 separate `recon_uploads` rows, the one `cfem_deductions` upload is stored as-is and its sections are converted into `ParsedStatement` shapes **at render time** (`cfemStatements`, keyed by vendor type) whenever `isCfem`. These `cfemStatements` still feed `furnmartStmt`/`afritecStmt`/`toplineStmt`/`cbStmt`/`boduloStmt`, but **the generic "Summary — Statement vs Payroll" table and "Employee Detail" table are hidden entirely for CFEM** (`!isCfem &&` guards on both, plus the unmatched-entries callout and the Management-section block) — CFEM never has a `payroll` upload in this system at all, so a "Payroll" column would only ever show blank/zero, which is exactly the confusing "displaying it as statement and payroll zero" behaviour that prompted this. **The CFE Cross-Reference section (below) is CFEM's only comparison view**, relabelled "Summary — CFEM Report vs CSL/NL Statements" to make clear it's the primary content, not a bolt-on: CFEM's own report acts as the payroll-equivalent source of truth on one side, CSL's/NL's shared vendor statements (filtered to CFE employees) as the "statement" side on the other. Below the vendor-total table, a per-employee detail table (one per vendor, `cfeCrossCheck[].details`) lists **every** CFE employee found on either side — not just the mismatches the amber callout already covers — so a genuine 1:1 comparison is visible per person, not just aggregated totals.

**CFE Cross-Reference** (CFEM tab only, below the main Summary table) — the actual "merge the cross reference" feature: a `useEffect` loads CSL's and NL's own `recon_uploads` (the 5 vendor types) for the *same year/month* being viewed on the CFEM tab (`csnStmtsForCfe` state, keyed `{ CSL, NL }`). For each vendor, lines from both hotels' statements are filtered down to CFE Management employees via `matchCfeEmployee()` — the result (`cfeCrossCheck`) is a per-vendor table: CFEM's own report total vs the matched total found embedded in CSL/NL's statements, plus a difference — with an amber callout below listing any employee present on one side but not the other (`onlyInCfem` / `onlyInEmbedded`), so gaps are traceable to a name, not just a number. This is a genuine second, independent comparison from the existing "Management (CFE) section" callout on CSL/NL's own Deductions Check tab (which only extracts from CB Stores/Topline's structural `MGMT` sections, not Furnmart/Afritec/Bodulo) — the two aren't reconciled against each other and can legitimately show different subsets.

**`matchCfeEmployee(name)` requires the SURNAME to appear as a token AND the first name's initial to match — not just any single shared token.** An earlier version matched on any single token (surname OR first name, either one sufficient); this was too loose — confirmed against real July 2026 data, it produced false positives (a different CSL employee named "Dorcus" got matched to CFE's Dorcus Shamukuni on first name alone; a different CSL employee surnamed "Nkwazi" got matched to CFE's Thomas Nkwazi on surname alone). Requiring both — surname token present AND first-name initial consistent — rejects both false positives while still correctly linking CFEM's initials-only report names ("MR B.A. BAAKILE", initial B) to CSL's full-name statement lines ("BABOLOKI BAAKILE", also initial B). It also correctly disambiguates the two same-surname pairs in CFE's own roster (Diane French vs James French; Hildah Tshekedi vs Presly Tshekedi) by their differing initials.

**Employee codes were considered and explicitly rejected as the primary signal, for two independent reasons — both confirmed against real production data, not assumed:**
1. CFE Management employees were never part of CSL's own payroll system, so the codes CSL retains (`EMP00xxx`, Afritec's own scheme) were never assigned to CFE staff at all — there's no shared code scheme to fall back to. Of CSL's 5 vendor files, only Afritec even has employee-style codes; Furnmart's are plain sequential numbers unrelated to identity, CB Stores/Topline are already name-only, and Bodulo's `name` field is just the employee code repeated (see below) — so code-based matching isn't available for 4 of 5 vendors regardless of what's uploaded.
2. CFEM's own report isn't fully self-consistent: one CB Stores line lists `"MRS D FRENCH"` (Diane) tagged with code `"FRE002"`, which actually belongs to **James** French in the DB (Diane's real code is `"FRE001"`) — a data-entry slip in CFEM's own source file. `resolveCfemLine()` (used only for CFEM's own report lines) tries name first via `matchCfeEmployee()` and only falls back to the `cfeCodeIndex` code lookup if the name doesn't resolve to anyone at all — trusting code over name here was tested and confirmed to misattribute Diane's deduction to James.

**Bodulo name-matching for CFE**: this used to be a blanket gap — `parseBodulo()`'s `name` field was always just the employee code repeated (e.g. `{ name: "EMP00316", empCode: "EMP00316" }`), never a real name, so `matchCfeEmployee()` had nothing to match on. `parseBodulo` now detects a real Name/Surname (or combined Employee/Customer Name) column when the uploaded file has one — see "Parsers" above — so name-matching works for those files. The code-repeated-as-name fallback still applies only to the original policy-list layout, which genuinely has no name column at all.

No new migration was needed for any of this — `recon_uploads.upload_type` is a plain `text` column with no CHECK constraint, so `'cfem_deductions'` just works as a new value alongside the existing types.

### Employees tab — month-to-month payroll comparison (CSL/NL only)

Replaces the earlier DB-vs-payroll comparison entirely — the user's explicit instruction was that reconciliation should be the benchmark that *drives* updates to the HR List, not something compared against a HR List that's assumed already correct. So this tab now compares **the current period's payroll upload against the previous period's payroll upload**, exactly the same mechanism the old Terminations tab used, extended to also surface salary changes and new hires. The DB `employees` table is never read, displayed, or written to by this tab.

**CFE is not part of this tab** — CFE never gets a payroll upload (its own confidential payroll, by design), so there's no month-to-month payroll comparison possible for it. `PayrollReconHotel = 'CSL' | 'NL'` and `PAYROLL_RECON_HOTELS` scope this tab to those two; the **Employees nav button itself is hidden** whenever the selected hotel pill isn't CSL or NL, and a guard `useEffect` bounces back to Upload if the pill switches to CFEM while Employees is open (avoids a stale/mislabeled view). CFE keeps its own separate Deductions Check cross-reference (see "CFE Management" above), unaffected by any of this.

**No internal CSL/NL sub-tab inside this tab** — it always shows whichever hotel is currently selected via the main header pill (`employeesActiveHotel`, derived from `hotel?.short_code`), the same hotel every other per-hotel tab (Upload, Deductions Check) is scoped to. An earlier version had its own CSL/NL toggle independent of the header pill, which was confusing (you could be looking at NL's Employees data while the CSL pill was highlighted) — removed in favour of one hotel selector for the whole page.

**Data**: `termPayrollByHotel: Record<PayrollReconHotel, { current, previous, loaded }>`, loaded via the shared `loadPeriodPayrollLines(hotelId, year, month)` helper for both the selected period and the one before it, whenever the tab opens or year/month/hotels changes.

**`buildEmployeesComparison(state)` matches by `nameKey(name)` only — deliberately not by employee code**, even though `PayrollLine.empCode` is available. Confirmed against real NL data: the payroll provider changed NL's employee code format between January (`"NL0020"`-style) and February (`"BAB001"`-style mnemonic) — matching by code would've flagged all 58 January employees as terminated (0 real leavers detected), while name matching correctly found the 1 actual leaver. Revisit code-based matching once the code format has been stable for a few consecutive months (the user flagged June→July as an earliest candidate) — until then, name is the only reliable key across periods for these hotels. Produces three buckets per hotel:
- **Basic Salary Mismatch** — matched by name in both periods, but `basic` differs by more than 0.5.
- **New Appointments** — present in `current`, no name match in `previous`.
- **Terminations** — present in `previous`, no name match in `current`.

The very first period a hotel uploads payroll for has no previous period to compare against, so it shows "nothing to compare against yet" rather than treating the whole roster as missing or new.

**Only Basic Salary crosses months — vendor deductions never do.** `buildEmployeesComparison()` only reads `.basic` off each `PayrollLine`; it never touches `furnmart`/`cbStores`/`bodulo`/the loan columns. The Deductions Check tab (`furnmartStmt`, `mergedTotals`, `payMap`, etc.) and the Consolidation tab are both derived entirely from `uploads`/period-scoped queries keyed to the *currently selected* `hotelId/year/month` — neither references `prevMonth`/`prevYear` anywhere. These are two fully independent computations (`termPayrollByHotel` state vs `uploads` state) with no shared code path, so there's no risk of a vendor deduction accidentally comparing against a prior month, or Basic Salary Mismatch accidentally pulling in a deduction column.

### Employees tab — Submit and Commit (the HR List write-back)

Each row in all three sections gets a checkbox (`approvalTicks`, keyed `` `${category}|${name}` ``). Ticking only updates local React state — nothing is written until **Submit**.

**Submit** (any role with access to this tab) — `submitEmployeeApprovals()` upserts the *current* tick state for every row currently visible into `recon_employee_approvals` (migration 022; `UNIQUE(hotel_id, period_year, period_month, category, employee_name)`), including unticked ones (`approved: false`) so un-ticking something previously submitted also persists. This is purely a staging/audit record — nothing here touches `employees` or `salary_records`. Loaded back on tab open (a separate `useEffect`, keyed to `hotelId`/year/month) so ticks survive navigation.

**Confirmed badge + Submitted button state** — a row whose last-submitted state was `approved: true` shows a green "Confirmed" pill next to the employee's name (looked up via `approvalByKey`, a `Map` built from `employeeApprovals` keyed the same way as `approvalTicks`). The Submit button itself reads **"Submitted"** once every currently-visible row's local tick matches what's actually persisted (`isSubmittedInSync`); ticking/un-ticking anything afterward makes it diverge from the saved state, so the button reverts to `Submit (X of Y ticked)` until re-submitted.

**Commit button lives in the header, next to the hotel pills and the Consolidation button** — not inside the Employees tab content — so it's reachable from any sub-tab, not just Employees. It's rendered only when `userRole === 'admin'` **and** the currently selected hotel pill is CSL or NL (Commit has no meaning for CFEM). Because of this, the approvals-loading `useEffect` is **not** gated to `tab === 'crossref'` — it loads for CSL/NL regardless of which sub-tab is open, so the header button's pending count is always accurate. The confirmation popup (`showCommitConfirm`) is likewise rendered at the top level of the component (right after the header, before the tab nav), not nested inside the Employees tab's JSX, since the button that opens it no longer lives there.

**Commit** (`commitEmployeeApprovals()`) — **admin-only** (`userRole === 'admin'`, fetched from `/api/auth/me`'s `UserContext.role`; the button doesn't render at all for sub-users, regardless of whether they've been granted the Reconciliation tab via `allowed_tabs`). Gated behind the confirmation popup above, which lists exactly what will be written — including the surname/first-name split for any new appointment, since splitting a payroll file's single name column is inherently a guess (`splitNameForNewEmployee()`: strip salutation, last word = surname, everything before it = first name) and this is the one chance to catch a bad split before it's saved. Per instruction, this is a **straight update/override — no re-flagging afterward**: it directly writes to `employees`/`salary_records` for whichever of CSL/NL is currently selected, matching each approved row to an existing employee by code first (`employee_code`, snapshotted at Submit time) then by `nameKey(surname + first_name)`:
- **Termination** → `employees.status = 'terminated'`.
- **Basic Salary Mismatch** → upserts `salary_records.basic_salary` for that employee/period (`onConflict: employee_id,period_year,period_month`) to `detail.currBasic`.
- **New Appointment** → only if no existing employee resolves — inserts a new `employees` row (status `active`) plus a minimal `salary_records` row, mirroring the shape the HR List import (`confirmImport`) already writes for new hires.

Each committed row gets `committed_at`/`committed_by` set (migration 023) so a later commit run doesn't re-apply it — `pendingCommitApprovals` (what the Commit button acts on and what the confirmation popup lists) is always `approved && !committed_at`. Since the Employees tab's comparison itself is driven entirely by payroll-upload-to-payroll-upload data (see above), committing to `employees` doesn't feed back into or suppress next month's comparison — the two are one-directional (recon → HR List), not a loop.

**Scope**: this entire Submit/Commit flow only exists on the Employees tab, which is CSL/NL-only (see above) — CFE is untouched by any of it.

### Consolidation tab — director-facing monthly bank release sign-off

Spans **all three hotels** (CSL, NL, CFEM) for one month at once, independent of the main hotel-tab selector — this is deliberate, since the director signs off the whole month's bank release together, not hotel-by-hotel. Has its own month/year selector (reuses the shared `month`/`year` state).

**Entry point lives in the header, next to the hotel pills** (not in the per-hotel tab row below) — it isn't scoped to any one hotel, so it doesn't belong alongside Upload/Deductions Check/Employees. Clicking it sets `tab = 'consolidation'`, which hides the entire per-hotel tab row (Upload/Deductions Check/Employees) since none of them apply while viewing it; clicking any hotel pill while on Consolidation switches back to that hotel's Upload tab.

**Table orientation**: rows are the three hotels (CSL, NL, CFEM), each spanning 3 sub-rows (System / Bank Upload / Balance Differential, via `rowSpan`); columns are the 7 line items (`LINE_ITEMS`): Basic Salary, Furnmart, Afritec, Topline, CB Stores, Bodulo/Afri Insurance, Pension — plus a Total column. A matching Total row group at the bottom sums across all 3 hotels per line item. The Excel export (`handleExportConsolidation`) mirrors this exact layout (one row per hotel per sub-row, one column per line item).
- **System** — auto-computed from whatever's already parsed for that period: CSL/NL's Basic Salary sums `payroll` + `ftc_payroll` line `.basic`; CSL/NL's vendor totals (including Pension) read each statement upload's `.total`; CFEM's vendor totals come from `cfem_deductions`' per-section totals via `CFEM_VENDOR_TO_TYPE`, **except Pension**, which CFEM uploads directly (its own `pension` upload slot, not part of the combined `cfem_deductions` report) and is read via `get('pension')` the same way as CSL/NL. **CFEM's Basic Salary has no automatic source at all** (CFEM's payroll is never uploaded here, by design) — that one cell is the sole exception across all hotels/line items, and becomes an editable manual entry instead (`consolidationIsManualSystem()` returns true only for `CFEM` + `basic_salary`).
- **Bank** — always a manual entry, reflecting what was actually paid to the bank for that line item.
- **Diff** — System − Bank; should be zero once the release is confirmed.

**Manual entries are persisted** (per the user's explicit choice — "create the manual entry onto the platform") in `recon_consolidation` (migration 021), keyed `(period_year, period_month, hotel_short_code, line_item)`, upserted on blur via `saveConsolidationEntry()`. Reopening the tab later shows the same figures — this is the audit trail, not a one-off Excel-only entry.

**Export to Excel** reuses the existing generic `exportReport()` from `src/lib/reports-export.ts` (the same exporter the Reports page and Leave Provision page use) rather than a bespoke exporter — one sheet, one row per line item plus a totals row, 13 columns (Line Item + System/Bank/Diff × CSL/NL/CFEM/Total). Filename: `Consolidation_{Month}_{Year}.xlsx`.

**DB tables** (migration 015, extended by 020, 021):
- `reconciliation_periods` — one row per hotel/year/month; `status` open/submitted/approved
- `recon_uploads` — one row per period per upload type (UNIQUE constraint); `parsed_data` jsonb holds the parsed output
- `recon_queries`, `recon_terminations` (migration 020) — still exist with any historical data intact, but are **no longer read or written by the UI** (Queries tab and the old Terminations flag/confirm/reinstate log were both removed — see above)
- `recon_consolidation` (migration 021) — one row per (period, hotel, line item); `system_amount` is a manual override used only where no automatic source exists (CFEM Basic Salary); `bank_amount` is always manual

---

## Access Control

`/dashboard/access` — admin-only user management page.

**Roles**:
- `admin` — full access to all tabs and all hotels
- `sub` — hotel-restricted (via `hotel_ids`) and tab-restricted (via `allowed_tabs`, see below)

**Configurable tabs per sub user** (migration `016_user_allowed_tabs.sql`, column `users.allowed_tabs text[]`): admins individually grant/revoke **Dashboard**, **Employees**, **Import HR List**, **Reconciliation**, **Reports**, and **Methods** per sub user via checkboxes on the Access page. **Salary Review and Access stay permanently admin-only** regardless of `allowed_tabs` — not configurable, by design (Access in particular would be a privilege-escalation risk if grantable). The canonical list of configurable tabs is `CONFIGURABLE_TABS` in `src/lib/auth.ts`; `middleware.ts`, `nav-sidebar.tsx`, and `access/page.tsx` all import from there rather than duplicating the tab list.

**Default/legacy fallback**: `allowed_tabs: null` (pre-migration-016 sub users, or an already-issued cookie from before this shipped, which won't carry the field until the user logs in again) falls back to `DEFAULT_SUB_TABS = ['employees', 'import', 'reconciliation']` — the fixed set every sub user had before *any* of this became configurable. Note this deliberately does **not** include Dashboard/Reports/Methods even though they're now configurable — those were never accessible to sub users before, so the safe legacy default excludes them; an admin must explicitly check them per user.

**Nav**: `nav-sidebar.tsx` renders `ADMIN_NAV` unfiltered for admins; for sub users it filters `SUB_NAV` down to whichever tab `key`s are in `allowedTabs` (prop passed from `dashboard/layout.tsx`, sourced from the cookie's `UserContext.allowedTabs`).

**Middleware** (`src/middleware.ts`) — two layers for sub users:
1. `SUB_BLOCKED` (always-blocked paths, not configurable): `/dashboard/salary-review`, `/dashboard/access`.
2. `TAB_ROUTES` — maps each configurable tab key to its route prefix(es); a sub user hitting a configurable tab's route without that key in `allowedTabs` is redirected away. `'dashboard'` is matched via `matchTab()` as an **exact** path (`pathname === '/dashboard'`) rather than a prefix, since `/dashboard` is also a string-prefix of every other tab's route (`/dashboard/employees`, etc.) — a naive `startsWith` would misclassify all of them as the dashboard tab. `/dashboard/settings` (a redirect shim to Methods) is gated as a second prefix under the `'methods'` key rather than its own tab.

Both cases redirect to the user's first allowed tab (computed from `CONFIGURABLE_TABS` order ∩ `allowedTabs`), falling back to `/login` only if a sub user somehow has zero tabs granted (the Access page's save validation prevents this via the UI, but doesn't stop a zero-tab state some other way).

**Hotel filtering for sub-users**: `employees/page.tsx`, `import/page.tsx`, `reconciliation/page.tsx`, `SalarySummaryTable.tsx` (Dashboard), `reports/page.tsx`, and `methods/page.tsx` all call `GET /api/auth/me` on mount and filter to `user.hotelIds`. This is a single global hotel list per user — there is no per-tab hotel scoping (e.g. you cannot give a sub user all hotels for Reconciliation but only CSL/NL for Employees); `hotelIds` applies uniformly across whichever tabs are granted. On Dashboard and Reports specifically, both the hotel list **and** the underlying `employees` array are filtered (not just the hotel checkbox list) — both pages treat an empty hotel-selection as "show all", which would otherwise silently leak non-permitted hotels' data if only the checkbox list were restricted.

---

## Methods Page

`/dashboard/methods` — configurable payroll rates per hotel (replaces old Settings page).

**Contributions section**: PF EE, PF ER (single rate for SA; junior/senior split for BW), UIF + cap, SDL, WCA — all with "Include in CTC" checkbox. Botswana rows for UIF/SDL/WCA are shown greyed with "Exempt" label.

**Provisions section**: Staff Meals standard/manager, Leave Accrual (`days / 365 × %`), Bonus Provision (`days / 365 × %`) — each with "Include in CTC" checkbox. The `%` multiplier (stored as `leave_accrual_pct` / `bonus_provision_pct` on `hotels`) is applied after the days/365 factor: `basic × (days/365) × pct`.

**Save & Update All [Hotel] Employees** — saves rates to `hotels` table, then recalculates and updates the latest salary record for every active employee in the hotel. Employees with `incentive_applicable` keep their incentive and receive no `bonus_provision` (this is handled inside `calculateBurden`, not special-cased here).

**Leave Provision section**: a single "Daily Rate" divisor per hotel (`hotels.leave_provision_divisor`, default 26 Botswana / 30.42 South Africa). Feeds only the Leave Provision tab's calculation — not included in `calculateBurden()`, not saved via the "Save & Update All" recompute loop (it's read fresh at import/recalculate time, never baked into a stored payroll burden figure).

---

## Leave Provision

`/dashboard/leave-provision` — standalone annual (July) leave balance provisioning. Nav tab positioned directly under Employees; configurable per sub-user via Access (key `leaveProvision` in `CONFIGURABLE_TABS`, not included in `DEFAULT_SUB_TABS` — same "never accessible before, must be explicitly granted" precedent as Reports/Methods).

**Deliberately standalone from payroll burden** — does not affect `calculateBurden()`, `ctc`, `total_cost`, the Reports field list, or the Employees column picker. It answers a different question ("what would we owe today for banked leave days") from the existing `leave_accrual` column (a forward-looking monthly estimate, `basic × days/365 × pct`) and the legacy `leave_provision` column on `salary_records` (a VIP 710 passthrough) — none of these three are meant to reconcile with each other.

**Data model**: dedicated `leave_provisions` table (migration 019), one row per employee per `period_year`, **not** stored on `salary_records` — avoids any risk of an upsert on `(employee_id, period_year, period_month)` clobbering a real payroll record for that period. Columns: `leave_balance_days` (imported), `daily_rate` + `provision_value` (computed), `basic_at_calc` (despite the name, this is **gross salary** — `total_earnings`, inclusive of the structure allowance — used for the calc, for audit; never basic or CTC), `import_id`, `imported_at`.

**Populating data**: only via the Leave Balance Import format on the Import HR List page (see Import Formats above) — there is no manual entry UI. Employees with no row for the selected year are simply omitted from the table (no synthetic zero rows).

**24-day cap** (`LEAVE_PROVISION_CAP_DAYS` in `payroll-calc.ts`) — the provision Rand value is only ever calculated up to 24 days, regardless of how large the actual imported balance is. The table shows both **Actual Leave Balance** (`leave_provisions.leave_balance_days`, uncapped, exactly as imported) and **Capped Leave Balance** (`min(actual, 24)`, computed client-side — not a stored column) side by side, so the difference is always visible. `daily_rate`/`provision_value` in the DB are always derived from the capped figure, both at import time and by Recalculate.

**Page**: hotel selector with an **"All Hotels"** option (unlike the Employees page's single-hotel-only convention) — selecting it adds a Hotel column, groups the totals row by currency (ZAR/BWP shown separately, since Botswana and South Africa hotels use different currencies and summing across them would be meaningless), and Recalculate/Export operate across every visible row. A Year selector is populated from whichever `period_year` values exist for the current hotel selection. Table: Hotel (All Hotels view only) / Emp Code / Surname / First Name / Grade / Actual Leave Balance / Capped Leave Balance / Daily Rate / Provision Value / Imported date, with a totals row. **Recalculate** re-reads each employee's *current* `basic_salary` and their hotel's *current* `leave_provision_divisor` to refresh `daily_rate`/`provision_value` in place (still capped at 24 days) — useful if a raise happened after the July import, or after the cap/divisor changes. Recalculate never touches `leave_balance_days`; only a fresh import can change the actual balance. **Export to Excel** (via `exportReport()` in `src/lib/reports-export.ts`, the same generic exporter the Reports page uses) writes the currently visible rows plus the totals row to a single-sheet workbook named `Leave_Provision_{HotelOrAllHotels}_{year}.xlsx`.

---

## Employee CSV Export / Round-trip

Export: **Export CSV** button in the Employees page header — exports whichever hotel is currently selected in the page filter (no separate hotel dropdown). Downloads `{ShortCode}_employees_{YYYYMM}.csv` containing all employee fields plus full latest salary record for each employee (51 columns).

Re-import: via Import page — select the same hotel, upload the CSV. Format is auto-detected. All employee fields and the complete salary record are written verbatim; run Calculate Burden or Methods → Save & Update afterwards to recalculate computed fields.

---

## Column Visibility (Employees page)

Persisted in `localStorage` under key `'ihg-salary-emp-cols-{hotelId}'` — **per-hotel**, not shared. The picker uses a **draft pattern** — selections stage inside the dropdown and only apply when the user clicks **OK**. Hotel filter persisted under `'ihg-salary-emp-hotel'`.

**Hotel filter has no "All Hotels" option** — always shows one hotel. On mount the hotel is resolved inside `load()` after the hotel list arrives: validates the localStorage value against live hotel IDs, falls back to first hotel if missing or stale. The employee detail page writes the employee's hotel ID to the same key so "Back to Employees" always lands on the correct hotel.

**Batch delete** — checkbox on each row (header checkbox selects all visible). A red "Delete X selected" button appears in the toolbar when rows are ticked; confirms then deletes employees + all their salary records in one operation. Selection clears on hotel/search filter change.

**"Not in last import" red flag** — `employees.last_seen_at` is stamped (same timestamp for every row in one import) whenever an employee is matched or added by a **CSL Payroll Schedule** import (`confirmPayrollSchedule`) or an **HR List** import (`confirmImport`, `importType === 'employee'`). Deliberately not touched by manual edits, Calculate Burden, VIP, or Medical Aid imports — it only means "was this person actually on the roster file last time." The Employees page (`staleIds` memo) computes, per hotel, the max `last_seen_at` among active employees and flags anyone whose value is null or older than that max — with a red row tint, red surname text, and a "not in last import" badge — as likely no longer employed. For CSL/NL this comparison is done **separately per Permanent/Fixed Term segment** (via the same `secondaryTab.grades` split used by the Permanent/Fixed Term toggle), since those two rosters are uploaded as separate files; a segment with no tracked `last_seen_at` yet is left unflagged rather than red-flagging everyone. Flagged rows use the existing row checkbox + batch delete to action.

**Add Employee modal** — button in the page header opens a form covering hotel, surname/first name (required), employee code (optional — blank for ANO positions), job title, department code, grade, status, employment date, and an initial salary record (basic, gross, period month/year). Inserts one row into `employees` and one into `salary_records`.

**Permanent/Fixed Term toggle** — shown only for CSL and NL (`showFtcToggle = selectedHotel.short_code === 'CSL' || 'NL'`). Filters the employee list (and CSV export) by whether `grade_label` is `'Fixed Term'` (via `SECONDARY_GRADE_TABS[...].grades`) vs. everyone else. The same toggle exists on the Import page for these two hotels.

Default visible columns: Emp Code, Surname, First Name, Hotel, Department, Job Title, Grade, Basic Salary, Gross Salary, CTC.

Column groups and membership:
- **Employee**: Emp Code, Surname, First Name, Hotel, Department, Job Title, Start Date, Yrs Service, Grade (`structure` col → `grade_label`) — Yrs Service appears before Grade in column order
- **Salary**: Basic Salary, Structure (`structure_sal` col → reads `allowances.structure` from the salary record), Gross Salary, CTC
- **Benefits**: Medical (Co), Prov Fund (Co)
- **Legislative**: UIF (Co), SDL, WCA
- **Provisions**: Staff Meals, Bonus Provision, Incentive, Gratuity, Severance, Leave

**Note**: `bonus_accrual_dec` and `mgmt_incentive` are NOT displayed in the column picker (no calculation attached). `leave_accrual` is in the Provisions group (labelled "Leave"). There is no Deductions or Accruals group. The Generate Codes button has been removed.

**Category sum view** — a select dropdown overrides the column picker to show only anchor columns + the chosen group, with a totals row at the bottom.

Zero monetary values display as "—" (not "R0" or "P0").

---

## Grade Labels

`employees.grade_label` is a free-text field set manually (not from VIP). Canonical values (enforced by `GRADE_MAP` in `import/page.tsx` on import):
`ANO`, `Fixed Term`, `DNQ`, `Frontline`, `Supervisory`, `Management`, `Executive`, `Flexible`

Free-text variants like `"front line"`, `"exec"`, `"supervisor"`, `"flexible"`, `"fixed term"`, `"fixed_term"`, `"ftc"` are normalised to the canonical form on import (all four fixed-term variants map to `Fixed Term`). The salary review grade filter and dashboard grade badges use these same canonical values. `Unclassified` is displayed for employees whose `grade_label` is null.

**`FTC` → `Fixed Term` rename (2026-07-16)** — the canonical grade value was previously `FTC`; it was renamed to the more readable `Fixed Term` across all grade dropdowns, the `GRADE_MAP` import normalisation, the CSL/NL Permanent/Fixed Term employee-list toggle, and the reconciliation Employees-tab badges. Migration `018_ftc_to_fixed_term.sql` updates existing `employees.grade_label = 'FTC'` rows in the DB to match. Code (variable/function names like `FTC_MONTH_NAMES`, `parseFtcPayrollXls`, `importAsFtc`) and comments referring to "FTC" as shorthand for "Fixed Term Contract" payroll files were left as-is — they don't affect any user-facing grade label.

**Grade filters do exact string matching** — `SalarySummaryTable`'s grade checkboxes key off `grade_label` matching the canonical spelling exactly. Any employee whose `grade_label` is a near-miss (wrong casing/spacing, or a value never normalised) silently disappears the moment a grade filter is touched, without any error — the headcount just looks wrong. This bit production data twice: `"Front Line"` (should be `Frontline`) at ILRB (26 employees) and ILG (24 employees), and `"Supervisor"` (should be `Supervisory`) at IH (19 employees) — all three normalised in production. These predated (or bypassed) the current `GRADE_MAP`/dropdown-only grade inputs, which prevent new stray values going forward. If a hotel's dashboard headcount looks implausibly low after filtering by grade, check for non-canonical `grade_label` strings at that hotel before assuming a calculation bug — the per-employee "+" drill-down on each hotel row is the fastest way to spot who's missing.

`status` on `employees` has three DB values (`active`, `terminated`, `on_leave`) but **`on_leave` is removed from all UI dropdowns** — only `active` and `terminated` appear in forms. Existing DB records with `on_leave` are preserved and readable; the type in `database.ts` retains the union for backward compatibility.

---

## Styling

Tailwind CSS v4 + Shadcn UI base-nova. Custom tokens in `global.css`. Standard colours: `bg-white` for cards, `bg-muted/40` for table headers, `text-muted-foreground` for secondary text, `text-primary` for action items.

Monetary values: always use `fmtZAR(n)` or `fmtCurrency(n, country)` from `src/lib/utils.ts`. Botswana amounts display as "P X,XXX", South Africa as "R X,XXX". Always pass `hotel.country` (the full country string) to `fmtCurrency` — it checks `includes('botswana')` but does **not** handle the `'bw'` short code that `isBotswana()` handles, so passing `hotel.short_code` would produce incorrect ZAR formatting for Botswana hotels.
