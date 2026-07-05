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

### `hotels` configurable method columns (from migration 009)

All rates stored as decimals (e.g. 0.07 = 7%). All displayed as percentages in the Methods UI.

`provident_ee_rate`, `provident_er_rate`, `provident_er_rate_senior` (BW tenure split), `uif_rate`, `uif_cap` (R amount), `sdl_rate`, `meals_standard`, `meals_manager`, `leave_days`, `bonus_days`, `leave_accrual_pct`, `bonus_provision_pct`

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

Detection order: CSL Payroll Schedule xlsx (by file extension + sheet names) → round-trip CSV → medical aid → HR List / employee details → VIP 710.

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
      import/page.tsx     — Multi-format import (HR List xlsx/CSV/TSV, VIP, Medical Aid, Round-trip CSV, CSL Payroll Schedule xlsx); nav label "Import HR List"; no period selector for HR List type
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
    recon-parsers.ts      — Reconciliation file parsers: parseAfritecXls, parseFurnmart, parseBodulo, parsePayrollXlsx
    supabase/
      client.ts           — Browser Supabase client (used by all dashboard pages)
      server.ts           — Server-side Supabase client (used only in RSC `dashboard/page.tsx`)
    utils.ts              — fmtZAR(), fmtCurrency(), fmtNumber(), MONTH_NAMES, sortHotels(), hotelSortIndex(), cn()
  components/
    nav-sidebar.tsx       — Role-aware navigation; admin sees all tabs, sub sees Employees + Import only
  middleware.ts           — HMAC cookie auth gate; always blocks sub-users from Dashboard/Methods/Salary Review/Reports/Access; gates Employees/Import/Reconciliation per-user via allowedTabs
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

**Commit** — updates each hotel's draft scenario status to `committed` (sets `effective_month`, `effective_year`, `committed_at`); writes new `salary_records` for the target month/year; automatically writes each hotel's `pct` and `flat` to `ihg-salary-increases` in localStorage (so the Inflation & Increase History table on the Methods page updates without manual entry); clears all draft state. Does NOT create a new scenario row — the existing draft row is promoted.

**Increase calculation** — all % increases are applied to `total_earnings` (Gross salary), not `basic_salary`. The resulting amount is added to `basic_salary`; allowances remain unchanged. Formula: `increase = total_earnings × pct + flat → newBasic = round(basic + increase, 10)`. `ForecastRow.currentGross` = `total_earnings`; the table shows "Current Gross" / "New Gross" columns and the Excel export uses the same labels.

**Threshold** — optional second tier within a hotel's scenario. `threshold` compares against `basic_salary` (not gross). Divides employees into two bands:
- Basic **< threshold**: uses `belowPct`/`belowFlat` applied to gross; otherwise **0** (no increase).
- Basic **≥ threshold**: uses `abovePct`/`aboveFlat` applied to gross; otherwise falls back to the global `pct`/`flat`.

Grade-level exclusions (`excludedGrades`) and per-employee exclusions (`excluded`) both set `isExcluded = true` — excluded employees are kept in the table with 0 increase and are included in totals/consolidations but receive no salary change on Commit.

**Dashboard** — `SalarySummaryTable` reads all `draft` scenario lines first (shows pending increases before commit). Falls back to the most recent `committed`/`applied` scenario if no drafts exist. Three-tier drill-down, each level with its own "+"/"−" toggle: **Hotel row** (filtered total) → **Grade rows** (one per grade present among the filtered employees at that hotel, sorted by `GRADE_ORDER`, each a subtotal) → **Employee rows** (individuals making up that grade's subtotal). All three levels share the same `computeEmployeeFigures()` logic, so hotel, grade, and employee figures always reconcile. This replaced the old per-hotel `HotelCard` grade-breakdown cards that used to render below the summary table.

**`InflationHistoryCard`** (`src/app/dashboard/InflationHistoryCard.tsx`) — `'use client'` card rendered at the **bottom of the Methods page** (not the dashboard). Stores all data in `localStorage` (never in the DB):

| Key | Content |
|-----|---------|
| `ihg-salary-cpi` | `Record<country, Record<year, string>>` — CPI % per country per year |
| `ihg-salary-increases` | `Record<hotelId, Record<year, { pct: string; flat: string }>>` — historic increases; `flat` is a monetary adjustment |
| `ihg-salary-nmw` | `Record<year, string>` — SA National Minimum Wage reference value (shared across all SA hotels) |
| `ihg-salary-cpi-month` | `string` — month label for CPI header (e.g. `"July"`) |
| `ihg-salary-increase-notes` | `string` — free-text notes |

NMW indicator shows only for SA hotels where `short_code !== 'APA'` and `!isBotswana(country)`. The `YEARS` constant covers 6 years: last 5 completed + current year. Must match `BENCHMARK_YEARS` in `excel-export.ts`.

The salary review Excel export reads all five localStorage keys in `handleExport()` and passes a `BenchmarkData` object to `exportSalaryReview()`, which prepends a CPI table, historic increases table (with NMW row), and optional notes above the summary table in the **Overview** sheet.

### Excel export structure (`src/lib/excel-export.ts`)

**Per-hotel sheets** (one per hotel with rows):

| Col | Content | Behaviour |
|-----|---------|-----------|
| F — Current Gross | Static (DB value) | Read-only |
| G — % Increase | Editable input | **Amber header + yellow cell** — change here to model scenarios |
| H — Flat Adj | Editable input | Same — amber/yellow |
| I — New Gross | `=ROUND(F*(1+G/100)+H,-1)` | Recalculates live |
| J — Monthly Inc | `=I-F` | Live |
| K — Current CTC | Static | Too complex for Excel formulas |
| L — New CTC | Static | Same |
| M — Monthly CTC Δ | `=L-K` | Live |
| N — Annual CTC Δ | `=(L-K)*12` | Live |

Totals row uses `SUM(col_first:col_last)` formulas for I, J, M, N.  
AutoFilter on `A1:N1` — use column D (Grade) dropdown to filter by grade.

**`% Increase` stored as display value** (e.g. `6.0`, not `0.06`) with format `'0.0"%"'` — formulas must divide by 100: `F*(1+G/100)`.

**Overview sheet** — 14 columns A–N:

| Col | Content |
|-----|---------|
| A–D | Hotel, Short Code, Currency, Headcount |
| E | Increase % — configured rate (`settings.pct` + `settings.flat`) from `ExportHotel.increase` |
| F | Current Gross (static) |
| G | New Gross — `='SheetName'!I{totRow}` — cross-sheet formula, updates when hotel tab edited |
| H | Monthly Inc — `='SheetName'!J{totRow}` |
| I | Annual Inc — `='SheetName'!J{totRow}*12` |
| J–M | CTC columns (static) |
| N | % Change — `=IFERROR((G/F-1)*100,0)` within Overview |

Grand Total row uses `SUM(G{first}:G{last})` etc. so it aggregates live hotel values.

`exportSalaryReview` builds the `sheetNames: Map<string, string>` first (short code, single quotes stripped) and passes it to `buildSummarySheet` so cross-sheet formula strings are correct. Sheet names strip `[:\\/?\*\[\]']` and truncate at 31 chars.

**`ExportHotel` interface** — `increase?: IncreaseEntry` carries the hotel-level configured rate. `ExportHotelRow` carries both `currentGross` (formula base) and `currentBasic` (needed for increase-amount column).

---

## Reconciliation

`/dashboard/reconciliation` — admin-only monthly payroll cross-check for **CSL, NL, and CFE** only (hotel tabs are filtered to these three short codes).

**Workflow**: Upload tab → Deductions Check tab → **Employees tab** → Prior Month Changes tab → Queries tab. Status moves Open → Submitted → Approved.

**Upload tab**: Period selector (month/year) is the first element. File slots:

| Slot | Type | Format | Notes |
|------|------|--------|-------|
| Payroll Spreadsheet | `payroll` | `.xlsx` | Required; NataLodge-style department-grouped export |
| Fixed Term Contract Payroll | `ftc_payroll` | `.xlsx` | Optional; multi-sheet (one sheet per month, picked by target period); matched by name only (no employee codes) |
| 12 Months Payroll Report | `twelve_months` | `.pdf` | Stored as base64 jsonb; View button opens in new tab |
| Afritec Loan Statement | `afritec` | `.xls` | Loan instalment schedule |
| Topline Loan Statement | `topline` | `.xls` | Same format as Afritec |
| Furnmart Deductions | `furnmart` | `.xlsx` | Multi-SEQ rows per employee |
| CB Stores Deductions | `cbstores` | `.xls/.xlsx` | Optional; omit if no deductions that month |
| Bodulo Funeral Scheme | `bodulo` | `.xlsx` | Policy list |

Re-uploading any slot replaces it (upsert on `period_id, upload_type`).

**Parsers** (`src/lib/recon-parsers.ts`):
- `parseAfritecXls(buf, fileName, uploadType, hotelCode)` — detects header by keyword; col 5 = Employee Number, col 10 = Regular Instalment. **If the file contains a "CUSTOMER NAME" header row it delegates to `parseCbToplineFormat`** — so this function is the catch-all for afritec, topline, and cbstores. Dispatch in `handleUpload`: `payroll`→`parsePayrollXlsx`, `furnmart`→`parseFurnmart`, `bodulo`→`parseBodulo`, all others→`parseAfritecXls(buf, name, type, hotelCode)`
- `parseCbToplineFormat` — handles the multi-section `CUSTOMER NAME / CUST.# / AMOUNT` format used by CB Stores and Topline. Sections are identified by `TO: <label>` rows above each header. `sectionMatchesHotel()` filters which sections to include per hotel (CSL→"CSL\*", NL→"NSL\*", CFE→"CFE\*"). **MGMT/Management sections are always passed through regardless of hotel** — they appear on CSL/NL statements but are separated downstream by `isMgt()` into the Management section. Each employee line is stored with `empCode = nameKey(name)` (CUST.# ignored) and `section = sectionLabel`. Returns `matchByName: true`.
- `parseFurnmart` — header detected by "EMP NO"; col 11 (TOTAL) only populated on the last SEQ row per employee; employees with no code go to `unmatchedLines`
- `parseBodulo` — header at row 0; col 4 = Custom Policy Number, col 9 = Premium Due; "TOTAL TO PAY" extracted from bottom summary block
- `parsePayrollXlsx` — header detected by `col[0]="Code"`; all other columns detected by keyword (e.g. "furnmart", "cb stores", "funeral", "staff loan", "afritec", "topline") — robust across hotel format variants. `afritecFromStaff` flag: when payroll has a Topline column but no dedicated Afritec column, the Staff Loans column is used as Afritec amounts.
- `parseFtcPayrollXls(buf, fileName, targetMonth, targetYear)` — picks the sheet matching the target period (`pickFtcSheet`), then reads name + total columns only (`findFtcHeader`); rows are keyed by `nameKey(name)` (no employee codes exist for FTC staff), and a name repeated in a second block on the same sheet has its total summed rather than overwritten.

**`PayrollLine` loan columns**: `afritecLoans` (Afritec-specific, 0 if absent) + `toplineLoans` (Topline-specific, 0 if absent) + `staffLoans` (combined = `afritecLoans + toplineLoans`, or the single combined column when the payroll has no split). In the Deductions Check summary: if the payroll has non-zero separate columns, Afritec and Topline are compared independently; if only the combined `staffLoans` column exists and both statements are uploaded, a single "Total Loans" row is shown instead.

**`nameKey(raw)`** (exported from `recon-parsers.ts`) — normalises a name to a sorted word-set key: `"BEAUTY LISEHU"` and `"LISEHU BEAUTY"` both produce `"BEAUTY|LISEHU"`. Used for order-agnostic name matching.

All parsers are async and dynamically import `xlsx-js-style` (avoids SSR issues — any new parser must follow this pattern).

**Deductions Check tab**: requires payroll upload. Page loads on CSL by default. Shows:
1. **Orange callout** (top) — statement entries that could not be matched to any payroll employee by code or name. Entries resolved by the second-pass name match are excluded from this callout.
2. **Summary table** — statement total vs payroll total + difference per vendor.
3. **Employee Detail table** — colour-coded vendor filter tabs (All / Furnmart / Afritec / Topline / CB Stores / Bodulo). Each tab filters both columns AND rows — clicking Furnmart shows only employees with a Furnmart deduction. Only employees with at least one non-zero deduction are shown.
4. **Management (CFE) section** (below staff table) — employees from MGMT-labelled sections of CB Stores / Topline statements, shown separately (no payroll comparison; these are CFE Management employees on a separate payroll).

**Employee matching in the Deductions Check tab** uses a two-pass strategy:
- *Pass 1 (code-based)*: match statement `empCode` against payroll `empCode`. CB Stores / Topline with `matchByName=true` skip this and go to pass 2.
- *Pass 2 (name-based)*: for all `unmatchedLines` from every statement (Afritec numeric codes, Furnmart no-code entries, old-format CB/Topline), try `nameKey(payrollEmployee.name)` lookup. Resolved entries populate the employee table. Truly absent entries (no payroll counterpart) are appended as extra rows (Code = —).

**Upload label**: "Topline Loan Statement" was renamed to "Topline Deductions" in `UPLOAD_CONFIGS`.

**Employees tab** — cross-reference between the uploaded payroll and the DB `employees` table for CSL and NL. Always visible (not conditional on which hotel is selected in the main selector). Contains [CSL | NL] sub-tabs; each loads data independently. Data reloads whenever the tab is opened or year/month/hotels changes.

Per hotel: loads active `employees` + `salary_records` from DB, plus payroll lines from the hotel's own `recon_uploads` for the current period (permanent + `ftc_payroll` merged, then deduplicated by `nameKey`). Cross-reference output type `CrossRefRow`: `{ name, dbEmployee, dbBasic, payBasic, ftc }`. Filter chips: All / Basic Mismatch / Not in DB / Not in Payroll. The badge on the main "Employees" tab shows the combined discrepancy count across both CSL and NL.

State: `cslXRef: HotelXRefData`, `nlXRef: HotelXRefData`, `crossRefSubTab: 'CSL' | 'NL'`. `HotelXRefData = { employees, salaryRecords, payrollLines, loaded }`. `buildCrossRef(xref)` is a pure function that produces `CrossRefRow[]` from a `HotelXRefData` — called for both the active sub-tab (for rendering) and both hotels (for badge counts).

**Prior Month Changes tab**: compares current payroll against the previous month. **Data source preference**: queries the previous period's `recon_uploads` (payroll + ftc_payroll types) first — this is the only reliable source for CSL/NL whose employee codes are NULL in the DB. Falls back to `salary_records` only if no recon upload exists for the prior period. Both sources are unified into `PrevEmp = { empCode: string; name: string; basic: number }` before comparison.

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
- `sub` — hotel-restricted (via `hotel_ids`) and tab-restricted (via `allowed_tabs`, see below)

**Configurable tabs per sub user** (migration `016_user_allowed_tabs.sql`, column `users.allowed_tabs text[]`): admins individually grant/revoke **Employees**, **Import HR List**, and **Reconciliation** per sub user via checkboxes on the Access page. Everything else (Dashboard, Salary Review, Reports, Methods, Access) stays **permanently admin-only** regardless of `allowed_tabs` — not configurable, by design (Access in particular would be a privilege-escalation risk if grantable). The canonical list of configurable tabs is `CONFIGURABLE_TABS` in `src/lib/auth.ts`; `middleware.ts`, `nav-sidebar.tsx`, and `access/page.tsx` all import from there rather than duplicating the tab list.

**Default/legacy fallback**: `allowed_tabs: null` (pre-migration-016 sub users, or an already-issued cookie from before this shipped, which won't carry the field until the user logs in again) falls back to `DEFAULT_SUB_TABS = ['employees', 'import', 'reconciliation']` — the fixed set every sub user had before this became configurable. This fallback is applied in both `middleware.ts` and `nav-sidebar.tsx`, so nobody loses access mid-session when this ships.

**Nav**: `nav-sidebar.tsx` renders `ADMIN_NAV` unfiltered for admins; for sub users it filters `SUB_NAV` down to whichever tab `key`s are in `allowedTabs` (prop passed from `dashboard/layout.tsx`, sourced from the cookie's `UserContext.allowedTabs`).

**Middleware** (`src/middleware.ts`) — two layers for sub users:
1. `SUB_BLOCKED` (always-blocked paths, not configurable): `/dashboard` (root), `/dashboard/methods`, `/dashboard/salary-review`, `/dashboard/reports`, `/dashboard/access`, `/dashboard/settings`.
2. `TAB_ROUTES` — maps each configurable tab key to its route prefix; a sub user hitting a configurable tab's route without that key in `allowedTabs` is redirected away.

Both cases redirect to the user's first allowed tab (computed from `CONFIGURABLE_TABS` order ∩ `allowedTabs`), falling back to `/login` only if a sub user somehow has zero tabs granted (the Access page's save validation prevents this via the UI, but doesn't stop a zero-tab state some other way).

**Hotel filtering for sub-users**: `employees/page.tsx`, `import/page.tsx`, and `reconciliation/page.tsx` all call `GET /api/auth/me` on mount and filter to `user.hotelIds`. This is a single global hotel list per user — there is no per-tab hotel scoping (e.g. you cannot give a sub user all hotels for Reconciliation but only CSL/NL for Employees); `hotelIds` applies uniformly across whichever tabs are granted.

---

## Methods Page

`/dashboard/methods` — configurable payroll rates per hotel (replaces old Settings page).

**Contributions section**: PF EE, PF ER (single rate for SA; junior/senior split for BW), UIF + cap, SDL, WCA — all with "Include in CTC" checkbox. Botswana rows for UIF/SDL/WCA are shown greyed with "Exempt" label.

**Provisions section**: Staff Meals standard/manager, Leave Accrual (`days / 365 × %`), Bonus Provision (`days / 365 × %`) — each with "Include in CTC" checkbox. The `%` multiplier (stored as `leave_accrual_pct` / `bonus_provision_pct` on `hotels`) is applied after the days/365 factor: `basic × (days/365) × pct`.

**Save & Update All [Hotel] Employees** — saves rates to `hotels` table, then recalculates and updates the latest salary record for every active employee in the hotel. Employees with `incentive_applicable` keep their incentive and receive no `bonus_provision` (this is handled inside `calculateBurden`, not special-cased here).

---

## Employee CSV Export / Round-trip

Export: **Export CSV** button in the Employees page header — exports whichever hotel is currently selected in the page filter (no separate hotel dropdown). Downloads `{ShortCode}_employees_{YYYYMM}.csv` containing all employee fields plus full latest salary record for each employee (51 columns).

Re-import: via Import page — select the same hotel, upload the CSV. Format is auto-detected. All employee fields and the complete salary record are written verbatim; run Calculate Burden or Methods → Save & Update afterwards to recalculate computed fields.

---

## Column Visibility (Employees page)

Persisted in `localStorage` under key `'ihg-salary-emp-cols-{hotelId}'` — **per-hotel**, not shared. The picker uses a **draft pattern** — selections stage inside the dropdown and only apply when the user clicks **OK**. Hotel filter persisted under `'ihg-salary-emp-hotel'`.

**Hotel filter has no "All Hotels" option** — always shows one hotel. On mount the hotel is resolved inside `load()` after the hotel list arrives: validates the localStorage value against live hotel IDs, falls back to first hotel if missing or stale. The employee detail page writes the employee's hotel ID to the same key so "Back to Employees" always lands on the correct hotel.

**Batch delete** — checkbox on each row (header checkbox selects all visible). A red "Delete X selected" button appears in the toolbar when rows are ticked; confirms then deletes employees + all their salary records in one operation. Selection clears on hotel/search filter change.

**Add Employee modal** — button in the page header opens a form covering hotel, surname/first name (required), employee code (optional — blank for ANO positions), job title, department code, grade, status, employment date, and an initial salary record (basic, gross, period month/year). Inserts one row into `employees` and one into `salary_records`.

**Permanent/FTC toggle** — shown only for CSL and NL (`showFtcToggle = selectedHotel.short_code === 'CSL' || 'NL'`). Filters the employee list (and CSV export) by whether `grade_label` is in `FTC_GRADES` (`FTC`) vs. everyone else. The same toggle exists on the Import page for these two hotels.

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
`ANO`, `FTC`, `DNQ`, `Frontline`, `Supervisory`, `Management`, `Executive`, `Flexible`

Free-text variants like `"front line"`, `"exec"`, `"supervisor"`, `"flexible"`, `"fixed term"`, `"fixed_term"` are normalised to the canonical form on import (the two "fixed term" variants both map to `FTC` — `"Fixed Term"` was a duplicate canonical value removed from all grade dropdowns and the import mapping; 11 CSL/NL employee records were migrated from `"Fixed Term"` to `"FTC"` in production). The salary review grade filter and dashboard grade badges use these same canonical values. `Unclassified` is displayed for employees whose `grade_label` is null.

**Grade filters do exact string matching** — `SalarySummaryTable`'s grade checkboxes key off `grade_label` matching the canonical spelling exactly. Any employee whose `grade_label` is a near-miss (wrong casing/spacing, or a value never normalised) silently disappears the moment a grade filter is touched, without any error — the headcount just looks wrong. This bit production data twice: `"Front Line"` (should be `Frontline`) at ILRB (26 employees) and ILG (24 employees), and `"Supervisor"` (should be `Supervisory`) at IH (19 employees) — all three normalised in production. These predated (or bypassed) the current `GRADE_MAP`/dropdown-only grade inputs, which prevent new stray values going forward. If a hotel's dashboard headcount looks implausibly low after filtering by grade, check for non-canonical `grade_label` strings at that hotel before assuming a calculation bug — the per-employee "+" drill-down on each hotel row is the fastest way to spot who's missing.

`status` on `employees` has three DB values (`active`, `terminated`, `on_leave`) but **`on_leave` is removed from all UI dropdowns** — only `active` and `terminated` appear in forms. Existing DB records with `on_leave` are preserved and readable; the type in `database.ts` retains the union for backward compatibility.

---

## Styling

Tailwind CSS v4 + Shadcn UI base-nova. Custom tokens in `global.css`. Standard colours: `bg-white` for cards, `bg-muted/40` for table headers, `text-muted-foreground` for secondary text, `text-primary` for action items.

Monetary values: always use `fmtZAR(n)` or `fmtCurrency(n, country)` from `src/lib/utils.ts`. Botswana amounts display as "P X,XXX", South Africa as "R X,XXX". Always pass `hotel.country` (the full country string) to `fmtCurrency` — it checks `includes('botswana')` but does **not** handle the `'bw'` short code that `isBotswana()` handles, so passing `hotel.short_code` would produce incorrect ZAR formatting for Botswana hotels.
