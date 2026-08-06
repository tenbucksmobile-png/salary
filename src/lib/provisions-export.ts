// Combined Provisions export — one workbook covering Leave, Bonus (incl.
// Incentive), and Severance across the hotels each segment applies to, plus
// an Overview sheet aggregating each segment's Book Adjustment figures.
//
// Scope (per explicit instruction): Leave and Bonus both cover ILG/IH/ILRB/APA
// only for this export — Leave's wider all-hotels scope on its own standalone
// page is deliberately narrowed here to match Bonus/Severance so every hotel
// tab has at least two applicable segments. Severance stays ILG-only. WCA is
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

const LEAVE_BONUS_HOTEL_CODES = ['ILG', 'IH', 'ILRB', 'APA'];
const SEVERANCE_HOTEL_CODES = ['ILG'];
const ACCRUAL_MONTHS_KEY = 'ihg-salary-bonus-accrual-months';
const DEFAULT_ACCRUAL_MONTHS = 7;
const SEVERANCE_SENIOR_YEARS = 5;

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

function num(v: number, bold = false) {
  return {
    v, t: 'n', z: '#,##0.00',
    s: { alignment: { horizontal: 'right' }, ...(bold ? { font: { bold: true } } : {}) },
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
interface BonusRow { employee: Employee; hotel: Hotel; gross: number; bonusProvision: number; incentive: number; provisionBalance: number }
interface SeveranceRow {
  employee: Employee; hotel: Hotel; basic: number; yrs: number; dailyRate: number;
  daysPerMonth: number; monthlyRate: number; monthsAccrued: number; provisionBalance: number;
}

interface HotelAdjustment { cost: number; book: number; adjustment: number }

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

// One row per employee — Leave, Bonus, and (ILG only) Severance columns sit
// side by side on that same row rather than in stacked per-segment tables,
// so an employee's figures across all applicable provisions read left to
// right. Grade is intentionally omitted.
function buildHotelSheet(
  hotel: Hotel,
  leaveRows: LeaveRow[],
  bonusRows: BonusRow[],
  severanceRows: SeveranceRow[],
  accrualMonths: number,
  XLSX: any,
): any {
  const bw = isBotswana(hotel.country);
  const sym = bw ? 'P' : 'R';
  const hasSeverance = SEVERANCE_HOTEL_CODES.includes(hotel.short_code);
  const combined = combineRows(leaveRows, bonusRows, severanceRows);

  const groups: { label: string; headers: string[] }[] = [
    { label: 'EMPLOYEE', headers: ['Emp Code', 'Surname', 'First Name'] },
    { label: `LEAVE PROVISION (${sym})`, headers: ['Actual Leave Balance', 'Capped Leave Balance', 'Daily Rate', 'Provision Value'] },
    { label: `BONUS PROVISION incl. INCENTIVE (${sym}) — Accrual Months: ${accrualMonths}`, headers: ['Gross Salary', 'Bonus Provision', 'Incentive', 'Provision Balance'] },
  ];
  if (hasSeverance) {
    groups.push({ label: `SEVERANCE PROVISION (${sym})`, headers: ['Basic Salary', 'Yrs Service', 'Daily Rate', 'Days/Month', 'Monthly Rate', 'Months Accrued', 'Provision Balance'] });
  }
  groups.push({ label: 'TOTAL', headers: [`Provision Balance (${sym})`] });

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

  const dataRows = combined.map(row => {
    const cells: any[] = [
      str(row.employee.employee_code ?? '—'), str(row.employee.surname), str(row.employee.first_name),
    ];

    if (row.leave) {
      const capped = Math.min(row.leave.provision.leave_balance_days, leaveProvisionCapDays(hotel.short_code));
      cells.push(num(row.leave.provision.leave_balance_days), num(capped), num(row.leave.provision.daily_rate), num(row.leave.provision.provision_value));
    } else {
      cells.push(blankCell(), blankCell(), blankCell(), blankCell());
    }

    if (row.bonus) {
      cells.push(num(row.bonus.gross), num(row.bonus.bonusProvision), num(row.bonus.incentive), num(row.bonus.provisionBalance));
    } else {
      cells.push(blankCell(), blankCell(), blankCell(), blankCell());
    }

    if (hasSeverance) {
      if (row.severance) {
        cells.push(
          num(row.severance.basic), num(row.severance.yrs), num(row.severance.dailyRate),
          num(row.severance.daysPerMonth), num(row.severance.monthlyRate), num(row.severance.monthsAccrued),
          num(row.severance.provisionBalance),
        );
      } else {
        cells.push(blankCell(), blankCell(), blankCell(), blankCell(), blankCell(), blankCell(), blankCell());
      }
    }

    const total = (row.leave?.provision.provision_value ?? 0) + (row.bonus?.provisionBalance ?? 0) + (row.severance?.provisionBalance ?? 0);
    cells.push(num(total, true));

    for (const b of groupBoundaries) cells[b] = withLeftBorder(cells[b]);
    return cells;
  });

  const sumLeave = combined.reduce((s, r) => s + (r.leave?.provision.provision_value ?? 0), 0);
  const sumBonus = combined.reduce((s, r) => s + (r.bonus?.provisionBalance ?? 0), 0);
  const sumSeverance = hasSeverance ? combined.reduce((s, r) => s + (r.severance?.provisionBalance ?? 0), 0) : 0;
  const sumTotal = sumLeave + sumBonus + sumSeverance;

  const totRow: any[] = [tot(`Total (${combined.length} employees)`, false), totBlank(), totBlank()];
  totRow.push(totBlank(), totBlank(), totBlank(), tot(sumLeave));
  totRow.push(totBlank(), totBlank(), totBlank(), tot(sumBonus));
  if (hasSeverance) {
    totRow.push(totBlank(), totBlank(), totBlank(), totBlank(), totBlank(), totBlank(), tot(sumSeverance));
  }
  totRow.push(tot(sumTotal));
  for (const b of groupBoundaries) totRow[b] = withLeftBorder(totRow[b]);

  const aoa = [groupRow, colHeaderRow, ...dataRows, totRow];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;
  ws['!cols'] = Array.from({ length: totalCols }, (_, i) => (i < 3 ? { wch: 14 } : { wch: 15 }));
  ws['!freeze'] = { xSplit: 0, ySplit: 2 };
  return ws;
}

function buildOverviewSheet(
  hotels: Hotel[],
  leaveAdj: Map<string, HotelAdjustment>,
  bonusAdj: Map<string, HotelAdjustment>,
  severanceAdj: Map<string, HotelAdjustment>,
  XLSX: any,
): any {
  const headers = [
    ovHdr('Hotel'), ovHdr('Currency'),
    ovHdr('Leave — Required'), ovHdr('Leave — On Books'), ovHdr('Leave — Adjustment'),
    ovHdr('Bonus — Required'), ovHdr('Bonus — On Books'), ovHdr('Bonus — Adjustment'),
    ovHdr('Severance — Required'), ovHdr('Severance — On Books'), ovHdr('Severance — Adjustment'),
  ];

  const rows = hotels.map(h => {
    const bw = isBotswana(h.country);
    const l = leaveAdj.get(h.id);
    const b = bonusAdj.get(h.id);
    const s = severanceAdj.get(h.id);

    return [
      str(h.name, true),
      { v: bw ? 'BWP (P)' : 'ZAR (R)', t: 's', s: { alignment: { horizontal: 'center' } } },
      l ? num(l.cost) : blankCell(), l ? num(l.book) : blankCell(), l ? adjCell(l.adjustment) : blankCell(),
      b ? num(b.cost) : blankCell(), b ? num(b.book) : blankCell(), b ? adjCell(b.adjustment) : blankCell(),
      s ? num(s.cost) : blankCell(), s ? num(s.book) : blankCell(), s ? adjCell(s.adjustment) : blankCell(),
    ];
  });

  const aoa = [[sectionHdr('PROVISIONS OVERVIEW')], [], headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }];
  ws['!cols'] = [
    { wch: 26 }, { wch: 12 },
    { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 15 }, { wch: 15 }, { wch: 15 },
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
  accrualMonths: number;
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
  const [{ data: leaveEmp }, { data: provisions }, { data: leaveBook }] = await Promise.all([
    sb.from('employees').select('*').in('hotel_id', hotelIds),
    sb.from('leave_provisions').select('*').in('hotel_id', hotelIds).eq('period_year', year),
    sb.from('leave_provision_book_balances').select('*').in('hotel_id', hotelIds).eq('period_year', year),
  ]);
  const leaveEmpMap = new Map(((leaveEmp ?? []) as Employee[]).map(e => [e.id, e]));

  // Bonus: active employees only
  const [{ data: bonusEmp }, { data: bonusBook }] = await Promise.all([
    sb.from('employees').select('*').in('hotel_id', hotelIds).eq('status', 'active'),
    sb.from('bonus_provision_book_balances').select('*').in('hotel_id', hotelIds).eq('period_year', year),
  ]);
  const bonusEmployees = (bonusEmp ?? []) as Employee[];

  // Severance: active + severance_applicable, ILG only
  const severanceHotelIds = exportHotels.filter(hh => SEVERANCE_HOTEL_CODES.includes(hh.short_code)).map(hh => hh.id);
  const [{ data: severanceEmp }, { data: severanceBook }] = await Promise.all([
    severanceHotelIds.length
      ? sb.from('employees').select('*').in('hotel_id', severanceHotelIds).eq('status', 'active').eq('severance_applicable', true)
      : Promise.resolve({ data: [] as Employee[] }),
    severanceHotelIds.length
      ? sb.from('severance_provision_book_balances').select('*').in('hotel_id', severanceHotelIds).eq('period_year', year)
      : Promise.resolve({ data: [] as SeveranceProvisionBookBalance[] }),
  ]);
  const severanceEmployees = (severanceEmp ?? []) as Employee[];

  // Salary records for the union of every employee id referenced above
  const empIdSet = new Set<string>([
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

  const bonusByHotel = new Map<string, BonusRow[]>();
  for (const employee of bonusEmployees) {
    if (employee.grade_label === 'ANO') continue;
    const hotel = hotelMap.get(employee.hotel_id);
    const salary = latestSalaryMap.get(employee.id);
    if (!hotel || !salary) continue;
    const bonusProvision = salary.bonus_provision ?? 0;
    const incentive = salary.incentive ?? 0;
    const provisionBalance = Math.round((bonusProvision + incentive) * accrualMonths * 100) / 100;
    if (!bonusByHotel.has(hotel.id)) bonusByHotel.set(hotel.id, []);
    bonusByHotel.get(hotel.id)!.push({
      employee, hotel, gross: salary.total_earnings ?? 0, bonusProvision, incentive, provisionBalance,
    });
  }
  for (const rows of bonusByHotel.values()) rows.sort((a, b) => a.employee.surname.localeCompare(b.employee.surname));

  const severanceByHotel = new Map<string, SeveranceRow[]>();
  for (const employee of severanceEmployees) {
    if (employee.grade_label === 'ANO') continue;
    const hotel = hotelMap.get(employee.hotel_id);
    const salary = latestSalaryMap.get(employee.id);
    if (!hotel || !salary) continue;
    const yrs = yearsOfService(employee.employment_date);
    const daysPerMonth = yrs >= SEVERANCE_SENIOR_YEARS ? 2 : 1;
    const dailyRate = Math.round(((salary.basic_salary ?? 0) / 26) * 100) / 100;
    const monthsAccrued = monthsSinceLastPayoutThreshold(employee.employment_date);
    const provisionBalance = Math.round((salary.severance ?? 0) * monthsAccrued * 100) / 100;
    if (!severanceByHotel.has(hotel.id)) severanceByHotel.set(hotel.id, []);
    severanceByHotel.get(hotel.id)!.push({
      employee, hotel, basic: salary.basic_salary ?? 0, yrs, dailyRate, daysPerMonth,
      monthlyRate: salary.severance ?? 0, monthsAccrued, provisionBalance,
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
  const severanceAdj = adjustmentsFor(severanceByHotel, severanceBookMap);

  return { exportHotels, leaveByHotel, bonusByHotel, severanceByHotel, leaveAdj, bonusAdj, severanceAdj, accrualMonths };
}

// ── Public: on-screen summary (Overview page) ───────────────────────────────

export interface ProvisionsSummaryRow {
  hotel: Hotel;
  leave: HotelAdjustment | null;
  bonus: HotelAdjustment | null;
  severance: HotelAdjustment | null;
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
    const totalCost = (leave?.cost ?? 0) + (bonus?.cost ?? 0) + (severance?.cost ?? 0);
    const totalBook = (leave?.book ?? 0) + (bonus?.book ?? 0) + (severance?.book ?? 0);
    const totalAdjustment = Math.floor((totalCost - totalBook) / 100) * 100;
    return { hotel, leave, bonus, severance, totalCost, totalBook, totalAdjustment };
  });
}

// ── Public: export workbook ─────────────────────────────────────────────────

export async function exportAllProvisions(year: number): Promise<void> {
  const [d, XLSXmod] = await Promise.all([
    fetchProvisionsData(year),
    import('xlsx-js-style'),
  ]);
  const XLSX = XLSXmod.default ?? XLSXmod;
  const { exportHotels, leaveByHotel, bonusByHotel, severanceByHotel, leaveAdj, bonusAdj, severanceAdj, accrualMonths } = d;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildOverviewSheet(exportHotels, leaveAdj, bonusAdj, severanceAdj, XLSX), 'Overview');

  for (const hotel of exportHotels) {
    const leaveRows = leaveByHotel.get(hotel.id) ?? [];
    const bonusRows = bonusByHotel.get(hotel.id) ?? [];
    const severanceRows = severanceByHotel.get(hotel.id) ?? [];
    if (leaveRows.length === 0 && bonusRows.length === 0 && severanceRows.length === 0) continue;
    const sheetName = (hotel.short_code || hotel.name).replace(/[:\\/?\*\[\]']/g, '').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, buildHotelSheet(hotel, leaveRows, bonusRows, severanceRows, accrualMonths, XLSX), sheetName);
  }

  XLSX.writeFile(wb, `Provisions_Overview_${year}.xlsx`);
}
