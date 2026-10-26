// Annual Bonus Excel export — one Overview sheet plus one sheet per saved hotel.
// Per-hotel sheets carry live formulas (Mths Service, Factor, Bonus Amount) so the
// calculation is visible and recalculates if an input cell is edited, an
// AutoFilter on the header row, and a blank Comments column at the end.
// ANO (vacant position) rows are left out entirely.

const NAVY   = '1B3A5C';
const LGRAY  = 'E8ECF0';
const AMBER  = 'FFF4CC';

export interface AnnualBonusExportRow {
  employeeCode: string;
  surname: string;
  firstName: string;
  jobTitle: string;
  gradeLabel: string | null;
  basis: string;                 // "Standard" | "Incentive ×2" | "Override" | "Excluded"
  startDate: string | null;      // yyyy-mm-dd
  currentGross: number;
  baseGross: number;
  basePeriod: string | null;     // e.g. "Jun 2026" when the base came from an earlier record
  rate: number;                  // decimal: 0.5 = 50%; incentive multiplier 2 = 200%
  isIncentive: boolean;
  flat: number;
  isExcluded: boolean;
}

export interface AnnualBonusExportHotel {
  name: string;
  shortCode: string;
  currency: 'ZAR' | 'BWP';
  pct: string;
  flat: string;
  rows: AnnualBonusExportRow[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const thin = { style: 'thin', color: { rgb: 'D0D5DB' } };

function hdr(v: string, editable = false) {
  return {
    v, t: 's',
    s: {
      font:      { bold: true, color: { rgb: 'FFFFFF' } },
      fill:      { patternType: 'solid', fgColor: { rgb: editable ? 'B7791F' : NAVY } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border:    { bottom: thin },
    },
  };
}

function txt(v: string, bold = false, fill?: string) {
  return {
    v, t: 's',
    s: {
      alignment: { horizontal: 'left' },
      ...(bold ? { font: { bold: true } } : {}),
      ...(fill ? { fill: { patternType: 'solid', fgColor: { rgb: fill } } } : {}),
    },
  };
}

function num(v: number, z: string, opts: { bold?: boolean; fill?: string } = {}) {
  return {
    v, t: 'n', z,
    s: {
      alignment: { horizontal: 'right' },
      ...(opts.bold ? { font: { bold: true } } : {}),
      ...(opts.fill ? { fill: { patternType: 'solid', fgColor: { rgb: opts.fill } } } : {}),
    },
  };
}

function fx(f: string, z: string, cached: number, opts: { bold?: boolean; fill?: string } = {}) {
  return { ...num(cached, z, opts), f };
}

function dateCell(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const serial = (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  return { v: serial, t: 'n', z: 'dd-mm-yyyy', s: { alignment: { horizontal: 'center' } } };
}

function monthsAtDec(iso: string, year: number): number {
  const start = new Date(iso);
  const ref = new Date(year, 11, 31);
  let months = (ref.getFullYear() - start.getFullYear()) * 12 + (ref.getMonth() - start.getMonth());
  if (ref.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

function factorFor(months: number | null): number {
  if (months == null || months < 6) return 0;
  return Math.min(months, 12) / 12;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function sheetNameFor(shortCode: string): string {
  return shortCode.replace(/[:\\/?*[\]']/g, '').slice(0, 31);
}

// Column layout (per-hotel sheet)
const COLS = [
  'Emp Code', 'Surname', 'First Name', 'Job Title', 'Basis', 'Start Date',
  'Mths Service (31 Dec)', 'Factor', 'Current Gross', 'Bonus Base Gross', 'Base Period',
  'Rate (% / ×)', 'Flat', 'Bonus Amount', 'Comments',
];
// A    B    C    D    E    F    G    H    I    J    K    L    M    N    O

// CSL and NL list their Fixed Term Contract staff separately, below permanents.
const FTC_SPLIT_CODES = new Set(['CSL', 'NL']);

function buildHotelSheet(XLSX: any, hotel: AnnualBonusExportHotel, year: number) {
  const rows = hotel.rows.filter(r => r.gradeLabel !== 'ANO');
  const aoa: any[][] = [COLS.map(h => hdr(h, h === 'Rate (% / ×)' || h === 'Flat' || h === 'Comments'))];

  const bonusOf = (r: AnnualBonusExportRow) => {
    const months = r.startDate ? monthsAtDec(r.startDate, year) : null;
    const factor = factorFor(months);
    return r.isExcluded ? 0 : r2(r.baseGross * factor * r.rate + r.flat * factor);
  };
  const isIncentive = (r: AnnualBonusExportRow) => r.isIncentive && !r.isExcluded;
  // Incentive-scheme employees first, highest bonus first; everyone else keeps
  // the incoming (surname) order.
  const incentiveFirst = (list: AnnualBonusExportRow[]) => [
    ...list.filter(isIncentive).sort((a, b) => bonusOf(b) - bonusOf(a)),
    ...list.filter(r => !isIncentive(r)),
  ];

  const splitFtc  = FTC_SPLIT_CODES.has(hotel.shortCode);
  const ftcRows   = splitFtc ? rows.filter(r => r.gradeLabel === 'Fixed Term') : [];
  const permRows  = splitFtc ? rows.filter(r => r.gradeLabel !== 'Fixed Term') : rows;
  const ordered: (AnnualBonusExportRow | string)[] = [...incentiveFirst(permRows)];
  if (ftcRows.length) ordered.push(`Fixed Term Contract (${ftcRows.length})`, ...incentiveFirst(ftcRows));

  const merges: any[] = [];
  let bonusTotal = 0;
  ordered.forEach((r, i) => {
    const xr = i + 2; // Excel row
    if (typeof r === 'string') {
      aoa.push([txt(r, true, LGRAY), ...Array.from({ length: COLS.length - 1 }, () => txt('', true, LGRAY))]);
      merges.push({ s: { r: xr - 1, c: 0 }, e: { r: xr - 1, c: COLS.length - 1 } });
      return;
    }
    const months = r.startDate ? monthsAtDec(r.startDate, year) : null;
    const factor = factorFor(months);
    const rate   = r.isExcluded ? 0 : r.rate;
    const flat   = r.isExcluded ? 0 : r.flat;
    const bonus  = bonusOf(r);
    bonusTotal  += bonus;

    aoa.push([
      txt(r.employeeCode),
      txt(r.surname),
      txt(r.firstName),
      txt(r.jobTitle),
      txt(r.basis),
      r.startDate ? dateCell(r.startDate) : txt('no start date'),
      r.startDate
        ? fx(`DATEDIF(F${xr},DATE(${year},12,31),"m")`, '0', months ?? 0)
        : num(0, '0'),
      fx(`IF(G${xr}<6,0,MIN(G${xr},12)/12)`, '0.0000', factor),
      num(r.currentGross, '#,##0.00'),
      num(r.baseGross, '#,##0.00'),
      txt(r.basePeriod ?? 'Current'),
      // Incentive multipliers are plain numbers (2 = ×2), shown as "2.0×"
      num(rate, r.isIncentive && !r.isExcluded ? '0.0"×"' : '0.0%', { fill: AMBER }),
      num(flat, '#,##0.00', { fill: AMBER }),
      fx(`ROUND(J${xr}*H${xr}*L${xr}+M${xr}*H${xr},2)`, '#,##0.00', bonus, { bold: true }),
      txt('', false, AMBER),
    ]);
  });

  const last = ordered.length + 1;
  const tot  = last + 2; // one blank row between data and totals keeps the totals out of the filter
  aoa.push([]);
  const sum = (col: string) => (rows.length ? `SUM(${col}2:${col}${last})` : '0');
  aoa.push([
    txt('Total', true, LGRAY), txt('', true, LGRAY), txt('', true, LGRAY), txt('', true, LGRAY),
    txt(`${rows.length} employees`, true, LGRAY), txt('', true, LGRAY), txt('', true, LGRAY), txt('', true, LGRAY),
    fx(sum('I'), '#,##0.00', r2(rows.reduce((a, r) => a + r.currentGross, 0)), { bold: true, fill: LGRAY }),
    fx(sum('J'), '#,##0.00', r2(rows.reduce((a, r) => a + r.baseGross, 0)),    { bold: true, fill: LGRAY }),
    txt('', true, LGRAY), txt('', true, LGRAY),
    fx(sum('M'), '#,##0.00', r2(rows.reduce((a, r) => a + (r.isExcluded ? 0 : r.flat), 0)), { bold: true, fill: LGRAY }),
    fx(sum('N'), '#,##0.00', r2(bonusTotal), { bold: true, fill: LGRAY }),
    txt('', true, LGRAY),
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 10 }, { wch: 18 }, { wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 12 },
    { wch: 11 }, { wch: 9 }, { wch: 14 }, { wch: 15 }, { wch: 11 },
    { wch: 11 }, { wch: 11 }, { wch: 15 }, { wch: 40 },
  ];
  ws['!rows'] = [{ hpt: 32 }];
  if (merges.length) ws['!merges'] = merges;
  ws['!autofilter'] = { ref: `A1:O${Math.max(last, 1)}` };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  return { ws, totRow: tot, bonusTotal: r2(bonusTotal), paid: rows.length };
}

export async function exportAnnualBonus(hotels: AnnualBonusExportHotel[], year: number): Promise<void> {
  const XLSX = (await import('xlsx-js-style')).default ?? (await import('xlsx-js-style'));
  const wb = XLSX.utils.book_new();

  const built = hotels.map(h => ({ hotel: h, sheetName: sheetNameFor(h.shortCode), ...buildHotelSheet(XLSX, h, year) }));

  // Overview — Total Bonus pulls live from each hotel sheet's totals row
  const ovHeaders = ['Hotel', 'Sheet', 'Currency', '% of Gross', 'Flat', 'Employees (excl. ANO)', 'Total Bonus'];
  const ov: any[][] = [ovHeaders.map(h => hdr(h))];
  built.forEach(b => {
    ov.push([
      txt(b.hotel.name),
      txt(b.sheetName),
      txt(b.hotel.currency),
      txt(b.hotel.pct ? `${b.hotel.pct}%` : '—'),
      b.hotel.flat ? num(parseFloat(b.hotel.flat), '#,##0.00') : txt('—'),
      num(b.paid, '0'),
      fx(`'${b.sheetName}'!N${b.totRow}`, '#,##0.00', b.bonusTotal, { bold: true }),
    ]);
  });
  const ovWs = XLSX.utils.aoa_to_sheet(ov);
  ovWs['!cols'] = [{ wch: 34 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 16 }];
  ovWs['!autofilter'] = { ref: `A1:G${built.length + 1}` };
  ovWs['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ovWs, 'Overview');

  for (const b of built) XLSX.utils.book_append_sheet(wb, b.ws, b.sheetName);

  XLSX.writeFile(wb, `Annual_Bonus_${year}.xlsx`);
}
