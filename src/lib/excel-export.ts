// Salary review Excel export — one sheet per hotel + an Overview sheet
// Uses xlsx-js-style (SheetJS community + cell-level styling)

// Last 5 completed years + current year — must match InflationHistoryCard.tsx YEARS
const _cy = new Date().getFullYear();
const BENCHMARK_YEARS = Array.from({ length: 6 }, (_, i) => String(_cy - 5 + i));

export interface IncreaseEntry { pct: string; flat: string; }

export interface BenchmarkData {
  cpi: Record<string, Record<string, string>>;              // { 'South Africa': { '2021': '4.5' } }
  increases: Record<string, Record<string, IncreaseEntry>>; // { [hotelId]: { '2021': { pct, flat } } }
  nmw: Record<string, string>;                              // { '2021': '21.69' } — SA NMW per year
  notes: string;
  cpiMonth: string;                                         // e.g. 'July' — month CPI rate was pegged
  hotels: { id: string; name: string }[];                   // sorted hotel list for increases rows
}

export interface ExportHotelRow {
  surname: string;
  firstName: string;
  jobTitle: string;
  grade: string;
  department: string;
  currentGross: number;   // total_earnings — the base on which % increase is applied
  currentBasic: number;   // basic_salary — needed to compute the increase amount
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
  increase?: IncreaseEntry;  // hotel-level configured rate shown in Overview
  rows: ExportHotelRow[];
}

// ── Style constants ───────────────────────────────────────────────────────────

const NAVY   = '1B3A5C';
const LGRAY  = 'E8ECF0';
const GREEN  = '15623A';
const AMBER  = 'FFE082';  // header background for editable columns
const YELLOW = 'FFFDE7';  // cell background for editable input cells

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

// Header for user-editable columns — amber background signals "you can change this"
function hdrEdit(v: string) {
  return {
    v, t: 's',
    s: {
      font:      { bold: true, color: { rgb: '5C3A00' } },
      fill:      { patternType: 'solid', fgColor: { rgb: AMBER } },
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

// Editable input cell — yellow background, same number format as num/pctNum
function inp(v: number, isPct = false) {
  return {
    v: isPct ? +(v * 100).toFixed(1) : (v || 0),
    t: 'n',
    z: isPct ? '0.0"%"' : '#,##0',
    s: {
      alignment: { horizontal: 'right' },
      fill: { patternType: 'solid', fgColor: { rgb: YELLOW } },
      font: { color: { rgb: isPct ? GREEN : '000000' } },
    },
  };
}

// Formula cell — value computed by Excel when opened
function fml(formula: string, bold = false, green = false) {
  return {
    f: formula, t: 'n', z: '#,##0',
    s: {
      alignment: { horizontal: 'right' },
      ...(bold  ? { font: { bold: true } } : {}),
      ...(green ? { font: { color: { rgb: GREEN } } } : {}),
    },
  };
}

// Formula cell in the totals row
function totFml(formula: string, green = false) {
  return {
    f: formula, t: 'n', z: '#,##0',
    s: {
      fill:      { patternType: 'solid', fgColor: { rgb: LGRAY } },
      font:      { bold: true, ...(green ? { color: { rgb: GREEN } } : {}) },
      alignment: { horizontal: 'right' },
    },
  };
}

// Formula cell in the Overview summary data rows (normal weight, no fill)
function fmlOv(formula: string, bold = false, green = false) {
  return {
    f: formula, t: 'n', z: '#,##0',
    s: {
      alignment: { horizontal: 'right' },
      ...(bold  ? { font: { bold: true } } : {}),
      ...(green ? { font: { color: { rgb: GREEN } } } : {}),
    },
  };
}

function tot(v: number | string, isNum = true) {
  const base = { fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, font: { bold: true } };
  if (isNum) return { v: v as number, t: 'n', z: '#,##0', s: { ...base, alignment: { horizontal: 'right' } } };
  return { v: v as string, t: 's', s: { ...base, alignment: { horizontal: 'left' } } };
}

// Benchmark section helpers (CPI + historic increases block)
const LBLUE = 'EEF2F7';
const DBLUE = '2C4A6E';

function sectionHdr(v: string) {
  return {
    v, t: 's',
    s: {
      font:      { bold: true, sz: 11, color: { rgb: DBLUE } },
      fill:      { patternType: 'solid', fgColor: { rgb: LBLUE } },
      alignment: { horizontal: 'left', vertical: 'center' },
    },
  };
}

function hdrSm(v: string) {
  return {
    v, t: 's',
    s: {
      font:      { bold: true, color: { rgb: '444444' } },
      fill:      { patternType: 'solid', fgColor: { rgb: 'F0F4F8' } },
      alignment: { horizontal: 'center' },
      border:    { bottom: { style: 'thin', color: { rgb: 'CCCCCC' } } },
    },
  };
}

function bmark(v: string | undefined) {
  const n = parseFloat(v ?? '');
  if (isNaN(n)) {
    return { v: '—', t: 's', s: { alignment: { horizontal: 'center' }, font: { color: { rgb: 'BBBBBB' } } } };
  }
  return { v: +n.toFixed(1), t: 'n', z: '0.0"%"', s: { alignment: { horizontal: 'center' } } };
}

function incCell(entry: IncreaseEntry | undefined) {
  if (!entry) return { v: '—', t: 's', s: { alignment: { horizontal: 'center' }, font: { color: { rgb: 'BBBBBB' } } } };
  const pct  = parseFloat(entry.pct);
  const flat = parseFloat(entry.flat);
  const hasPct  = !isNaN(pct)  && pct  !== 0;
  const hasFlat = !isNaN(flat) && flat !== 0;
  if (!hasPct && !hasFlat) {
    return { v: '—', t: 's', s: { alignment: { horizontal: 'center' }, font: { color: { rgb: 'BBBBBB' } } } };
  }
  const parts: string[] = [];
  if (hasPct)  parts.push(`${pct.toFixed(1)}%`);
  if (hasFlat) parts.push(flat.toLocaleString('en-ZA', { maximumFractionDigits: 0 }));
  return { v: parts.join(' + '), t: 's', s: { alignment: { horizontal: 'center' } } };
}

// ── Hotel detail sheet ────────────────────────────────────────────────────────

function buildHotelSheet(hotel: ExportHotel, XLSX: any): any {
  const bw  = hotel.country.toLowerCase().includes('botswana');
  const sym = bw ? 'P' : 'R';

  // Column layout (1-indexed):  A-E=names  F=CurGross  G=%Inc  H=FlatAdj
  //   I=NewGross  J=MonthlyInc  K=CurCTC  L=NewCTC  M=MonthlyCtcΔ  N=AnnualCtcΔ
  // Header is row 1; data rows 2…(n+1); totals row (n+2)
  const n = hotel.rows.length;
  const lastData = n + 1;  // last data row (Excel row number)

  const headers = [
    hdr('Surname'), hdr('First Name'), hdr('Job Title'), hdr('Grade'), hdr('Department'),
    hdr(`Current Gross (${sym})`),
    hdrEdit('% Increase'),          // G — user-editable, amber header
    hdrEdit(`Flat Adj (${sym})`),   // H — user-editable, amber header
    hdr(`New Gross (${sym})`), hdr(`Monthly Inc (${sym})`),
    hdr(`Current CTC (${sym})`), hdr(`New CTC (${sym})`),
    hdr(`Monthly CTC Δ (${sym})`), hdr(`Annual CTC Δ (${sym})`),
  ];

  const dataRows = hotel.rows.map((r, i) => {
    const row = i + 2;  // Excel row number for this employee
    return [
      str(r.surname),
      str(r.firstName),
      str(r.jobTitle),
      str(r.grade),
      str(r.department),
      num(r.currentGross),                    // F: Current Gross — static (from DB)
      inp(r.effectivePct, true),              // G: % Increase — yellow, editable
      inp(r.effectiveFlat),                   // H: Flat Adj — yellow, editable
      // I: New Gross — live formula (G stores pct as 6.0, not 0.06 — hence /100)
      fml(`ROUND(F${row}*(1+G${row}/100)+H${row},-1)`, true),
      fml(`I${row}-F${row}`, false, true),    // J: Monthly Inc
      num(r.currentCtc),                      // K: Current CTC — static (burden calc needed)
      num(r.newCtc, true),                    // L: New CTC — static
      fml(`L${row}-K${row}`, false, true),    // M: Monthly CTC Δ
      fml(`(L${row}-K${row})*12`, false, true), // N: Annual CTC Δ
    ];
  });

  const sumCurGross = hotel.rows.reduce((s, r) => s + r.currentGross, 0);
  const sumCurCtc   = hotel.rows.reduce((s, r) => s + r.currentCtc, 0);
  const sumNewCtc   = hotel.rows.reduce((s, r) => s + r.newCtc, 0);

  const totRow = [
    tot(`Total  (${n} employees)`, false),
    tot('', false), tot('', false), tot('', false), tot('', false),
    tot(sumCurGross),                          // F: static — Current Gross doesn't change
    tot('', false),                            // G: blank
    tot('', false),                            // H: blank
    totFml(`SUM(I2:I${lastData})`),            // I: New Gross sum
    totFml(`SUM(J2:J${lastData})`, true),      // J: Monthly Inc sum
    tot(sumCurCtc),                            // K: Current CTC static sum
    tot(sumNewCtc),                            // L: New CTC static sum
    totFml(`SUM(M2:M${lastData})`, true),      // M: Monthly CTC Δ sum
    totFml(`SUM(N2:N${lastData})`, true),      // N: Annual CTC Δ sum
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows, totRow]);

  ws['!cols'] = [
    { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 16 },
    { wch: 16 }, { wch: 10 }, { wch: 12 },
    { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 16 },
  ];
  ws['!freeze']     = { xSplit: 0, ySplit: 1 };
  ws['!autofilter'] = { ref: 'A1:N1' };  // enables filter dropdowns; use col D for Grade
  return ws;
}

// ── Overview sheet (benchmark + summary) ─────────────────────────────────────
//
// Column layout (A–N, 14 cols):
//   A=Hotel  B=ShortCode  C=Currency  D=Headcount  E=Increase%
//   F=CurGross  G=NewGross  H=MonthlyInc  I=AnnualInc
//   J=CurCTC  K=NewCTC  L=MonthlyCtcΔ  M=AnnualCtcΔ  N=%Change
//
// G, H, I, N use cross-sheet formulas pointing at each hotel tab's totals row,
// so edits the user makes in the hotel tabs flow back to the Overview.

function buildSummarySheet(
  hotels: ExportHotel[],
  benchmark: BenchmarkData | null,
  sheetNames: Map<string, string>,
  XLSX: any,
): any {
  // ── Benchmark block ───────────────────────────────────────────────────────
  const benchmarkRows: any[][] = [];

  if (benchmark) {
    const yrs = BENCHMARK_YEARS;

    const cpiTitle = benchmark.cpiMonth
      ? `CPI — Annual Average % as @ ${benchmark.cpiMonth}`
      : 'CPI — Annual Average %';
    benchmarkRows.push([sectionHdr(cpiTitle)]);
    benchmarkRows.push([hdrSm('Country'), ...yrs.map(y => hdrSm(y))]);
    for (const [country, yearData] of Object.entries(benchmark.cpi)) {
      benchmarkRows.push([str(country), ...yrs.map(y => bmark(yearData[y]))]);
    }
    benchmarkRows.push([]);

    benchmarkRows.push([sectionHdr('Historic Salary Increases — % Applied')]);
    benchmarkRows.push([hdrSm('Hotel'), ...yrs.map(y => hdrSm(y))]);
    for (const { id, name } of benchmark.hotels) {
      const inc = benchmark.increases[id] ?? {};
      benchmarkRows.push([str(name), ...yrs.map(y => incCell(inc[y]))]);
    }

    const hasNmw = Object.values(benchmark.nmw ?? {}).some(v => v && v.trim());
    if (hasNmw) {
      const NMW_AMBER = 'FFF3CD';
      const nmwLabel = {
        v: 'NMW (SA)', t: 's',
        s: { font: { bold: true, color: { rgb: '92610A' } }, fill: { patternType: 'solid', fgColor: { rgb: NMW_AMBER } }, alignment: { horizontal: 'left' } },
      };
      const nmwCells = yrs.map(y => {
        const v = benchmark.nmw[y];
        const n = parseFloat(v ?? '');
        if (isNaN(n)) return { v: '—', t: 's', s: { alignment: { horizontal: 'center' }, fill: { patternType: 'solid', fgColor: { rgb: NMW_AMBER } }, font: { color: { rgb: 'BBBBBB' } } } };
        return { v: +n.toFixed(2), t: 'n', z: '#,##0.00', s: { alignment: { horizontal: 'center' }, fill: { patternType: 'solid', fgColor: { rgb: NMW_AMBER } }, font: { color: { rgb: '92610A' } } } };
      });
      benchmarkRows.push([nmwLabel, ...nmwCells]);
    }

    benchmarkRows.push([]);

    if (benchmark.notes.trim()) {
      benchmarkRows.push([
        { v: 'Notes:', t: 's', s: { font: { bold: true } } },
        { v: benchmark.notes, t: 's', s: { alignment: { horizontal: 'left', wrapText: true } } },
      ]);
      benchmarkRows.push([]);
    }

    benchmarkRows.push([sectionHdr('Salary Review Summary')]);
    benchmarkRows.push([]);
  }

  // ── Row-number arithmetic (1-indexed) ─────────────────────────────────────
  // benchmarkRows occupy rows 1…benchmarkRows.length
  // summary header = benchmarkRows.length + 1
  // first hotel data row = benchmarkRows.length + 2
  const firstDataRow = benchmarkRows.length + 2;
  const lastDataRow  = firstDataRow + hotels.length - 1;
  const grandTotRow  = lastDataRow + 1;

  // ── Summary table ─────────────────────────────────────────────────────────
  const headers = [
    hdr('Hotel'), hdr('Short Code'), hdr('Currency'), hdr('Headcount'),
    hdr('Increase %'),                                              // E — configured rate
    hdr('Current Gross'), hdr('New Gross'),                        // F, G
    hdr('Monthly Increase'), hdr('Annual Increase'),               // H, I
    hdr('Current CTC'), hdr('New CTC'),                            // J, K
    hdr('Monthly CTC Δ'), hdr('Annual CTC Δ'),                     // L, M
    hdr('% Change'),                                                // N
  ];

  let totHC = 0, totCurGross = 0, totCurCtc = 0, totNewCtc = 0;

  const dataRows = hotels.map((h, idx) => {
    const overviewRow = firstDataRow + idx;  // this hotel's row number in Overview
    const sheetName   = sheetNames.get(h.id);
    const hotelTotRow = h.rows.length + 2;   // totals row in the hotel sheet
    const hasSheet    = h.rows.length > 0 && !!sheetName;

    const cur  = h.rows.reduce((s, r) => s + r.currentGross, 0);
    const curC = h.rows.reduce((s, r) => s + r.currentCtc, 0);
    const nwC  = h.rows.reduce((s, r) => s + r.newCtc, 0);
    const bw   = h.country.toLowerCase().includes('botswana');

    totHC       += h.rows.length;
    totCurGross += cur;
    totCurCtc   += curC;
    totNewCtc   += nwC;

    // G: New Gross — cross-sheet from hotel totals col I, or static fallback
    const newGrossCell = hasSheet
      ? fmlOv(`'${sheetName}'!I${hotelTotRow}`, true)
      : num(h.rows.reduce((s, r) => s + r.currentGross + (r.newBasic - r.currentBasic), 0), true);

    // H: Monthly Inc — cross-sheet from hotel totals col J
    const monthlyIncCell = hasSheet
      ? fmlOv(`'${sheetName}'!J${hotelTotRow}`, false, true)
      : num(h.rows.reduce((s, r) => s + (r.newBasic - r.currentBasic), 0), false, true);

    // I: Annual Inc — hotel J totals × 12
    const annualIncCell = hasSheet
      ? fmlOv(`'${sheetName}'!J${hotelTotRow}*12`, false, true)
      : num(h.rows.reduce((s, r) => s + (r.newBasic - r.currentBasic) * 12, 0), false, true);

    // N: % Change — computed within Overview so it stays live when G updates
    const pchCell = {
      f: `IFERROR((G${overviewRow}/F${overviewRow}-1)*100,0)`,
      t: 'n', z: '0.0"%"',
      s: { alignment: { horizontal: 'right' }, font: { color: { rgb: GREEN } } },
    };

    return [
      str(h.name, true),                                                          // A
      { v: h.shortCode ?? '', t: 's', s: { alignment: { horizontal: 'center' } } }, // B
      { v: bw ? 'BWP (P)' : 'ZAR (R)', t: 's', s: { alignment: { horizontal: 'center' } } }, // C
      { v: h.rows.length, t: 'n', s: { alignment: { horizontal: 'center' } } },  // D
      incCell(h.increase),     // E: Increase % (configured rate from salary review)
      num(cur),                // F: Current Gross (static — never changes)
      newGrossCell,            // G: New Gross (cross-sheet formula)
      monthlyIncCell,          // H: Monthly Inc (cross-sheet formula)
      annualIncCell,           // I: Annual Inc (cross-sheet formula)
      num(curC),               // J: Current CTC (static)
      num(nwC, true),          // K: New CTC (static)
      num(nwC - curC, false, true),         // L: Monthly CTC Δ (static)
      num((nwC - curC) * 12, false, true),  // M: Annual CTC Δ (static)
      pchCell,                 // N: % Change (formula within Overview)
    ];
  });

  // Grand Total row — SUM formulas for live columns; static for CTC
  const totRow = [
    tot('Grand Total', false),
    { v: '', t: 's', s: { fill: { patternType: 'solid', fgColor: { rgb: LGRAY } } } },
    { v: 'Mixed', t: 's', s: { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, alignment: { horizontal: 'center' } } },
    { v: totHC, t: 'n', s: { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, alignment: { horizontal: 'center' } } },
    tot('', false),                                                           // E: blank
    tot(totCurGross),                                                         // F: static
    totFml(`SUM(G${firstDataRow}:G${lastDataRow})`),                          // G: New Gross
    totFml(`SUM(H${firstDataRow}:H${lastDataRow})`, true),                    // H: Monthly Inc
    totFml(`SUM(I${firstDataRow}:I${lastDataRow})`, true),                    // I: Annual Inc
    tot(totCurCtc),                                                            // J: Cur CTC
    tot(totNewCtc),                                                            // K: New CTC
    tot(totNewCtc - totCurCtc),                                                // L: Monthly CTC Δ
    tot((totNewCtc - totCurCtc) * 12),                                         // M: Annual CTC Δ
    // N: % Change for grand total — uses the G and F values in this same row
    { f: `IFERROR((G${grandTotRow}/F${grandTotRow}-1)*100,0)`, t: 'n', z: '0.0"%"',
      s: { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: LGRAY } }, alignment: { horizontal: 'right' } } },
  ];

  const aoa = [...benchmarkRows, headers, ...dataRows, totRow];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);

  ws['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 },  // A–E
    { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 18 },                 // F–I
    { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 10 },   // J–N
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: benchmarkRows.length + 1 };

  return ws;
}

// ── Public export function ────────────────────────────────────────────────────

export async function exportSalaryReview(
  hotels: ExportHotel[],
  filename: string,
  benchmark?: BenchmarkData | null,
): Promise<void> {
  // Dynamic import keeps xlsx-js-style out of the SSR bundle
  const XLSX = (await import('xlsx-js-style')).default ?? (await import('xlsx-js-style'));

  const wb = XLSX.utils.book_new();

  // Build sheet names first — needed for cross-sheet formula references in Overview.
  // Strip single quotes too so they don't break formula syntax.
  const sheetNames = new Map<string, string>();
  for (const h of hotels) {
    if (h.rows.length === 0) continue;
    const name = (h.shortCode || h.name).replace(/[:\\/?\*\[\]']/g, '').slice(0, 31);
    sheetNames.set(h.id, name);
  }

  // Overview sheet first (benchmark block + summary table with cross-sheet refs)
  XLSX.utils.book_append_sheet(wb, buildSummarySheet(hotels, benchmark ?? null, sheetNames, XLSX), 'Overview');

  // One sheet per hotel (only hotels with rows)
  for (const h of hotels) {
    if (h.rows.length === 0) continue;
    XLSX.utils.book_append_sheet(wb, buildHotelSheet(h, XLSX), sheetNames.get(h.id)!);
  }

  XLSX.writeFile(wb, filename);
}
