// Salary review Excel export — one sheet per hotel + a Summary sheet
// Uses xlsx-js-style (SheetJS community + cell-level styling)

export interface ExportHotelRow {
  surname: string;
  firstName: string;
  jobTitle: string;
  grade: string;
  department: string;
  currentBasic: number;
  effectivePct: number;   // decimal e.g. 0.06
  effectiveFlat: number;
  newBasic: number;
  currentCtc: number;
  newCtc: number;
}

export interface ExportHotel {
  id: string;
  name: string;
  shortCode: string;
  country: string;
  rows: ExportHotelRow[];
}

// ── Style constants ───────────────────────────────────────────────────────────

const NAVY  = '1B3A5C';
const LGRAY = 'E8ECF0';
const GREEN = '15623A';

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

function str(v: string, bold = false) {
  return { v: v || '', t: 's', s: { alignment: { horizontal: 'left' }, ...(bold ? { font: { bold: true } } : {}) } };
}

function num(v: number, bold = false, green = false) {
  return {
    v, t: 'n', z: '#,##0',
    s: {
      alignment: { horizontal: 'right' },
      ...(bold  ? { font: { bold: true } } : {}),
      ...(green ? { font: { bold, color: { rgb: GREEN } } } : {}),
    },
  };
}

function pctNum(v: number) {
  return {
    v: +(v * 100).toFixed(1), t: 'n', z: '0.0"%"',
    s: { alignment: { horizontal: 'right' }, font: { color: { rgb: GREEN } } },
  };
}

function tot(v: number | string, isNum = true) {
  const base = { fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, font: { bold: true } };
  if (isNum) return { v: v as number, t: 'n', z: '#,##0', s: { ...base, alignment: { horizontal: 'right' } } };
  return { v: v as string, t: 's', s: { ...base, alignment: { horizontal: 'left' } } };
}

// ── Hotel detail sheet ────────────────────────────────────────────────────────

function buildHotelSheet(hotel: ExportHotel, XLSX: any): any {
  const bw  = hotel.country.toLowerCase().includes('botswana');
  const sym = bw ? 'P' : 'R';

  const headers = [
    hdr('Surname'), hdr('First Name'), hdr('Job Title'), hdr('Grade'), hdr('Department'),
    hdr(`Current Basic (${sym})`), hdr('% Increase'), hdr(`Flat Adj (${sym})`),
    hdr(`New Basic (${sym})`), hdr(`Monthly Inc (${sym})`),
    hdr(`Current CTC (${sym})`), hdr(`New CTC (${sym})`),
    hdr(`Monthly CTC Δ (${sym})`), hdr(`Annual CTC Δ (${sym})`),
  ];

  const dataRows = hotel.rows.map(r => [
    str(r.surname),
    str(r.firstName),
    str(r.jobTitle),
    str(r.grade),
    str(r.department),
    num(r.currentBasic),
    pctNum(r.effectivePct),
    num(r.effectiveFlat),
    num(r.newBasic, true),
    num(r.newBasic - r.currentBasic, false, true),
    num(r.currentCtc),
    num(r.newCtc, true),
    num(r.newCtc - r.currentCtc, false, true),
    num((r.newCtc - r.currentCtc) * 12, false, true),
  ]);

  const sumCurBasic = hotel.rows.reduce((s, r) => s + r.currentBasic, 0);
  const sumNewBasic = hotel.rows.reduce((s, r) => s + r.newBasic, 0);
  const sumCurCtc   = hotel.rows.reduce((s, r) => s + r.currentCtc, 0);
  const sumNewCtc   = hotel.rows.reduce((s, r) => s + r.newCtc, 0);

  const totRow = [
    tot(`Total  (${hotel.rows.length} employees)`, false),
    tot('', false), tot('', false), tot('', false), tot('', false),
    tot(sumCurBasic), tot('', false), tot('', false),
    tot(sumNewBasic),
    tot(sumNewBasic - sumCurBasic),
    tot(sumCurCtc),
    tot(sumNewCtc),
    tot(sumNewCtc - sumCurCtc),
    tot((sumNewCtc - sumCurCtc) * 12),
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows, totRow]);

  ws['!cols'] = [
    { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 16 },
    { wch: 16 }, { wch: 10 }, { wch: 12 },
    { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 16 },
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

// ── Summary sheet ─────────────────────────────────────────────────────────────

function buildSummarySheet(hotels: ExportHotel[], XLSX: any): any {
  const headers = [
    hdr('Hotel'), hdr('Short Code'), hdr('Currency'), hdr('Headcount'),
    hdr('Current Basic'), hdr('New Basic'), hdr('Monthly Increase'), hdr('Annual Increase'),
    hdr('Current CTC'), hdr('New CTC'), hdr('Monthly CTC Δ'), hdr('Annual CTC Δ'), hdr('% Change'),
  ];

  let totHC = 0, totCurBasic = 0, totNewBasic = 0, totCurCtc = 0, totNewCtc = 0;

  const dataRows = hotels.map(h => {
    const cur  = h.rows.reduce((s, r) => s + r.currentBasic, 0);
    const nw   = h.rows.reduce((s, r) => s + r.newBasic, 0);
    const curC = h.rows.reduce((s, r) => s + r.currentCtc, 0);
    const nwC  = h.rows.reduce((s, r) => s + r.newCtc, 0);
    const pch  = cur > 0 ? (nw - cur) / cur * 100 : 0;
    const bw   = h.country.toLowerCase().includes('botswana');

    totHC       += h.rows.length;
    totCurBasic += cur;  totNewBasic += nw;
    totCurCtc   += curC; totNewCtc   += nwC;

    return [
      str(h.name, true),
      { v: h.shortCode, t: 's', s: { alignment: { horizontal: 'center' } } },
      { v: bw ? 'BWP (P)' : 'ZAR (R)', t: 's', s: { alignment: { horizontal: 'center' } } },
      { v: h.rows.length, t: 'n', s: { alignment: { horizontal: 'center' } } },
      num(cur), num(nw, true), num(nw - cur, false, true), num((nw - cur) * 12, false, true),
      num(curC), num(nwC, true), num(nwC - curC, false, true), num((nwC - curC) * 12, false, true),
      { v: +pch.toFixed(1), t: 'n', z: '0.0"%"', s: { alignment: { horizontal: 'right' }, font: { color: { rgb: GREEN } } } },
    ];
  });

  const pchTot = totCurBasic > 0 ? (totNewBasic - totCurBasic) / totCurBasic * 100 : 0;
  const totRow = [
    tot('Grand Total', false),
    { v: '', t: 's', s: { fill: { patternType: 'solid', fgColor: { rgb: LGRAY } } } },
    { v: 'Mixed', t: 's', s: { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, alignment: { horizontal: 'center' } } },
    { v: totHC, t: 'n', s: { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, alignment: { horizontal: 'center' } } },
    tot(totCurBasic), tot(totNewBasic),
    tot(totNewBasic - totCurBasic), tot((totNewBasic - totCurBasic) * 12),
    tot(totCurCtc), tot(totNewCtc),
    tot(totNewCtc - totCurCtc), tot((totNewCtc - totCurCtc) * 12),
    { v: +pchTot.toFixed(1), t: 'n', z: '0.0"%"', s: { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, alignment: { horizontal: 'right' } } },
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows, totRow]);
  ws['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 18 },
    { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 10 },
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

// ── Public export function ────────────────────────────────────────────────────

export async function exportSalaryReview(
  hotels: ExportHotel[],
  filename: string,
): Promise<void> {
  // Dynamic import keeps xlsx-js-style out of the SSR bundle
  const XLSX = (await import('xlsx-js-style')).default ?? (await import('xlsx-js-style'));

  const wb = XLSX.utils.book_new();

  // Summary sheet first
  XLSX.utils.book_append_sheet(wb, buildSummarySheet(hotels, XLSX), 'Summary');

  // One sheet per hotel (only hotels with rows)
  for (const h of hotels) {
    if (h.rows.length === 0) continue;
    // Sheet names: max 31 chars, no special chars
    const name = (h.shortCode || h.name).replace(/[:\\/?\*\[\]]/g, '').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, buildHotelSheet(h, XLSX), name);
  }

  XLSX.writeFile(wb, filename);
}
