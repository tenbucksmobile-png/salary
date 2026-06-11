// Management report export utilities — Excel and PDF

export interface ReportSheet {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | null>>;
  isTotalsRow?: boolean[];
}

export interface PdfRow {
  cells: Array<string | number | null>;
  isTotals?: boolean;
}

// ── Style constants (match excel-export.ts) ───────────────────────────────────

const NAVY  = '1B3A5C';
const LGRAY = 'E8ECF0';

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

function cell(v: string | number | null, isTotals = false) {
  const totFill = { patternType: 'solid', fgColor: { rgb: LGRAY } };
  const totFont = { bold: true };

  if (v === null || v === undefined || v === '') {
    return {
      v: '—', t: 's',
      s: {
        alignment: { horizontal: 'center' },
        font: { color: { rgb: 'CCCCCC' }, ...(isTotals ? { bold: true } : {}) },
        ...(isTotals ? { fill: totFill } : {}),
      },
    };
  }
  if (typeof v === 'number') {
    return {
      v, t: 'n', z: '#,##0',
      s: {
        alignment: { horizontal: 'right' },
        ...(isTotals ? { font: totFont, fill: totFill } : {}),
      },
    };
  }
  return {
    v, t: 's',
    s: {
      alignment: { horizontal: 'left' },
      ...(isTotals ? { font: totFont, fill: totFill } : {}),
    },
  };
}

function buildSheet(sheet: ReportSheet, XLSX: any): any {
  const aoa: any[][] = [sheet.headers.map(h => hdr(h))];

  for (let i = 0; i < sheet.rows.length; i++) {
    const row      = sheet.rows[i];
    const isTotals = sheet.isTotalsRow?.[i] ?? false;
    aoa.push(row.map(v => cell(v, isTotals)));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws['!cols'] = sheet.headers.map((h, ci) => {
    const maxData = sheet.rows.slice(0, 100).reduce((m, r) => {
      const v = r[ci];
      return Math.max(m, v === null ? 1 : String(v).length);
    }, 0);
    return { wch: Math.min(Math.max(h.length + 2, maxData + 2), 42) };
  });

  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

export async function exportReport(
  _title: string,
  filename: string,
  sheets: ReportSheet[],
): Promise<void> {
  const XLSX = (await import('xlsx-js-style')).default ?? (await import('xlsx-js-style'));
  const wb   = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws       = buildSheet(sheet, XLSX);
    const safeName = sheet.name.replace(/[:\\/?\*\[\]]/g, '').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  }

  XLSX.writeFile(wb, filename);
}

// ── PDF export via browser print ──────────────────────────────────────────────

export function exportPdf(
  title: string,
  subtitle: string,
  headers: string[],
  rows: PdfRow[],
): void {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const fmtCell = (v: string | number | null) => {
    if (v === null || v === '') return '—';
    if (typeof v === 'number') return v.toLocaleString('en-ZA');
    return esc(String(v));
  };

  const thead = `<tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>`;
  const tbody = rows.map(r => {
    const cls = r.isTotals ? ' class="totals"' : '';
    const tds = r.cells.map((c, i) => {
      const isNum = typeof c === 'number';
      return `<td${isNum ? ' class="num"' : ''}>${fmtCell(c)}</td>`;
    }).join('');
    return `<tr${cls}>${tds}</tr>`;
  }).join('');

  const date = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#111;padding:14px}
h1{font-size:14px;font-weight:700;color:#1B3A5C;margin-bottom:2px}
p.sub{font-size:9px;color:#666;margin-bottom:10px}
p.gen{font-size:8px;color:#999;margin-top:10px}
table{border-collapse:collapse;width:100%}
th{background:#1B3A5C;color:#fff;font-size:9px;font-weight:700;padding:5px 7px;text-align:left;white-space:nowrap}
td{padding:3px 7px;border-bottom:1px solid #e5e7eb;vertical-align:top;white-space:nowrap}
td.num{text-align:right}
tr.totals td{background:#E8ECF0;font-weight:700}
tr:nth-child(even):not(.totals) td{background:#f8fafc}
@media print{body{padding:0}@page{size:A4 landscape;margin:1.2cm 1.4cm}}
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="sub">${esc(subtitle)}</p>
<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
<p class="gen">Generated ${esc(date)} · IHG Salary Manager</p>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=1100,height=750');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 600);
}
