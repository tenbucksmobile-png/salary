// Management report Excel export — generic sheet builder, same style as excel-export.ts

export interface ReportSheet {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | null>>;
  isTotalsRow?: boolean[];
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

  // Auto-estimate column widths from headers + first 100 data rows
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
