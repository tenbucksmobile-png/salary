# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A web-based **HR salary management system** for 6 IHG CFE hotel properties, replacing an Excel-based salary review workflow. Built with Next.js (App Router) + Supabase + Shadcn UI. Password-gated (no user accounts — single shared password via cookie).

Core workflows:
- **Import** employee data from VIP Report 710 payroll files, tabular Excel CSV/TSV exports, Medical Aid update files, or round-trip employee CSV exports
- **View & edit** employees across all 6 properties with flexible column visibility
- **Export** employees per hotel as a CSV, edit offsite, and re-import
- **Calculate payroll burden** automatically (provident fund, UIF, SDL, WCA, staff meals, leave accrual, bonus, incentive, severance, gratuity)
- **Salary review** forecasting — per-hotel % or flat increase with per-employee overrides and exclusions; commit to salary records
- **Methods** — configure all statutory rates and CTC inclusion flags per hotel; "Save & Update All" recalculates every active employee

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

Botswana hotels are detected via `hotel.country` containing "botswana". Always use this field — never hardcode short codes for the exemption check. `isBotswana()` in `src/lib/payroll-calc.ts` is the canonical check.

The hotel seed data in `001_initial_schema.sql` uses older names and includes an "APA" entry not present in production. Trust the live `hotels` table, not the seed.

---

## Tech Stack

- **Next.js 16** (App Router, TypeScript, React 19)
- **Supabase** — project ref `fnpfgrpaxoedzvfjrlky` (separate from all other projects)
- **Shadcn UI v4** — style: base-nova, uses `@base-ui/react`. No `asChild` on Button.
- **Tailwind CSS v4** with oklch colour tokens
- **Auth**: HMAC-SHA256 cookie gate — `SITE_PASSWORD` + `COOKIE_SECRET` env vars, cookie name `ihg-salary-auth`, 30-day expiry. No Supabase auth — middleware handles it.

---

## Commands

```bash
npm install
npm run dev        # localhost:3000
npm run build      # also runs TypeScript type-check (no separate tsc script)
npm run start
```

There is no dedicated `typecheck` or `lint` script — `npm run build` is the fastest way to catch type errors.

---

## Critical Rules

- **Never run `supabase db push --linked`** — apply migrations individually via Supabase Dashboard → SQL Editor.
- **`SITE_PASSWORD` must be quoted in `.env.local` if it contains `#`** — unquoted `#` is treated as a comment: `SITE_PASSWORD="#IHG_HRMngmt2026"`.
- **`$VAR` strings in env blocks are not shell-expanded** — keep secrets in `.env.local` only.
- **RLS uses `anon_all` policies** — security is enforced by the middleware cookie check, not Supabase auth.

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=https://fnpfgrpaxoedzvfjrlky.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SITE_PASSWORD="<password>"        # wrap in quotes if it contains special chars
COOKIE_SECRET=<32+ char random>   # used for HMAC cookie signing
```

---

## Architecture Notes

**All dashboard pages are `'use client'`** — the entire dashboard fetches data directly from Supabase using the browser client (`src/lib/supabase/client.ts`). There are no React Server Components in the dashboard; `src/lib/supabase/server.ts` is not currently used.

**`latest_salary` DB view** — this view exists in the database but is not queried by the app. All pages compute the latest salary record client-side by sorting `salary_records` by `period_year` desc / `period_month` desc and taking the first match per `employee_id`.

**Salary records are period-keyed** — the unique constraint is `(employee_id, period_year, period_month)`. Imports upsert on this key. The Salary Review commit creates a new record for the target month.

**Auth flow**: `POST /api/auth/login` validates password, issues HMAC token as httpOnly cookie. `middleware.ts` validates that cookie on every non-login, non-static route. `POST /api/auth/logout` clears the cookie.

---

## Database

### Key Tables

| Table | Purpose |
|-------|---------|
| `hotels` | 6 properties; `country`, `short_code`, `wca_rate`, + configurable method rate columns (see migration 009) |
| `employees` | One row per employee; `hotel_id`, `surname`, `first_name`, `grade_label`, `employment_date`, `nmw_applicable`, `severance_applicable`, `incentive_applicable`, `incentive_multiplier`, `gratuity_applicable`, `gratuity_rate`, `comments` |
| `salary_records` | One row per employee per payroll period; full earnings, deductions, contributions, provisions, accruals |
| `payroll_imports` | Audit log of each import |
| `increase_scenarios` | Named salary increase scenarios; `status` is `draft`, `applied`, or `committed` |
| `scenario_lines` | One row per employee per scenario; stores before/after basic and CTC |

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

### `hotels` configurable method columns (from migration 009)

All rates stored as decimals (e.g. 0.07 = 7%). All displayed as percentages in the Methods UI.

`provident_ee_rate`, `provident_er_rate`, `provident_er_rate_senior` (BW tenure split), `uif_rate`, `uif_cap` (R amount), `sdl_rate`, `meals_standard`, `meals_manager`, `leave_days`, `bonus_days`

CTC inclusion flags (boolean, default false for provisions): `ctc_provident_er`, `ctc_uif_er`, `ctc_sdl`, `ctc_wca`, `ctc_meals`, `ctc_leave_accrual`, `ctc_bonus`

### `salary_records` column groups

**Earnings**: `basic_salary`, `allowances` (jsonb), `total_earnings`
**Employee deductions**: `tax_paye`, `uif_employee`, `medical_employee`, `ancilla_employee`, `provident_employee`, `total_deductions`
**Company contributions**: `uif_company`, `medical_company`, `provident_company`, `sdl_company`, `ancilla_company`, `total_company_contrib`
**Provisions**: `wca_company`, `staff_meals`, `bonus_provision`, `incentive`, `leave_provision`, `other_company_contrib`, `total_payroll_burden`, `total_cost`
**Leave & accruals**: `leave_days`, `leave_accrual`, `bonus_payout_factor`, `bonus_accrual_dec`, `bonus_accrual_july`, `mgmt_incentive`
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
| Leave Accrual | SA 24 days, BW 21 days | × Basic / 365 |
| Bonus Provision | SA 30.42 days, BW 26 days | × Gross / 365; 0 when `incentive_applicable` |

### `BurdenResult.ctc`

`calculateBurden()` now returns `ctc` directly. It equals `total_earnings` + all ER items where the hotel's CTC flag is `true`. Defaults preserve backward-compatible behaviour (ER contributions in CTC, provisions out). All call sites should use `burden.ctc` — do not recompute `total_earnings + total_company_contrib`.

### Per-employee flags

- `incentiveApplicable` — sets `incentive = gross × multiplier / 12`; skips `bonus_provision`
- `severanceApplicable` (BW) — `severance = basic/26 × (1 or 2 days/month based on tenure)`
- `gratuityApplicable` — `gratuity = gross × rate%`

---

## Import Formats

The import page (`/dashboard/import`) auto-detects the file format on upload (hotel must be selected first).

Detection order: round-trip CSV → medical aid → employee details → VIP 710.

### VIP Report 710 (fixed-width payroll register)

- Parser: `src/lib/vip-parser.ts` → `parseVIPReport()`
- Splits on `={10,}` separator lines; period detected from `TxDt:` field
- Matched by `employee_code` within the selected hotel

### Employee Details (CSV or TSV from Excel)

- Parser: `src/lib/vip-parser.ts` → `parseTSVEmployeeFile()`
- Detected: first line starts with "Surname" and contains "Gross"
- Matched by surname + first_name; salary period set manually in UI

### Medical Aid Update (CSV from medical aid provider)

- Parser: `src/lib/vip-parser.ts` → `parseMedicalAidFile()`
- Detected: first line starts with "Surname" and contains "Medical"
- Updates `medical_company` on the latest salary record; adjusts `total_company_contrib`, `total_payroll_burden`, `total_cost`, `ctc`

### Employee CSV Round-trip (exported from Employees page)

- Parser: `src/lib/employee-csv.ts` → `parseEmployeeCsvExport()`
- Detected: first line starts with `employee_code,` and contains `period_month`
- Matches by `employee_code` within the selected hotel; updates all employee fields + upserts the full salary record
- After import, run Calculate Burden or Methods → Save & Update to recalculate contributions

---

## Key Files

```
src/
  app/
    api/auth/
      login/route.ts       — POST: validates password, sets HMAC cookie
      logout/route.ts      — POST: clears cookie
    login/page.tsx         — Login form
    dashboard/
      page.tsx             — Dashboard summary with SalarySummaryTable
      SalarySummaryTable.tsx — Hotel-level before/after salary review table
      employees/
        page.tsx           — Employee list; column picker, hotel CSV export, Calculate Burden
        [id]/page.tsx      — Employee detail + edit form
      import/page.tsx      — Multi-format import (VIP, Employee TSV, Medical Aid, Round-trip CSV)
      methods/page.tsx     — Configurable payroll rates + CTC flags per hotel; Save & Update All
      settings/page.tsx    — Redirects to /dashboard/methods
      salary-review/page.tsx — Per-hotel increase builder with per-employee overrides/exclusions; commit to salary_records
  lib/
    payroll-calc.ts        — calculateBurden(); isBotswana(), isManager(); BurdenInput/BurdenResult
    vip-parser.ts          — VIP 710, TSV employee details, medical aid parsers
    employee-csv.ts        — Round-trip CSV export builder (buildEmployeeCsv) + import parser
    excel-export.ts        — Salary review Excel export (xlsx-js-style)
    supabase/
      client.ts            — Browser Supabase client (used by all dashboard pages)
    utils.ts               — fmtZAR(), fmtCurrency(), MONTH_NAMES, cn()
  components/
    nav-sidebar.tsx        — Dashboard navigation
  middleware.ts            — HMAC cookie auth gate
  types/
    database.ts            — Hotel, Employee, SalaryRecord, PayrollImport, IncreaseScenario, ScenarioLine
```

---

## Salary Review

`/dashboard/salary-review` — per-hotel increase scenario builder.

**State pattern**: settings are stored per hotel in a `Map<string, HotelSettings>` + a `hotelSettingsRef` (React ref) to avoid stale closure issues on hotel-tab switches. Each hotel has independent `pct`, `flat`, `grade`, `overrides` (per-employee), and `excluded` (employees skipped on commit).

**Save button** — persists the current hotel's settings into the map without writing to DB.

**Exclusions** — checkbox per employee row. Excluded employees show `opacity-45` + "excluded" badge; they appear in the preview/export at 0% but are skipped on Commit (no salary record written for them).

**Commit** — iterates all saved hotels, calls `calculateBurden` with each hotel's method rates, writes `increase_scenarios`, `scenario_lines`, and new `salary_records` records for the target month/year.

---

## Methods Page

`/dashboard/methods` — configurable payroll rates per hotel (replaces old Settings page).

**Contributions section**: PF EE, PF ER (single rate for SA; junior/senior split for BW), UIF + cap, SDL, WCA — all with "Include in CTC" checkbox. Botswana rows for UIF/SDL/WCA are shown greyed with "Exempt" label.

**Provisions section**: Staff Meals standard/manager, Leave Accrual days/year, Bonus Provision days/year — each with "Include in CTC" checkbox.

**Save & Update All [Hotel] Employees** — saves rates to `hotels` table, then recalculates and updates the latest salary record for every active employee in the hotel. Employees with `incentive_applicable` keep their incentive and receive no `bonus_provision` (this is handled inside `calculateBurden`, not special-cased here).

---

## Employee CSV Export / Round-trip

Export: hotel selector + **Export CSV** button in the Employees page header. Downloads `{ShortCode}_employees_{YYYYMM}.csv` containing all employee fields plus full latest salary record for each employee (51 columns).

Re-import: via Import page — select the same hotel, upload the CSV. Format is auto-detected. All employee fields and the complete salary record are written verbatim; run Calculate Burden or Methods → Save & Update afterwards to recalculate computed fields.

---

## Column Visibility (Employees page)

Persisted in `localStorage` under key `'ihg-salary-emp-cols'`. The picker uses a **draft pattern** — selections stage inside the dropdown and only apply when the user clicks **OK**. Hotel filter persisted under `'ihg-salary-emp-hotel'`.

Column groups: Employee · Salary · Deductions · Contributions · Provisions · Accruals

**Category sum view** — a select dropdown overrides the column picker to show only anchor columns + the chosen group, with a totals row at the bottom.

---

## Grade Labels

`employees.grade_label` is a free-text field set manually (not from VIP). Options used across properties:
`ANO`, `Front Line`, `Supervisory`, `Middle Management`, `Management`, `Exec`

---

## Styling

Tailwind CSS v4 + Shadcn UI base-nova. Custom tokens in `global.css`. Standard colours: `bg-white` for cards, `bg-muted/40` for table headers, `text-muted-foreground` for secondary text, `text-primary` for action items.

Monetary values: always use `fmtZAR(n)` or `fmtCurrency(n, country)` from `src/lib/utils.ts`. Botswana amounts display as "P X,XXX", South Africa as "R X,XXX".
