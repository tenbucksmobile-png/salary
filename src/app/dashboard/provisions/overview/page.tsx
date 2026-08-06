'use client';

import { useState, useEffect } from 'react';
import { fmtCurrency } from '@/lib/utils';
import { loadProvisionsSummary, exportAllProvisions, type ProvisionsSummaryRow } from '@/lib/provisions-export';
import { Download, LayoutList } from 'lucide-react';

export default function ProvisionsOverviewPage() {
  const [rows, setRows] = useState<ProvisionsSummaryRow[]>([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setLoading(true);
    loadProvisionsSummary(year).then(r => {
      setRows(r);
      setLoading(false);
    });
  }, [year]);

  async function handleExport() {
    setExporting(true);
    try {
      await exportAllProvisions(year);
    } finally {
      setExporting(false);
    }
  }

  const fmt = (n: number, hotel: ProvisionsSummaryRow['hotel']) => fmtCurrency(n, hotel.country);

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <LayoutList className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold text-foreground">Provisions Overview</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Combined Leave, Bonus (incl. Incentive) and Severance provisions — Required, On Books and Adjustment per hotel, pulled from each provision page's own Book Adjustment figures. ILG, IH, ILRB and APA only; WCA is not a per-employee provision and is excluded.
        </p>
      </div>

      <div className="flex items-end gap-4 mb-6 flex-wrap">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Year</label>
          <select
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
            className="rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
          >
            {[year, year - 1, year - 2].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exporting…' : 'Export All Provisions'}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border p-10 text-center text-sm text-muted-foreground">
          No provision data for {year}.
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/40">
                <th rowSpan={2} className="text-left px-4 py-3 font-medium text-muted-foreground align-bottom">Hotel</th>
                <th colSpan={3} className="text-center px-4 py-2 font-medium text-muted-foreground border-l">Leave</th>
                <th colSpan={3} className="text-center px-4 py-2 font-medium text-muted-foreground border-l">Bonus</th>
                <th colSpan={3} className="text-center px-4 py-2 font-medium text-muted-foreground border-l">Severance</th>
              </tr>
              <tr className="border-b bg-muted/20 text-xs">
                <th className="text-right px-3 py-2 font-medium text-muted-foreground border-l">Required</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">On Books</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Adjustment</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground border-l">Required</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">On Books</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Adjustment</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground border-l">Required</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">On Books</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Adjustment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ hotel, leave, bonus, severance }, i) => (
                <tr key={hotel.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                  <td className="px-4 py-2.5 font-medium">{hotel.name}</td>
                  {leave ? (
                    <>
                      <td className="px-3 py-2.5 text-right font-mono text-muted-foreground border-l">{fmt(leave.cost, hotel)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{fmt(leave.book, hotel)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-medium ${leave.adjustment === 0 ? 'text-muted-foreground' : leave.adjustment < 0 ? 'text-red-600' : 'text-amber-600'}`}>{fmt(leave.adjustment, hotel)}</td>
                    </>
                  ) : (<><td className="px-3 py-2.5 text-right text-muted-foreground border-l">—</td><td className="px-3 py-2.5 text-right text-muted-foreground">—</td><td className="px-3 py-2.5 text-right text-muted-foreground">—</td></>)}
                  {bonus ? (
                    <>
                      <td className="px-3 py-2.5 text-right font-mono text-muted-foreground border-l">{fmt(bonus.cost, hotel)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{fmt(bonus.book, hotel)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-medium ${bonus.adjustment === 0 ? 'text-muted-foreground' : bonus.adjustment < 0 ? 'text-red-600' : 'text-amber-600'}`}>{fmt(bonus.adjustment, hotel)}</td>
                    </>
                  ) : (<><td className="px-3 py-2.5 text-right text-muted-foreground border-l">—</td><td className="px-3 py-2.5 text-right text-muted-foreground">—</td><td className="px-3 py-2.5 text-right text-muted-foreground">—</td></>)}
                  {severance ? (
                    <>
                      <td className="px-3 py-2.5 text-right font-mono text-muted-foreground border-l">{fmt(severance.cost, hotel)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{fmt(severance.book, hotel)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-medium ${severance.adjustment === 0 ? 'text-muted-foreground' : severance.adjustment < 0 ? 'text-red-600' : 'text-amber-600'}`}>{fmt(severance.adjustment, hotel)}</td>
                    </>
                  ) : (<><td className="px-3 py-2.5 text-right text-muted-foreground border-l">—</td><td className="px-3 py-2.5 text-right text-muted-foreground">—</td><td className="px-3 py-2.5 text-right text-muted-foreground">—</td></>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
