# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A web-based **HR salary management system** for 6 IHG CFE hotel properties, replacing an Excel-based salary review workflow. Built with Next.js (App Router) + Supabase + Shadcn UI. Multi-user access-controlled (admin + sub-user roles; username/password login via HMAC-signed cookie).

Core workflows:
- **Import** employee data from VIP Report 710 payroll files, tabular Excel CSV/TSV exports, Medical Aid update files, or round-trip employee CSV exports
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

**Server vs client split**: `src/app/dashboard/page.tsx` (the main dashboard) is a **React Server Component** — it uses `src/lib/supabase/server.ts` and fetches all hotels, active employees, all salary records, and payroll imports in a single `Promise.all`. `SalarySummaryTable.tsx` is `'use client'` despite being rendered inside the RSC page — it runs its own parallel Supabase queries client-side (hotels, employees, salary records, and scenarios). All other dashboard sub-pages (`employees/`, `import/`, `methods/`, `salary-review/`) are `'use client'` and query Supabase directly via `src/lib/supabase/client.ts`.

**`latest_salary` DB view** — this view exists in the database but is not queried by the app. All pages compute the latest salary record client-side by sorting `salary_records` by `period_year` desc / `period_month` desc and taking the first match per `employee_id`.

**Salary records are period-keyed** — the unique constraint is `(employee_id, period_year, period_month)`. Imports upsert on this key. The Salary Review commit creates a new record for the target month.

**Auth flow**: `POST /api/auth/login` queries the `users` table, verifies HMAC password hash, issues signed cookie (`ihg-salary-auth`, 30-day max-age). `middleware.ts` verifies the cookie and enforces role-based access. `POST /api/auth/logout` clears the cookie. `GET /api/auth/me` returns the current `UserContext`. Admin CRUD for users at `POST/PATCH/DELETE /api/access`.

**UserContext** (encoded in cookie): `{ id, username, role: 'admin'|'sub', hotelIds: string[]|null }`. `hotelIds: null` means all hotels (admin). Sub-users are restricted to assigned hotels and can only access `/dashboard/employees` and `/dashboard/import`.

**Bootstrap**: if the `users` table is empty when login is attempted, the first login auto-creates an admin using the submitted credentials + `SITE_PASSWORD` check.

**Composite types in `types/database.ts`**: `EmployeeWithSalary` extends `Employee` with optional `hotel?: Hotel` and `latest_salary?: SalaryRecord` — used across dashboard pages. `HotelStats` is the per-hotel aggregate shape used by the dashboard summary.

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

### `hotels` configurable method columns (from migration 009)

All rates stored as decimals (e.g. 0.07 = 7%). All displayed as percentages in the Methods UI.

`provident_ee_rate`, `provident_er_rate`, `provident_er_rate_senior` (BW tenure split), `uif_rate`, `uif_cap` (R amount), `sdl_rate`, `meals_standard`, `meals_manager`, `leave_days`, `bonus_days`, `leave_accrual_pct`, `bonus_provision_pct`

CTC inclusion flags (boolean, default false for provisions): `ctc_provident_er`, `ctc_uif_er`, `ctc_sdl`, `ctc_wca`, `ctc_meals`, `ctc_leave_accrual`, `ctc_bonus`

### `salary_records` column groups

**Earnings**: `basic_salary`, `allowances` (jsonb), `total_earnings`
**Employee deductions**: `tax_paye`, `uif_employee`, `medical_employee`, `ancilla_employee`, `provident_employee`, `total_deductions`
**Company contributions**: `uif_company`, `medical_company`, `provident_company`, `sdl_company`, `ancilla_company`, `total_company_contrib`
**Provisions**: `wca_company`, `staff_meals`, `bonus_provision`, `incentive`, `leave_provision`, `leave_accrual`, `other_company_contrib`, `total_payroll_burden`, `total_cost`
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
- Detected: first line starts with `employee_code,` **or** `employee_code;` and contains `period_month`
- Delimiter auto-detected (comma vs semicolon) — Excel on SA/EU locales saves CSVs with `;`
- Matches by `employee_code` within the selected hotel; updates all employee fields + upserts the full salary record
- After import, run Calculate Burden or Methods → Save & Update to recalculate contributions

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
    login/page.tsx        — Login form (username + password)
    dashboard/
      page.tsx            — Dashboard: SalarySummaryTable first; hotel cards below each with per-grade breakdown table
      SalarySummaryTable.tsx — Filterable hotel-level before/after table; reads draft scenarios first, then committed
      InflationHistoryCard.tsx — CPI + historic increases + NMW reference card; data stored in localStorage only
      layout.tsx          — Reads cookie server-side; passes role+username to NavSidebar
      access/page.tsx     — Admin-only user management UI
      employees/
        page.tsx          — Employee list; column picker, hotel CSV export, Calculate Burden
        [id]/page.tsx     — Employee detail + edit form
      import/page.tsx     — Multi-format import (VIP, Employee TSV, Medical Aid, Round-trip CSV)
      methods/page.tsx    — Configurable payroll rates + CTC flags per hotel; Save & Update All
      settings/page.tsx   — Redirects to /dashboard/methods
      salary-review/page.tsx — Per-hotel increase builder; drafts persist to DB; commit to salary_records
      reports/page.tsx    — Flexible report builder; Excel + PDF export
      reconciliation/page.tsx — Monthly payroll reconciliation for CSL/NL/CFE (admin-only)
  lib/
    auth.ts               — UserContext, makeToken(), verifyToken(), hashPassword() — Edge-compatible
    payroll-calc.ts       — calculateBurden(); isBotswana(), isManager(); BurdenInput/BurdenResult
    vip-parser.ts         — VIP 710, TSV employee details, medical aid parsers
    employee-csv.ts       — Round-trip CSV export builder (buildEmployeeCsv) + import parser
    excel-export.ts       — Salary review Excel export (xlsx-js-style)
    reports-export.ts     — Reports Excel + PDF export (exportReport, exportPdf)
    recon-parsers.ts      — Reconciliation file parsers: parseAfritecXls, parseFurnmart, parseBodulo, parsePayrollXlsx
    supabase/
      client.ts           — Browser Supabase client (used by all dashboard pages)
      server.ts           — Server-side Supabase client (used only in RSC `dashboard/page.tsx`)
    utils.ts              — fmtZAR(), fmtCurrency(), MONTH_NAMES, sortHotels(), cn()
  components/
    nav-sidebar.tsx       — Role-aware navigation; admin sees all tabs, sub sees Employees + Import only
  middleware.ts           — HMAC cookie auth gate; blocks sub-users from Methods, Salary Review, Reports, Reconciliation, Access
  types/
    database.ts           — Hotel, Employee, SalaryRecord, PayrollImport, IncreaseScenario, ScenarioLine, AppUser, ReconciliationPeriod, ReconUpload, ReconQuery
```

---

## Salary Review

`/dashboard/salary-review` — per-hotel increase scenario builder.

**State pattern**: settings are stored per hotel in a `Map<string, HotelSettings>` + a `hotelSettingsRef` (React ref) to avoid stale closure issues on hotel-tab switches. A parallel `hotelDraftIds` map tracks the DB scenario ID for each hotel's draft.

**Save button** — async; writes a `draft` row to `increase_scenarios` (with `hotel_id` + `settings_json`) and replaces `scenario_lines` for that hotel. On page load, all drafts are fetched in the initial `Promise.all` and refs are populated before `setHotelFilter` fires, so the form restores correctly on return.

**Delete button** — trash icon per row in the Saved Increases table; removes the draft scenario + its lines from DB.

**Exclusions** — checkbox per employee row. Excluded employees show `opacity-45` + "excluded" badge; they are skipped in scenario_lines and on Commit (no salary record written for them).

**Commit** — updates each hotel's draft scenario status to `committed` (sets `effective_month`, `effective_year`, `committed_at`); writes new `salary_records` for the target month/year; clears all draft state. Does NOT create a new scenario row — the existing draft row is promoted.

**Threshold** — optional second tier within a hotel's scenario. `threshold` (basic salary amount) divides employees into two bands:
- Basic **< threshold**: uses `belowPct`/`belowFlat` if set; otherwise **0** (no increase).
- Basic **≥ threshold**: uses `abovePct`/`aboveFlat` if set; otherwise falls back to the global `pct`/`flat`.

Grade-level exclusions (`excludedGrades`) and per-employee exclusions (`excluded`) both set `isExcluded = true` — excluded employees are kept in the table with 0 increase and are included in totals/consolidations but receive no salary change on Commit.

**Dashboard** — `SalarySummaryTable` reads all `draft` scenario lines first (shows pending increases before commit). Falls back to the most recent `committed`/`applied` scenario if no drafts exist. The server-rendered hotel cards below also load the same scenario lines to show per-grade breakdowns with matching figures.

**`InflationHistoryCard`** (`src/app/dashboard/InflationHistoryCard.tsx`) — `'use client'` card rendered on the dashboard between `SalarySummaryTable` and the hotel cards. Stores all data in `localStorage` (never in the DB):

| Key | Content |
|-----|---------|
| `ihg-salary-cpi` | `Record<country, Record<year, string>>` — CPI % per country per year |
| `ihg-salary-increases` | `Record<hotelId, Record<year, { pct: string; flat: string }>>` — historic increases; `flat` is a monetary adjustment |
| `ihg-salary-nmw` | `Record<year, string>` — SA National Minimum Wage reference value (shared across all SA hotels) |
| `ihg-salary-cpi-month` | `string` — month label for CPI header (e.g. `"July"`) |
| `ihg-salary-increase-notes` | `string` — free-text notes |

NMW indicator shows only for SA hotels where `short_code !== 'APA'` and `!isBotswana(country)`. The `YEARS` constant covers 6 years: last 5 completed + current year. Must match `BENCHMARK_YEARS` in `excel-export.ts`.

The salary review Excel export reads all five localStorage keys in `handleExport()` and passes a `BenchmarkData` object to `exportSalaryReview()`, which prepends a CPI table, historic increases table (with NMW row), and optional notes above the summary table in the **Overview** sheet.

---

## Reconciliation

`/dashboard/reconciliation` — admin-only monthly payroll cross-check for **CSL, NL, and CFE** only (hotel tabs are filtered to these three short codes).

**Workflow**: Upload tab → Deductions Check tab → Prior Month Changes tab → Queries tab. Status moves Open → Submitted → Approved.

**Upload tab**: Period selector (month/year) is the first element. File slots:

| Slot | Type | Format | Notes |
|------|------|--------|-------|
| Payroll Spreadsheet | `payroll` | `.xlsx` | Required; NataLodge-style department-grouped export |
| 12 Months Payroll Report | `twelve_months` | `.pdf` | Stored as base64 jsonb; View button opens in new tab |
| Afritec Loan Statement | `afritec` | `.xls` | Loan instalment schedule |
| Topline Loan Statement | `topline` | `.xls` | Same format as Afritec |
| Furnmart Deductions | `furnmart` | `.xlsx` | Multi-SEQ rows per employee |
| CB Stores Deductions | `cbstores` | `.xls/.xlsx` | Optional; omit if no deductions that month |
| Bodulo Funeral Scheme | `bodulo` | `.xlsx` | Policy list |

Re-uploading any slot replaces it (upsert on `period_id, upload_type`).

**Parsers** (`src/lib/recon-parsers.ts`):
- `parseAfritecXls` — detects header by keyword; col 5 = Employee Number, col 10 = Regular Instalment; totals row has no emp code
- `parseFurnmart` — header detected by "EMP NO"; col 11 (TOTAL) only populated on the last SEQ row per employee; employees with no code go to `unmatchedLines`
- `parseBodulo` — header at row 0; col 4 = Custom Policy Number, col 9 = Premium Due; "TOTAL TO PAY" extracted from bottom summary block
- `parsePayrollXlsx` — header detected by `col[0]="Code"`; all other columns detected by keyword (e.g. "furnmart", "cb stores", "funeral", "staff loan") — robust across hotel format variants

All parsers are async and dynamically import `xlsx-js-style`.

**Deductions Check tab**: requires payroll upload. Shows a summary table (statement total vs payroll total, difference) then a per-employee breakdown. Vendor filter buttons — **All / Furnmart / Loans / CB Stores / Bodulo** — narrow the employee table to the selected vendor's columns. Unmatched statement entries (no payroll code match) are shown in an orange callout. Afritec and Topline both map to the payroll `staffLoans` column and are summed together.

**Prior Month Changes tab**: compares uploaded payroll basic salaries against the previous month's `salary_records` in DB. Shows new employees, employees no longer in payroll, and basic salary changes.

**Queries tab**: thread-style queries with author name + timestamp; each can be resolved with a response.

**DB tables** (migration 015):
- `reconciliation_periods` — one row per hotel/year/month; `status` open/submitted/approved
- `recon_uploads` — one row per period per upload type (UNIQUE constraint); `parsed_data` jsonb holds the parsed output
- `recon_queries` — query thread entries per period

---

## Access Control

`/dashboard/access` — admin-only user management page.

**Roles**:
- `admin` — full access to all tabs and all hotels
- `sub` — Employees and Import tabs only; filtered to assigned hotels

**Nav**: `nav-sidebar.tsx` renders different link lists based on `role` prop passed from `dashboard/layout.tsx`.

**Middleware** blocks sub-users from: `/dashboard` (root), `/dashboard/methods`, `/dashboard/salary-review`, `/dashboard/reports`, `/dashboard/reconciliation`, `/dashboard/access`, `/dashboard/settings` — redirects to `/dashboard/employees`.

**Hotel filtering for sub-users**: `employees/page.tsx` and `import/page.tsx` call `GET /api/auth/me` on mount and filter the hotel dropdown to `user.hotelIds`.

---

## Methods Page

`/dashboard/methods` — configurable payroll rates per hotel (replaces old Settings page).

**Contributions section**: PF EE, PF ER (single rate for SA; junior/senior split for BW), UIF + cap, SDL, WCA — all with "Include in CTC" checkbox. Botswana rows for UIF/SDL/WCA are shown greyed with "Exempt" label.

**Provisions section**: Staff Meals standard/manager, Leave Accrual (`days / 365 × %`), Bonus Provision (`days / 365 × %`) — each with "Include in CTC" checkbox. The `%` multiplier (stored as `leave_accrual_pct` / `bonus_provision_pct` on `hotels`) is applied after the days/365 factor: `basic × (days/365) × pct`.

**Save & Update All [Hotel] Employees** — saves rates to `hotels` table, then recalculates and updates the latest salary record for every active employee in the hotel. Employees with `incentive_applicable` keep their incentive and receive no `bonus_provision` (this is handled inside `calculateBurden`, not special-cased here).

---

## Employee CSV Export / Round-trip

Export: hotel selector + **Export CSV** button in the Employees page header. Downloads `{ShortCode}_employees_{YYYYMM}.csv` containing all employee fields plus full latest salary record for each employee (51 columns).

Re-import: via Import page — select the same hotel, upload the CSV. Format is auto-detected. All employee fields and the complete salary record are written verbatim; run Calculate Burden or Methods → Save & Update afterwards to recalculate computed fields.

---

## Column Visibility (Employees page)

Persisted in `localStorage` under key `'ihg-salary-emp-cols-{hotelId}'` — **per-hotel**, not shared. The picker uses a **draft pattern** — selections stage inside the dropdown and only apply when the user clicks **OK**. Hotel filter persisted under `'ihg-salary-emp-hotel'`.

**Hotel filter has no "All Hotels" option** — always shows one hotel. On mount the hotel is resolved inside `load()` after the hotel list arrives: validates the localStorage value against live hotel IDs, falls back to first hotel if missing or stale. The employee detail page writes the employee's hotel ID to the same key so "Back to Employees" always lands on the correct hotel.

**Batch delete** — checkbox on each row (header checkbox selects all visible). A red "Delete X selected" button appears in the toolbar when rows are ticked; confirms then deletes employees + all their salary records in one operation. Selection clears on hotel/search filter change.

Default visible columns: Emp Code, Surname, First Name, Hotel, Department, Job Title, Grade, Basic Salary, Gross Salary, CTC.

Column groups and membership:
- **Employee**: Emp Code, Surname, First Name, Hotel, Department, Job Title, Grade (`structure` col → `grade_label`), Start Date, Yrs Service
- **Salary**: Basic Salary, Structure (`structure_sal` col → shows `—`, placeholder for future salary-band import), Gross Salary, CTC
- **Benefits**: Medical (Co), Prov Fund (Co)
- **Legislative**: UIF (Co), SDL, WCA
- **Provisions**: Staff Meals, Bonus Provision, Incentive, Gratuity, Severance, Leave

**Note**: `bonus_accrual_dec` and `mgmt_incentive` are NOT displayed in the column picker (no calculation attached). `leave_accrual` is in the Provisions group (labelled "Leave"). There is no Deductions or Accruals group. The Generate Codes button has been removed.

**Category sum view** — a select dropdown overrides the column picker to show only anchor columns + the chosen group, with a totals row at the bottom.

Zero monetary values display as "—" (not "R0" or "P0").

---

## Grade Labels

`employees.grade_label` is a free-text field set manually (not from VIP). Canonical values (enforced by `GRADE_MAP` in `import/page.tsx` on import):
`ANO`, `FTC`, `DNQ`, `Frontline`, `Supervisory`, `Management`, `Executive`

Free-text variants like `"front line"`, `"exec"`, `"supervisor"` are normalised to the canonical form on import. The salary review grade filter and dashboard grade badges use these same canonical values. `Unclassified` is displayed for employees whose `grade_label` is null.

The canonical grade sort order used in `dashboard/page.tsx` for per-hotel grade breakdowns:
`['ANO', 'FTC', 'DNQ', 'Frontline', 'Supervisory', 'Management', 'Executive', 'Unclassified']`

---

## Styling

Tailwind CSS v4 + Shadcn UI base-nova. Custom tokens in `global.css`. Standard colours: `bg-white` for cards, `bg-muted/40` for table headers, `text-muted-foreground` for secondary text, `text-primary` for action items.

Monetary values: always use `fmtZAR(n)` or `fmtCurrency(n, country)` from `src/lib/utils.ts`. Botswana amounts display as "P X,XXX", South Africa as "R X,XXX". Always pass `hotel.country` (the full country string) to `fmtCurrency` — it checks `includes('botswana')` but does **not** handle the `'bw'` short code that `isBotswana()` handles, so passing `hotel.short_code` would produce incorrect ZAR formatting for Botswana hotels.
