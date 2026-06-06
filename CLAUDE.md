# CLAUDE.md — IHG CFE Salary Manager

## What This Is

A web-based **HR salary management system** for 6 IHG CFE hotel properties, replacing an Excel-based salary review workflow. Built with Next.js (App Router) + Supabase + Shadcn UI. Password-gated (no user accounts — single shared password via cookie).

Core workflows:
- **Import** employee data from VIP Report 710 payroll files (fixed-width) or any tabular Excel CSV/TSV export
- **View & edit** employees across all 6 properties with flexible column visibility
- **Calculate payroll burden** automatically (provident fund, UIF, SDL, WCA, staff meals, leave accrual)
- **Salary review** forecasting (increase scenarios — in progress)

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
npm run build
npm run start
```

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

## Database

### Key Tables

| Table | Purpose |
|-------|---------|
| `hotels` | 6 properties; `country`, `short_code`, `wca_rate` (decimal, e.g. 0.0050 = 0.50%) |
| `employees` | One row per employee; `hotel_id`, `surname`, `first_name`, `grade_label`, `employment_date`, `nmw_applicable`, `comments` |
| `salary_records` | One row per employee per payroll period; full earnings, deductions, contributions, provisions, accruals |
| `payroll_imports` | Audit log of each import |

### Migrations

Applied to production via Supabase Dashboard → SQL Editor only. Files in `supabase/migrations/`:

| File | Purpose |
|------|---------|
| `001_initial_schema.sql` | Hotels, employees, salary_records, payroll_imports, latest_salary view |
| `002_financial_columns.sql` | Payroll burden columns (wca, meals, bonus, leave, accruals, increase scenarios) |
| `003_hotel_rates.sql` | `wca_rate` column on `hotels` |

### `salary_records` column groups

**Earnings**: `basic_salary`, `allowances` (jsonb), `total_earnings`
**Employee deductions**: `tax_paye`, `uif_employee`, `medical_employee`, `ancilla_employee`, `provident_employee`, `total_deductions`
**Company contributions**: `uif_company`, `medical_company`, `provident_company`, `sdl_company`, `ancilla_company`, `total_company_contrib`
**Provisions**: `wca_company`, `staff_meals`, `bonus_provision`, `incentive`, `leave_provision`, `other_company_contrib`, `total_payroll_burden`, `total_cost`
**Leave & accruals**: `leave_days`, `leave_accrual`, `bonus_payout_factor`, `bonus_accrual_dec`, `bonus_accrual_july`, `mgmt_incentive`
**Increase scenario**: `increase_amount`, `adjustment`, `increase_pct`, `new_basic`, `new_ctc`
**Summary**: `net_salary`, `ctc`

---

## Payroll Burden Calculations

All logic lives in `src/lib/payroll-calc.ts`. The `calculateBurden()` function takes a `BurdenInput` and returns a `BurdenResult`.

### Fixed rates (hardcoded)

| Item | Rate | Notes |
|------|------|-------|
| Provident Fund EE | `basic × 7%` | Both EE and ER |
| Provident Fund ER | `basic × 7%` | |
| UIF EE | `basic × 1%`, cap R177.12 | SA hotels only |
| UIF ER | `basic × 1%`, cap R177.12 | SA hotels only |
| SDL | `total_earnings × 1%` | SA hotels only |
| Staff Meals — Manager | R380 | Title contains manager/mngr/mgr (case-insensitive) |
| Staff Meals — Standard | R330 | All other employees |
| Leave Accrual — SA | `basic × 24/365` | 24 days p.a. |
| Leave Accrual — Botswana | `basic × 21/365` | 21 days p.a. |

### Configurable rates (per hotel, set in Settings page)

| Item | Storage | Default |
|------|---------|---------|
| WCA | `hotels.wca_rate` (decimal) | 0.0050 |

### Not yet calculated (imported or entered manually)

- Medical Aid (EE + ER) — only some employees; import separately
- Bonus provision — separate treatment planned
- Incentive — omitted for now
- Management incentive — omitted for now

---

## Import Formats

The import page (`/dashboard/import`) auto-detects the file format on upload.

### VIP Report 710 (fixed-width payroll register)

- Parser: `src/lib/vip-parser.ts` → `parseVIPReport()`
- Splits on `={10,}` separator lines; each block contains one employee
- Extracts: employee code, name, job title, department, payroll period, full earnings/deductions/contributions breakdown
- Period detected automatically from `TxDt:` field

### Employee Details (CSV or TSV from Excel)

- Parser: `src/lib/vip-parser.ts` → `parseTSVEmployeeFile()`
- Detected via `isTabularEmployeeFile()` — first line starts with "Surname" and contains "Gross"
- Columns matched by header name (flexible order): Surname, Name, Department, Title, Start Date, Gross Salary
- Delimiter auto-detected (tab vs comma)
- Employment start date parsed from `DD Mon YYYY` format (e.g. "01 Oct 2024")
- Employees matched to existing records by surname + first_name (no employee code)
- Salary period must be set manually in the UI (no period in the file)
- Synthetic employee codes generated for new employees (first 3 chars surname + first 3 chars first name)

---

## Key Files

```
src/
  app/
    dashboard/
      employees/
        page.tsx          — Employee list with column picker, category sum view, Calculate Burden button
        [id]/page.tsx     — Employee detail + edit form
      import/page.tsx     — Dual-format import flow
      settings/page.tsx   — WCA rate per hotel
      salary-review/      — Increase scenario builder (in progress)
  lib/
    payroll-calc.ts       — All burden calculation logic; isBotswana(), isManager()
    vip-parser.ts         — VIP Report 710 parser + TSV/CSV employee details parser
    supabase/
      client.ts           — Browser Supabase client
      server.ts           — Server-side Supabase client
    utils.ts              — fmtZAR(), MONTH_NAMES, cn()
  components/
    nav-sidebar.tsx       — Dashboard navigation
  middleware.ts           — HMAC cookie auth gate
  types/
    database.ts           — Hotel, Employee, SalaryRecord, PayrollImport interfaces
```

---

## Column Visibility (Employees page)

Persisted in `localStorage` under key `'ihg-salary-emp-cols'`. The picker uses a **draft pattern** — selections stage inside the dropdown and only apply to the table when the user clicks **OK**. Closing with × discards the draft.

Column groups: Employee · Salary · Deductions · Contributions · Provisions · Accruals

**Category sum view** — a select dropdown ("Sum: Deductions" etc.) overrides the column picker to show only anchor columns (Surname, First Name, Hotel) + the chosen group's columns, with a totals row at the bottom.

---

## Grade Labels

`employees.grade_label` is a free-text field set manually (not from VIP). Options used across properties:
`ANO`, `Front Line`, `Supervisory`, `Middle Management`, `Management`, `Exec`

Shown as "Structure" in the Salary column group.

---

## Styling

Tailwind CSS v4 + Shadcn UI base-nova. Custom tokens in `global.css`. Standard colours: `bg-white` for cards, `bg-muted/40` for table headers, `text-muted-foreground` for secondary text, `text-primary` for action items.

Monetary values: always use `fmtZAR(n)` from `src/lib/utils.ts`.
