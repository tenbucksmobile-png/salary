// Combined Provisions export — one workbook covering Leave, Bonus (incl.
// Incentive), Severance and Gratuity across the hotels each segment applies
// to, plus an Overview sheet aggregating each segment's Book Adjustment
// figures.
//
// Scope: Leave and Bonus cover ILG/IH/ILRB/APA/CSL/NL/CFEM, matching the
// standalone Leave and Bonus Provision pages' own hotel scope. Severance and
// Gratuity cover ILG/CSL/NL/CFEM, matching the standalone Severance &
// Gratuity Provision page's own scope (widened from ILG-only). WCA is
// omitted entirely (not a per-employee provision).
//
// Reuses each source page's own live settings rather than introducing new
// export-time inputs: the Bonus accrual-months value comes from the same
// localStorage key the Bonus Provision page reads/writes, and each segment's
// Book Adjustment figures come from the same *_book_balances tables the
// standalone pages already persist to.

import { createClient } from '@/lib/supabase/client';
import {
  Employee, Hotel, SalaryRecord, LeaveProvision,
  LeaveProvisionBookBalance, BonusProvisionBookBalance, SeveranceProvisionBookBalance,
} from '@/types/database';
import { isBotswana, leaveProvisionCapDays } from '@/lib/payroll-calc';
import { sortHotels } from '@/lib/utils';
import { fetchScenarioLineMap } from '@/lib/scenario-lines';

const LEAVE_BONUS_HOTEL_CODES = ['ILG', 'IH', 'ILRB', 'APA', 'CSL', 'NL', 'CFEM'];
// Matches the standalone Severance & Gratuity Provision page's own scope —
// widened from ILG-only. A hotel/employee can have either, both, or neither
// of Severance and Gratuity; the two are independent employee flags.
const SEVERANCE_HOTEL_CODES = ['ILG', 'CSL', 'NL', 'CFEM'];
// CSL/NL/CFEM's Bonus Required (Dec) is halved relative to the standard New
// Gross Salary × factor formula — per explicit instruction, mirrors the
// standalone Bonus Provision page's own HALF_RATE_HOTEL_CODES. Excludes
// incentive-scheme employees (already unaffected by the base formula too).
const BONUS_HALF_RATE_HOTEL_CODES = ['CSL', 'NL', 'CFEM'];
const ACCRUAL_MONTHS_KEY = 'ihg-salary-bonus-accrual-months';
const DEFAULT_ACCRUAL_MONTHS = 7;
const SEVERANCE_SENIOR_YEARS = 5;

// One-off override: FRE001/FRE002 (Diane & James French, CFEM) accrue
// gratuity from their LOA start date rather than a straight Gross × Rate%,
// mirroring the standalone Severance & Gratuity Provision page's own
// GRATUITY_ACCRUAL_START — every other gratuity_applicable employee keeps
// the straight formula.
const GRATUITY_ACCRUAL_START: Record<string, string> = {
  FRE001: '2024-10-01',
  FRE002: '2024-10-01',
};

// Whole calendar months from the accrual start date to 31 July of the
// selected Year (e.g. 1 Oct 2024 → 31 Jul 2026 = 21 months).
function periodOfAccrualMonths(startDate: string, year: number): number {
  const start = new Date(startDate);
  const end = new Date(year, 6, 31); // 31 July
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

function yearsOfService(date: string | null): number {
  if (!date) return 0;
  const ms = Date.now() - new Date(date).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25) * 10) / 10;
}

function monthsOfService(date: string | null): number {
  if (!date) return 0;
  const start = new Date(date);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

function monthsSinceLastPayoutThreshold(date: string | null): number {
  const totalMonths = monthsOfService(date);
  const lastThresholdMonths = Math.floor(totalMonths / 60) * 60;
  return totalMonths - lastThresholdMonths;
}

// Whole calendar months of service projected forward to 31 Dec of the
// selected bonus year — the 13th-cheque payout factor's basis. Mirrors the
// Bonus Provision page's own copy of this helper.
function monthsOfServiceAtDec(employmentDate: string | null, year: number): number {
  if (!employmentDate) return 0;
  const start = new Date(employmentDate);
  const ref = new Date(year, 11, 31);
  let months = (ref.getFullYear() - start.getFullYear()) * 12 + (ref.getMonth() - start.getMonth());
  if (ref.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

// ── Style helpers (match reports-export.ts / excel-export.ts) ────────────────

const NAVY  = '1B3A5C';
const LGRAY = 'E8ECF0';
const LBLUE = 'EEF2F7';
const DBLUE = '2C4A6E';

function hdr(v: string) {
  return {
    v, t: 's',
    s: {
      font:      { bold: true, color: { rgb: 'FFFFFF' } },
      fill:      { patternType: 'solid', fgColor: { rgb: NAVY } },
      alignment: { horizontal: 'center', wrapText: true, vertical: 'center' },
      border:    { bottom: { style: 'thin', color: { rgb: 'AAAAAA' } } },
    },
  };
}

function sectionHdr(v: string) {
  return {
    v, t: 's',
    s: {
      font:      { bold: true, sz: 12, color: { rgb: 'FFFFFF' } },
      fill:      { patternType: 'solid', fgColor: { rgb: DBLUE } },
      alignment: { horizontal: 'left', vertical: 'center' },
    },
  };
}

function str(v: string, bold = false) {
  return { v: v || '—', t: 's', s: { alignment: { horizontal: 'left' }, ...(bold ? { font: { bold: true } } : {}) } };
}

// Excel's date epoch is 1899-12-30 (serial 0) — writing a real numeric date
// cell (rather than a display string) is what lets DATEDIF() formulas
// elsewhere on the sheet reference this cell directly.
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
function dateCell(dateStr: string | null) {
  if (!dateStr) return blankCell();
  const d = new Date(dateStr);
  const serial = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EXCEL_EPOCH_UTC) / 86400000);
  return { v: serial, t: 'n', z: 'dd-mm-yyyy', s: { alignment: { horizontal: 'left' } } };
}

function num(v: number, bold = false) {
  return {
    v, t: 'n', z: '#,##0.00',
    s: { alignment: { horizontal: 'right' }, ...(bold ? { font: { bold: true } } : {}) },
  };
}

// Formula cell — Excel recalculates `f` on open; `v` is the pre-computed
// value so viewers that don't auto-recalc still show the right figure.
function fml(formula: string, value: number, bold = false) {
  return {
    f: formula, v: value, t: 'n', z: '#,##0.00',
    s: { alignment: { horizontal: 'right' }, ...(bold ? { font: { bold: true } } : {}) },
  };
}

function totFml(formula: string, value: number) {
  return {
    f: formula, v: value, t: 'n', z: '#,##0.00',
    s: { fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, font: { bold: true }, alignment: { horizontal: 'right' } },
  };
}

function blankCell() {
  return { v: '—', t: 's', s: { alignment: { horizontal: 'center' }, font: { color: { rgb: 'CCCCCC' } } } };
}

function tot(v: number | string, isNum = true) {
  const base = { fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, font: { bold: true } };
  if (isNum) return { v: v as number, t: 'n', z: '#,##0.00', s: { ...base, alignment: { horizontal: 'right' } } };
  return { v: v as string, t: 's', s: { ...base, alignment: { horizontal: 'left' } } };
}

function totBlank() {
  return { v: '', t: 's', s: { fill: { patternType: 'solid', fgColor: { rgb: LGRAY } } } };
}

function ovHdr(v: string) {
  return {
    v, t: 's',
    s: {
      font:      { bold: true, color: { rgb: '444444' } },
      fill:      { patternType: 'solid', fgColor: { rgb: LBLUE } },
      alignment: { horizontal: 'center', wrapText: true, vertical: 'center' },
      border:    { bottom: { style: 'thin', color: { rgb: 'CCCCCC' } } },
    },
  };
}

function adjCell(v: number | null) {
  if (v === null) return blankCell();
  const color = v === 0 ? '666666' : v < 0 ? 'C0392B' : 'B7791F';
  return { v, t: 'n', z: '#,##0.00', s: { alignment: { horizontal: 'right' }, font: { bold: true, color: { rgb: color } } } };
}

// Adjustment as a live formula — floors (Required − On Books) down to the
// nearest 100 exactly like the standalone provision pages' own JS, so
// editing either input cell in Excel recalculates Adjustment automatically.
function adjFml(formula: string, v: number) {
  const color = v === 0 ? '666666' : v < 0 ? 'C0392B' : 'B7791F';
  return { f: formula, v, t: 'n', z: '#,##0.00', s: { alignment: { horizontal: 'right' }, font: { bold: true, color: { rgb: color } } } };
}

// Group-header cell — the top row spanning each segment's column block.
// Non-anchor cells in the same merged range get the blank variant so the
// fill colour still shows through the whole merged region, not just the
// top-left cell.
function groupHdr(v: string) {
  return {
    v, t: 's',
    s: {
      font:      { bold: true, color: { rgb: 'FFFFFF' } },
      fill:      { patternType: 'solid', fgColor: { rgb: DBLUE } },
      alignment: { horizontal: 'center', vertical: 'center' },
    },
  };
}

function groupHdrBlank() {
  return { v: '', t: 's', s: { fill: { patternType: 'solid', fgColor: { rgb: DBLUE } } } };
}

// Adds a left border to an existing cell — used to mark the boundary between
// segment column blocks (Employee | Leave | Bonus | Severance | Total).
function withLeftBorder(c: any) {
  return { ...c, s: { ...(c.s ?? {}), border: { ...(c.s?.border ?? {}), left: { style: 'medium', color: { rgb: '888888' } } } } };
}

// ── Data types ─────────────────────────────────────────────────────────────

interface LeaveRow { employee: Employee; provision: LeaveProvision; hotel: Hotel }
interface BonusRow {
  employee: Employee; hotel: Hotel; gross: number; monthsOfService: number; factor: number;
  decBonusRequired: number; incentive: number; provisionBalance: number;
}
interface SeveranceRow {
  employee: Employee; hotel: Hotel;
  hasSeverance: boolean; hasGratuity: boolean;
  basic: number; yrs: number; dailyRate: number;
  daysPerMonth: number; monthlyRate: number; monthsAccrued: number; severanceBalance: number;
  gratuityGross: number; gratuityRate: number; gratuityBalance: number;
  provisionBalance: number; // severanceBalance + gratuityBalance
}

interface HotelAdjustment { cost: number; book: number; adjustment: number }
// Gratuity has no book-balance table of its own (matches the standalone
// page's own Book Adjustment, which stays Severance-only) — Required-only.
interface HotelCostOnly { cost: number }

interface CombinedRow {
  employee: Employee;
  leave?: LeaveRow;
  bonus?: BonusRow;
  severance?: SeveranceRow;
}

// Merges the three segments' per-employee rows into one row per employee —
// an employee present in only one or two segments still gets a single row,
// with the missing segment's cells rendered as blanks.
function combineRows(leaveRows: LeaveRow[], bonusRows: BonusRow[], severanceRows: SeveranceRow[]): CombinedRow[] {
  const map = new Map<string, CombinedRow>();
  for (const r of leaveRows) map.set(r.employee.id, { employee: r.employee, leave: r });
  for (const r of bonusRows) {
    const ex = map.get(r.employee.id);
    if (ex) ex.bonus = r; else map.set(r.employee.id, { employee: r.employee, bonus: r });
  }
  for (const r of severanceRows) {
    const ex = map.get(r.employee.id);
    if (ex) ex.severance = r; else map.set(r.employee.id, { employee: r.employee, severance: r });
  }
  return [...map.values()].sort((a, b) => a.employee.surname.localeCompare(b.employee.surname));
}

// ── Sheet builders ─────────────────────────────────────────────────────────

// One row per employee — Leave, Bonus, and (ILG/CSL/NL/CFEM) Severance and
// Gratuity columns sit side by side on that same row rather than in stacked
// per-segment tables, so an employee's figures across all applicable
// provisions read left to right. Grade is intentionally omitted.
function buildHotelSheet(
  hotel: Hotel,
  leaveRows: LeaveRow[],
  bonusRows: BonusRow[],
  severanceRows: SeveranceRow[],
  accrualMonths: number,
  year: number,
  latestSalaryMap: Map<string, SalaryRecord>,
  newGrossMap: Map<string, number>,
  XLSX: any,
): any {
  const bw = isBotswana(hotel.country);
  const sym = bw ? 'P' : 'R';
  const hasSeverance = SEVERANCE_HOTEL_CODES.includes(hotel.short_code);
  const combined = combineRows(leaveRows, bonusRows, severanceRows);
  // Fixed anchor dates for the live tenure formulas below — 31 July of the
  // selected year for general Years/Months Service, 31 December for Bonus's
  // Mths Service (Dec) (matches Bonus's own Dec-31 payout-factor anchor).
  const julyAnchor = `DATE(${year},7,31)`;
  const decAnchor = `DATE(${year},12,31)`;
  // Leave's Daily Rate divisor is hotel-configurable (falls back to 26 for
  // Botswana / 30.42 for South Africa, matching payroll-calc's own default);
  // Severance's is always a fixed 26, per the Basic ÷ 26 formula.
  const leaveDivisor = hotel.leave_provision_divisor ?? (bw ? 26 : 30.42);

  // New Gross Salary (post-increase, from Salary Review) sits right after
  // Gross Salary in the shared Employee block — not duplicated into the
  // Leave/Bonus segment blocks, even though Bonus's own calc uses it.
  const employeeHeaders = [
    'Emp Code', 'Surname', 'First Name', 'Start Date (dd-mm-yyyy)', 'Job Title',
    'Years Service', 'Months Service', 'Gross Salary', 'New Gross Salary',
  ];
  const groups: { label: string; headers: string[] }[] = [
    { label: 'EMPLOYEE', headers: employeeHeaders },
    { label: `LEAVE PROVISION (${sym})`, headers: ['Actual Leave Balance', 'Capped Leave Balance', 'Daily Rate', 'Provision Value'] },
    { label: `BONUS PROVISION incl. INCENTIVE (${sym}) — Accrual Months: ${accrualMonths}`, headers: ['Mths Service (Dec)', 'Payout Factor', 'Bonus Required (Dec)', 'Incentive', 'Provision Balance'] },
  ];
  if (hasSeverance) {
    groups.push({ label: `SEVERANCE PROVISION (${sym})`, headers: ['Basic Salary', 'Yrs Service', 'Daily Rate', 'Days/Month', 'Monthly Rate', 'Months Accrued', 'Provision Balance'] });
    groups.push({ label: `GRATUITY PROVISION (${sym})`, headers: ['Gross Salary', 'Gratuity Rate', 'Provision Balance'] });
  }

  const groupRow: any[] = [];
  const colHeaderRow: any[] = [];
  const merges: any[] = [];
  const groupBoundaries: number[] = []; // start column of every group after the first
  let col = 0;
  for (const g of groups) {
    const start = col;
    if (start > 0) groupBoundaries.push(start);
    groupRow.push(groupHdr(g.label));
    for (let i = 1; i < g.headers.length; i++) groupRow.push(groupHdrBlank());
    for (const h of g.headers) colHeaderRow.push(hdr(h));
    col += g.headers.length;
    if (g.headers.length > 1) merges.push({ s: { r: 0, c: start }, e: { r: 0, c: col - 1 } });
  }
  const totalCols = col;

  // Mark each segment boundary with a left border on the group/header row and
  // on the first column of that segment in every data/totals row.
  for (const b of groupBoundaries) {
    groupRow[b] = withLeftBorder(groupRow[b]);
    colHeaderRow[b] = withLeftBorder(colHeaderRow[b]);
  }

  // Column offsets for formula references — fixed per this hotel's layout
  // (severance/gratuity only present when hasSeverance).
  const startDateCol = 3; // Employee block's Start Date column
  const leaveStart = employeeHeaders.length;
  const bonusStart = leaveStart + 4;
  const severanceStart = hasSeverance ? bonusStart + 5 : -1;
  const gratuityStart = hasSeverance ? severanceStart + 7 : -1;
  const colLetter = (i: number) => XLSX.utils.encode_col(i);

  const dataRows = combined.map((row, i) => {
    const r = i + 3; // Excel row number (group row=1, header row=2, first data row=3)
    const empGross = latestSalaryMap.get(row.employee.id)?.total_earnings;
    const empNewGross = newGrossMap.get(row.employee.id);
    const startCell = colLetter(startDateCol) + r;
    const grossCell = colLetter(7) + r; // Employee block's own Gross Salary column
    const cells: any[] = [
      str(row.employee.employee_code ?? '—'), str(row.employee.surname), str(row.employee.first_name),
      dateCell(row.employee.employment_date), str(row.employee.job_title ?? '—'),
      // Years/Months Service anchored to 31 July of the selected year rather
      // than "today" — a fixed, reproducible snapshot date for this workbook.
      fml(`ROUND(DATEDIF(${startCell},${julyAnchor},"d")/365.25,1)`, yearsOfService(row.employee.employment_date)),
      fml(`DATEDIF(${startCell},${julyAnchor},"m")`, monthsOfService(row.employee.employment_date)),
      empGross != null ? num(empGross) : blankCell(),
      empNewGross != null ? num(empNewGross) : blankCell(),
    ];

    if (row.leave) {
      const capped = Math.min(row.leave.provision.leave_balance_days, leaveProvisionCapDays(hotel.short_code));
      const cappedCol = colLetter(leaveStart + 1);
      const rateCol = colLetter(leaveStart + 2);
      cells.push(
        num(row.leave.provision.leave_balance_days),
        num(capped),
        // Daily Rate = Gross Salary ÷ this hotel's Leave Provision divisor.
        fml(`${grossCell}/${leaveDivisor}`, row.leave.provision.daily_rate),
        fml(`${rateCol}${r}*${cappedCol}${r}`, row.leave.provision.provision_value),
      );
    } else {
      cells.push(blankCell(), blankCell(), blankCell(), blankCell());
    }

    if (row.bonus) {
      // Bonus Required (Dec) reads directly from the Employee block's New
      // Gross Salary column via formula, not a duplicated Gross Salary cell
      // in this segment — except incentive-scheme employees, who are always
      // 0 here (unaffected, they use their Incentive rate instead). CSL/NL/
      // CFEM's formula carries an explicit ×0.5 so it stays correct if the
      // user edits an upstream cell and Excel recalculates.
      const monthsCol = colLetter(bonusStart);
      const payoutFactorCol = colLetter(bonusStart + 1);
      const newGrossCol = colLetter(employeeHeaders.length - 1);
      const isIncentive = row.bonus.employee.incentive_applicable;
      const halfRate = BONUS_HALF_RATE_HOTEL_CODES.includes(hotel.short_code);
      cells.push(
        // Mths Service (Dec) anchored to 31 December of the selected year —
        // the 13th-cheque payout factor's own basis.
        fml(`DATEDIF(${startCell},${decAnchor},"m")`, row.bonus.monthsOfService),
        fml(`MIN(${monthsCol}${r},12)/12`, +(row.bonus.factor * 100).toFixed(1)),
        isIncentive
          ? num(row.bonus.decBonusRequired)
          : fml(`${newGrossCol}${r}*${payoutFactorCol}${r}${halfRate ? '*0.5' : ''}`, row.bonus.decBonusRequired),
        num(row.bonus.incentive), num(row.bonus.provisionBalance),
      );
    } else {
      cells.push(blankCell(), blankCell(), blankCell(), blankCell(), blankCell());
    }

    if (hasSeverance) {
      if (row.severance?.hasSeverance) {
        const basicCol = colLetter(severanceStart);
        const rateCol = colLetter(severanceStart + 2);
        const monthsAccruedCol = colLetter(severanceStart + 5);
        cells.push(
          num(row.severance.basic),
          // Yrs Service — same 31-July-anchored formula as the Employee
          // block's own Years Service, referencing the same Start Date cell.
          fml(`ROUND(DATEDIF(${startCell},${julyAnchor},"d")/365.25,1)`, row.severance.yrs),
          fml(`${basicCol}${r}/26`, row.severance.dailyRate),
          num(row.severance.daysPerMonth), num(row.severance.monthlyRate), num(row.severance.monthsAccrued),
          fml(`${rateCol}${r}*${monthsAccruedCol}${r}`, row.severance.severanceBalance),
        );
      } else {
        cells.push(blankCell(), blankCell(), blankCell(), blankCell(), blankCell(), blankCell(), blankCell());
      }

      // Gratuity Provision Balance stays a static value, not a formula — its
      // derivation branches on the FRE001/FRE002 period-of-accrual override,
      // which isn't exposed as its own column here (mirrors Bonus Required
      // (Dec)'s same static-value treatment above).
      if (row.severance?.hasGratuity) {
        cells.push(
          num(row.severance.gratuityGross), num(row.severance.gratuityRate),
          num(row.severance.gratuityBalance),
        );
      } else {
        cells.push(blankCell(), blankCell(), blankCell());
      }
    }

    for (const b of groupBoundaries) cells[b] = withLeftBorder(cells[b]);
    return cells;
  });

  const sumLeave = combined.reduce((s, r) => s + (r.leave?.provision.provision_value ?? 0), 0);
  const sumBonus = combined.reduce((s, r) => s + (r.bonus?.provisionBalance ?? 0), 0);
  const sumSeverance = hasSeverance ? combined.reduce((s, r) => s + (r.severance?.severanceBalance ?? 0), 0) : 0;
  const sumGratuity = hasSeverance ? combined.reduce((s, r) => s + (r.severance?.gratuityBalance ?? 0), 0) : 0;

  const firstDataRow = 3;
  const lastDataRow = 2 + combined.length;
  const rangeSum = (colIdx: number) => `SUM(${colLetter(colIdx)}${firstDataRow}:${colLetter(colIdx)}${lastDataRow})`;

  const totRow: any[] = [tot(`Total (${combined.length} employees)`, false), ...Array.from({ length: employeeHeaders.length - 1 }, () => totBlank())];
  totRow.push(totBlank(), totBlank(), totBlank(), totFml(rangeSum(leaveStart + 3), sumLeave));
  totRow.push(totBlank(), totBlank(), totBlank(), totBlank(), totFml(rangeSum(bonusStart + 4), sumBonus));
  if (hasSeverance) {
    totRow.push(totBlank(), totBlank(), totBlank(), totBlank(), totBlank(), totBlank(), totFml(rangeSum(severanceStart + 6), sumSeverance));
    totRow.push(totBlank(), totBlank(), totFml(rangeSum(gratuityStart + 2), sumGratuity));
  }
  for (const b of groupBoundaries) totRow[b] = withLeftBorder(totRow[b]);

  const aoa = [groupRow, colHeaderRow, ...dataRows, totRow];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;
  ws['!cols'] = Array.from({ length: totalCols }, (_, i) => (i < employeeHeaders.length ? { wch: 14 } : { wch: 15 }));
  ws['!freeze'] = { xSplit: 0, ySplit: 2 };
  return ws;
}

function buildOverviewSheet(
  hotels: Hotel[],
  leaveAdj: Map<string, HotelAdjustment>,
  bonusAdj: Map<string, HotelAdjustment>,
  severanceAdj: Map<string, HotelAdjustment>,
  gratuityAdj: Map<string, HotelCostOnly>,
  XLSX: any,
): any {
  const headers = [
    ovHdr('Hotel'), ovHdr('Currency'),
    ovHdr('Leave — Required'), ovHdr('Leave — On Books'), ovHdr('Leave — Adjustment'),
    ovHdr('Bonus — Required'), ovHdr('Bonus — On Books'), ovHdr('Bonus — Adjustment'),
    ovHdr('Severance — Required'), ovHdr('Severance — On Books'), ovHdr('Severance — Adjustment'),
    // Gratuity has no book-balance table of its own — Required only, matching
    // the standalone Severance & Gratuity page's own Book Adjustment scope.
    ovHdr('Gratuity — Required'),
  ];

  // Data rows start at Excel row 4 (row1=section header, row2=blank, row3=headers).
  const rows = hotels.map((h, i) => {
    const r = i + 4;
    const bw = isBotswana(h.country);
    const l = leaveAdj.get(h.id);
    const b = bonusAdj.get(h.id);
    const s = severanceAdj.get(h.id);
    const g = gratuityAdj.get(h.id);

    return [
      str(h.name, true),
      { v: bw ? 'BWP (P)' : 'ZAR (R)', t: 's', s: { alignment: { horizontal: 'center' } } },
      l ? num(l.cost) : blankCell(), l ? num(l.book) : blankCell(), l ? adjFml(`FLOOR.MATH(C${r}-D${r},100)`, l.adjustment) : blankCell(),
      b ? num(b.cost) : blankCell(), b ? num(b.book) : blankCell(), b ? adjFml(`FLOOR.MATH(F${r}-G${r},100)`, b.adjustment) : blankCell(),
      s ? num(s.cost) : blankCell(), s ? num(s.book) : blankCell(), s ? adjFml(`FLOOR.MATH(I${r}-J${r},100)`, s.adjustment) : blankCell(),
      g ? num(g.cost) : blankCell(),
    ];
  });

  const aoa = [[sectionHdr('PROVISIONS OVERVIEW')], [], headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }];
  ws['!cols'] = [
    { wch: 26 }, { wch: 12 },
    { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 15 },
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 3 };
  return ws;
}

// ── Shared data fetch (used by both the on-screen summary and the export) ──

interface ProvisionsData {
  exportHotels: Hotel[];
  leaveByHotel: Map<string, LeaveRow[]>;
  bonusByHotel: Map<string, BonusRow[]>;
  severanceByHotel: Map<string, SeveranceRow[]>;
  leaveAdj: Map<string, HotelAdjustment>;
  bonusAdj: Map<string, HotelAdjustment>;
  severanceAdj: Map<string, HotelAdjustment>;
  gratuityAdj: Map<string, HotelCostOnly>;
  accrualMonths: number;
  latestSalaryMap: Map<string, SalaryRecord>;
  newGrossMap: Map<string, number>;
}

async function fetchProvisionsData(year: number): Promise<ProvisionsData> {
  const sb = createClient();

  const { data: h } = await sb.from('hotels').select('*');
  const allHotels = sortHotels((h ?? []) as Hotel[]);
  const exportHotels = allHotels.filter(hh => LEAVE_BONUS_HOTEL_CODES.includes(hh.short_code));
  const hotelIds = exportHotels.map(hh => hh.id);
  const hotelMap = new Map(exportHotels.map(hh => [hh.id, hh]));

  let accrualMonths = DEFAULT_ACCRUAL_MONTHS;
  try {
    const saved = localStorage.getItem(ACCRUAL_MONTHS_KEY);
    if (saved) {
      const n = parseFloat(saved);
      if (!isNaN(n) && n > 0) accrualMonths = n;
    }
  } catch {}

  // Leave: employees unfiltered by status (matches the Leave Provision page)
  const [{ data: leaveEmp }, { data: provisions }, { data: leaveBook }, scenarioLineMap] = await Promise.all([
    sb.from('employees').select('*').in('hotel_id', hotelIds),
    sb.from('leave_provisions').select('*').in('hotel_id', hotelIds).eq('period_year', year),
    sb.from('leave_provision_book_balances').select('*').in('hotel_id', hotelIds).eq('period_year', year),
    fetchScenarioLineMap(sb, hotelIds),
  ]);
  const leaveEmpMap = new Map(((leaveEmp ?? []) as Employee[]).map(e => [e.id, e]));

  // Bonus: active employees only
  const [{ data: bonusEmp }, { data: bonusBook }] = await Promise.all([
    sb.from('employees').select('*').in('hotel_id', hotelIds).eq('status', 'active'),
    sb.from('bonus_provision_book_balances').select('*').in('hotel_id', hotelIds).eq('period_year', year),
  ]);
  const bonusEmployees = (bonusEmp ?? []) as Employee[];

  // Severance/Gratuity: active + (severance_applicable OR gratuity_applicable),
  // ILG/CSL/NL/CFEM — matches the standalone Severance & Gratuity page.
  const severanceHotelIds = exportHotels.filter(hh => SEVERANCE_HOTEL_CODES.includes(hh.short_code)).map(hh => hh.id);
  const [{ data: severanceEmp }, { data: severanceBook }] = await Promise.all([
    severanceHotelIds.length
      ? sb.from('employees').select('*').in('hotel_id', severanceHotelIds).eq('status', 'active')
          .or('severance_applicable.eq.true,gratuity_applicable.eq.true')
      : Promise.resolve({ data: [] as Employee[] }),
    severanceHotelIds.length
      ? sb.from('severance_provision_book_balances').select('*').in('hotel_id', severanceHotelIds).eq('period_year', year)
      : Promise.resolve({ data: [] as SeveranceProvisionBookBalance[] }),
  ]);
  const severanceEmployees = (severanceEmp ?? []) as Employee[];

  // Salary records for the union of every employee id referenced above —
  // includes leave-provision employees too, since Gross Salary is now a
  // per-row Employee column shared across all three segments.
  const empIdSet = new Set<string>([
    ...((provisions ?? []) as { employee_id: string }[]).map(p => p.employee_id),
    ...bonusEmployees.map(e => e.id),
    ...severanceEmployees.map(e => e.id),
  ]);
  const { data: sal } = empIdSet.size
    ? await sb.from('salary_records').select('*').in('employee_id', [...empIdSet])
    : { data: [] as SalaryRecord[] };
  const salaryRecords = (sal ?? []) as SalaryRecord[];
  const latestSalaryMap = new Map<string, SalaryRecord>();
  for (const s of salaryRecords) {
    const ex = latestSalaryMap.get(s.employee_id);
    if (!ex || s.period_year > ex.period_year || (s.period_year === ex.period_year && s.period_month > ex.period_month)) {
      latestSalaryMap.set(s.employee_id, s);
    }
  }

  // New Gross Salary (post-increase) per employee — from the winning Salary
  // Review scenario line for their hotel (draft, else latest committed),
  // reconstructed the same way SalarySummaryTable does (scenario_lines stores
  // basic only, so the structure allowance is added back). Falls back to the
  // employee's current Gross Salary when no increase applies to them.
  const newGrossMap = new Map<string, number>();
  for (const [empId, sal] of latestSalaryMap) {
    const currentGross = sal.total_earnings ?? 0;
    const sl = scenarioLineMap.get(empId);
    if (sl) {
      const structure = sal.allowances?.structure ?? 0;
      newGrossMap.set(empId, sl.new_basic + structure);
    } else {
      newGrossMap.set(empId, currentGross);
    }
  }

  // ── Build per-hotel row sets ────────────────────────────────────────────
  // ANO (vacant position) employees are excluded entirely from every segment —
  // not a real employee, so they never belong in a provisions export.
  const leaveByHotel = new Map<string, LeaveRow[]>();
  for (const p of (provisions ?? []) as LeaveProvision[]) {
    const employee = leaveEmpMap.get(p.employee_id);
    const hotel = hotelMap.get(p.hotel_id);
    if (!employee || !hotel || employee.grade_label === 'ANO') continue;
    if (!leaveByHotel.has(hotel.id)) leaveByHotel.set(hotel.id, []);
    leaveByHotel.get(hotel.id)!.push({ employee, provision: p, hotel });
  }
  for (const rows of leaveByHotel.values()) rows.sort((a, b) => a.employee.surname.localeCompare(b.employee.surname));

  // Non-incentive employees: months of service projected to 31 Dec of `year`
  // (capped at 12) drives a payout factor (months/12); under 6 months
  // forfeits the bonus entirely. Dec Bonus Required = Gross × factor, then
  // spread across the 11-month Jan–Nov accrual window. Incentive-scheme
  // employees are unaffected — their monthly rate × accrualMonths, as before.
  const bonusByHotel = new Map<string, BonusRow[]>();
  for (const employee of bonusEmployees) {
    if (employee.grade_label === 'ANO') continue;
    const hotel = hotelMap.get(employee.hotel_id);
    const salary = latestSalaryMap.get(employee.id);
    if (!hotel || !salary) continue;
    const gross = salary.total_earnings ?? 0;
    const monthsOfService = monthsOfServiceAtDec(employee.employment_date, year);
    const factor = Math.min(monthsOfService, 12) / 12;
    // Bonus Required (Dec) uses the post-increase New Gross Salary (falls
    // back to current Gross Salary when no increase applies), halved for
    // CSL/NL/CFEM — incentive-scheme employees are unaffected, they use
    // their incentive rate instead.
    const effectiveGross = newGrossMap.get(employee.id) ?? gross;
    const bonusRateMultiplier = BONUS_HALF_RATE_HOTEL_CODES.includes(hotel.short_code) ? 0.5 : 1;
    const decBonusRequired = (!employee.incentive_applicable && monthsOfService >= 6)
      ? Math.round(effectiveGross * factor * bonusRateMultiplier * 100) / 100
      : 0;
    const incentive = employee.incentive_applicable ? (salary.incentive ?? 0) : 0;
    const provisionBalance = employee.incentive_applicable
      ? Math.round(incentive * accrualMonths * 100) / 100
      : Math.round((decBonusRequired / 11) * accrualMonths * 100) / 100;
    if (!bonusByHotel.has(hotel.id)) bonusByHotel.set(hotel.id, []);
    bonusByHotel.get(hotel.id)!.push({
      employee, hotel, gross, monthsOfService, factor, decBonusRequired, incentive, provisionBalance,
    });
  }
  for (const rows of bonusByHotel.values()) rows.sort((a, b) => a.employee.surname.localeCompare(b.employee.surname));

  // A row can be severance-applicable, gratuity-applicable, or both. Gratuity
  // Balance is a straight Gross × Rate% (from salary_records.gratuity, which
  // calculateBurden() already computes) — no 5-year payout threshold, EXCEPT
  // the GRATUITY_ACCRUAL_START override (FRE001/FRE002), which multiplies by
  // the whole-months period of accrual instead. Mirrors the standalone
  // Severance & Gratuity Provision page's own row-building exactly.
  const severanceByHotel = new Map<string, SeveranceRow[]>();
  for (const employee of severanceEmployees) {
    if (employee.grade_label === 'ANO') continue;
    const hotel = hotelMap.get(employee.hotel_id);
    const salary = latestSalaryMap.get(employee.id);
    if (!hotel || !salary) continue;
    const hasSeverance = employee.severance_applicable;
    const hasGratuity = employee.gratuity_applicable;
    const yrs = yearsOfService(employee.employment_date);
    const daysPerMonth = yrs >= SEVERANCE_SENIOR_YEARS ? 2 : 1;
    const dailyRate = Math.round(((salary.basic_salary ?? 0) / 26) * 100) / 100;
    const monthsAccrued = hasSeverance ? monthsSinceLastPayoutThreshold(employee.employment_date) : 0;
    const severanceBalance = hasSeverance ? Math.round((salary.severance ?? 0) * monthsAccrued * 100) / 100 : 0;
    const accrualStart = employee.employee_code ? GRATUITY_ACCRUAL_START[employee.employee_code] : undefined;
    const gratuityGross = salary.total_earnings ?? 0;
    const gratuityBalance = !hasGratuity ? 0
      : accrualStart
        ? Math.round(gratuityGross * ((employee.gratuity_rate ?? 0) / 100) * periodOfAccrualMonths(accrualStart, year) * 100) / 100
        : (salary.gratuity ?? 0);
    const provisionBalance = severanceBalance + gratuityBalance;
    if (!severanceByHotel.has(hotel.id)) severanceByHotel.set(hotel.id, []);
    severanceByHotel.get(hotel.id)!.push({
      employee, hotel, hasSeverance, hasGratuity, basic: salary.basic_salary ?? 0, yrs, dailyRate, daysPerMonth,
      monthlyRate: salary.severance ?? 0, monthsAccrued, severanceBalance,
      gratuityGross, gratuityRate: employee.gratuity_rate ?? 0, gratuityBalance,
      provisionBalance,
    });
  }
  for (const rows of severanceByHotel.values()) rows.sort((a, b) => a.employee.surname.localeCompare(b.employee.surname));

  // ── Book Adjustment aggregates per hotel (Required / On Books / Adjustment) ─
  const leaveBookMap = new Map((leaveBook ?? []).map((b: LeaveProvisionBookBalance) => [b.hotel_id, b]));
  const bonusBookMap = new Map((bonusBook ?? []).map((b: BonusProvisionBookBalance) => [b.hotel_id, b]));
  const severanceBookMap = new Map((severanceBook ?? []).map((b: SeveranceProvisionBookBalance) => [b.hotel_id, b]));

  function adjustmentsFor(byHotel: Map<string, { provisionBalance: number }[]>, bookMap: Map<string, { book_provision: number }>): Map<string, HotelAdjustment> {
    const out = new Map<string, HotelAdjustment>();
    for (const [hotelId, rows] of byHotel) {
      const cost = rows.reduce((sum, r) => sum + r.provisionBalance, 0);
      const book = bookMap.get(hotelId)?.book_provision ?? 0;
      out.set(hotelId, { cost, book, adjustment: Math.floor((cost - book) / 100) * 100 });
    }
    return out;
  }
  const leaveAdj = adjustmentsFor(
    new Map([...leaveByHotel].map(([id, rows]) => [id, rows.map(r => ({ provisionBalance: r.provision.provision_value }))])),
    leaveBookMap,
  );
  const bonusAdj = adjustmentsFor(bonusByHotel, bonusBookMap);
  // Severance's own Book Adjustment stays severance-only, matching the
  // standalone page and the severance_provision_book_balances table it
  // reconciles against — gratuity has no book table, so it's summed
  // separately below as Required-only (no On Books/Adjustment concept).
  const severanceAdj = adjustmentsFor(
    new Map([...severanceByHotel].map(([id, rows]) => [id, rows.map(r => ({ provisionBalance: r.severanceBalance }))])),
    severanceBookMap,
  );
  const gratuityAdj = new Map<string, HotelCostOnly>();
  for (const [hotelId, rows] of severanceByHotel) {
    gratuityAdj.set(hotelId, { cost: rows.reduce((sum, r) => sum + r.gratuityBalance, 0) });
  }

  return { exportHotels, leaveByHotel, bonusByHotel, severanceByHotel, leaveAdj, bonusAdj, severanceAdj, gratuityAdj, accrualMonths, latestSalaryMap, newGrossMap };
}

// ── Public: on-screen summary (Overview page) ───────────────────────────────

export interface ProvisionsSummaryRow {
  hotel: Hotel;
  leave: HotelAdjustment | null;
  bonus: HotelAdjustment | null;
  severance: HotelAdjustment | null;
  gratuity: HotelCostOnly | null;
  totalCost: number;
  totalBook: number;
  totalAdjustment: number;
}

export async function loadProvisionsSummary(year: number): Promise<ProvisionsSummaryRow[]> {
  const d = await fetchProvisionsData(year);
  return d.exportHotels.map(hotel => {
    const leave = d.leaveAdj.get(hotel.id) ?? null;
    const bonus = d.bonusAdj.get(hotel.id) ?? null;
    const severance = d.severanceAdj.get(hotel.id) ?? null;
    const gratuity = d.gratuityAdj.get(hotel.id) ?? null;
    const totalCost = (leave?.cost ?? 0) + (bonus?.cost ?? 0) + (severance?.cost ?? 0) + (gratuity?.cost ?? 0);
    const totalBook = (leave?.book ?? 0) + (bonus?.book ?? 0) + (severance?.book ?? 0);
    const totalAdjustment = Math.floor((totalCost - totalBook) / 100) * 100;
    return { hotel, leave, bonus, severance, gratuity, totalCost, totalBook, totalAdjustment };
  });
}

// ── Public: export workbook ─────────────────────────────────────────────────

export async function exportAllProvisions(year: number): Promise<void> {
  const [d, XLSXmod] = await Promise.all([
    fetchProvisionsData(year),
    import('xlsx-js-style'),
  ]);
  const XLSX = XLSXmod.default ?? XLSXmod;
  const { exportHotels, leaveByHotel, bonusByHotel, severanceByHotel, leaveAdj, bonusAdj, severanceAdj, gratuityAdj, accrualMonths, latestSalaryMap, newGrossMap } = d;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildOverviewSheet(exportHotels, leaveAdj, bonusAdj, severanceAdj, gratuityAdj, XLSX), 'Overview');

  for (const hotel of exportHotels) {
    const leaveRows = leaveByHotel.get(hotel.id) ?? [];
    const bonusRows = bonusByHotel.get(hotel.id) ?? [];
    const severanceRows = severanceByHotel.get(hotel.id) ?? [];
    if (leaveRows.length === 0 && bonusRows.length === 0 && severanceRows.length === 0) continue;
    const sheetName = (hotel.short_code || hotel.name).replace(/[:\\/?\*\[\]']/g, '').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, buildHotelSheet(hotel, leaveRows, bonusRows, severanceRows, accrualMonths, year, latestSalaryMap, newGrossMap, XLSX), sheetName);
  }

  XLSX.writeFile(wb, `Provisions_Overview_${year}.xlsx`);
}
