'use client';

import { useState, useEffect } from 'react';
import { Hotel } from '@/types/database';
import { sortHotels } from '@/lib/utils';
import { Save, CheckCircle } from 'lucide-react';

const currentYear = new Date().getFullYear();
// Last 5 completed years + current year (e.g. 2021-2026 when currentYear is 2026)
const YEARS = Array.from({ length: 6 }, (_, i) => String(currentYear - 5 + i));
// Historic Salary Increases table shows the same span as YEARS, including the
// current in-progress year — Salary Review commits write into it mid-year.
const HISTORIC_YEARS = YEARS;

const DEFAULT_CPI: Record<string, Record<string, string>> = {
  'South Africa': { '2021': '4.5', '2022': '6.9', '2023': '5.9', '2024': '4.4', '2025': '3.2' },
  'Botswana':     { '2021': '8.7', '2022': '12.2', '2023': '10.0', '2024': '5.2', '2025': '4.1' },
};

type CpiData = Record<string, Record<string, string>>;
type NmwData = Record<string, string>; // year → NMW value (user-defined unit: hourly or monthly)

// threshold/belowPct/belowFlat are optional — when threshold is set, pct/flat
// become the "≥ threshold" (above) band and belowPct/belowFlat the "< threshold" band.
// Mirrors the two-tier structure used by the Salary Review Saved Increases table.
export interface IncreaseEntry {
  pct: string;
  flat: string;
  threshold?: string;
  belowPct?: string;
  belowFlat?: string;
}
type IncreaseData = Record<string, Record<string, IncreaseEntry>>;
type IncreaseField = 'pct' | 'flat' | 'threshold' | 'belowPct' | 'belowFlat';

function hasThreshold(entry: IncreaseEntry | undefined): boolean {
  const t = parseFloat(entry?.threshold ?? '');
  return !isNaN(t) && t !== 0;
}

// Number of stacked input rows a year cell renders before the NMW/Union row:
// pct + flat + threshold always (3), plus belowPct + belowFlat when a threshold is set (5).
function entryRowCount(entry: IncreaseEntry | undefined): number {
  return hasThreshold(entry) ? 5 : 3;
}

// Invisible row matching the height of a real input row — used to pad shorter
// cells up to a shared height so the NMW/Union row lands on the same line across
// every year column, and to pad the hotel-name cell so its labels line up too.
function SpacerRow() {
  return (
    <div className="invisible flex items-center gap-0.5" aria-hidden="true">
      <span className="text-xs">·</span>
      <span className="w-14 px-1.5 py-0.5 text-xs inline-block">·</span>
    </div>
  );
}
type UnionData = Record<string, Record<string, string>>; // hotelId → year → adjustment

const STORAGE_CPI       = 'ihg-salary-cpi';
const STORAGE_INCREASES = 'ihg-salary-increases';
const STORAGE_NOTES     = 'ihg-salary-increase-notes';
const STORAGE_CPI_MONTH = 'ihg-salary-cpi-month';
const STORAGE_NMW       = 'ihg-salary-nmw';
const STORAGE_UNION     = 'ihg-salary-union-adj';

const MONTH_NAMES_SHORT = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// SA hotels that display NMW: not Botswana, not APA
function showNmw(hotel: Hotel): boolean {
  const isBw  = hotel.country?.toLowerCase().includes('botswana');
  const isApa = hotel.short_code === 'APA';
  return !isBw && !isApa;
}

// Chobe Safari Lodge and Nata Lodge negotiate separate union adjustments
function showUnion(hotel: Hotel): boolean {
  return hotel.short_code === 'CSL' || hotel.short_code === 'NL';
}

function loadCpi(): CpiData {
  try {
    const raw = localStorage.getItem(STORAGE_CPI);
    if (raw) return JSON.parse(raw) as CpiData;
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CPI)) as CpiData;
}

function migrateEntry(v: unknown): IncreaseEntry {
  if (v && typeof v === 'object' && 'pct' in v) return v as IncreaseEntry;
  return { pct: typeof v === 'string' ? v : '', flat: '' };
}

function loadIncreases(): IncreaseData {
  try {
    const raw = localStorage.getItem(STORAGE_INCREASES);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const result: IncreaseData = {};
    for (const [hotelId, years] of Object.entries(parsed)) {
      result[hotelId] = {};
      for (const [year, val] of Object.entries(years)) {
        result[hotelId][year] = migrateEntry(val);
      }
    }
    return result;
  } catch {}
  return {};
}

function loadNotes(): string {
  try { return localStorage.getItem(STORAGE_NOTES) ?? ''; } catch { return ''; }
}

function loadCpiMonth(): string {
  try { return localStorage.getItem(STORAGE_CPI_MONTH) ?? 'July'; } catch { return 'July'; }
}

function loadNmw(): NmwData {
  try {
    const raw = localStorage.getItem(STORAGE_NMW);
    if (raw) return JSON.parse(raw) as NmwData;
  } catch {}
  return {};
}

function loadUnion(): UnionData {
  try {
    const raw = localStorage.getItem(STORAGE_UNION);
    if (raw) return JSON.parse(raw) as UnionData;
  } catch {}
  return {};
}

function currencySymbol(hotel: Hotel): string {
  return hotel.country?.toLowerCase().includes('botswana') ? 'P' : 'R';
}

export default function InflationHistoryCard({ hotels }: { hotels: Hotel[] }) {
  const [cpi,       setCpi]       = useState<CpiData>(JSON.parse(JSON.stringify(DEFAULT_CPI)) as CpiData);
  const [increases, setIncreases] = useState<IncreaseData>({});
  const [nmw,       setNmw]       = useState<NmwData>({});
  const [unionAdj,  setUnionAdj]  = useState<UnionData>({});
  const [notes,     setNotes]     = useState('');
  const [cpiMonth,  setCpiMonth]  = useState('July');
  const [saved,     setSaved]     = useState(false);

  useEffect(() => {
    setCpi(loadCpi());
    setIncreases(loadIncreases());
    setNmw(loadNmw());
    setUnionAdj(loadUnion());
    setNotes(loadNotes());
    setCpiMonth(loadCpiMonth());
  }, []);

  function setCpiCell(country: string, year: string, value: string) {
    setCpi(prev => ({ ...prev, [country]: { ...prev[country], [year]: value } }));
  }

  function setIncreaseField(hotelId: string, year: string, field: IncreaseField, value: string) {
    setIncreases(prev => {
      const existing = prev[hotelId]?.[year] ?? { pct: '', flat: '' };
      return {
        ...prev,
        [hotelId]: { ...(prev[hotelId] ?? {}), [year]: { ...existing, [field]: value } },
      };
    });
  }

  function setNmwCell(year: string, value: string) {
    setNmw(prev => ({ ...prev, [year]: value }));
  }

  function setUnionCell(hotelId: string, year: string, value: string) {
    setUnionAdj(prev => ({ ...prev, [hotelId]: { ...prev[hotelId], [year]: value } }));
  }

  function saveAll() {
    try {
      localStorage.setItem(STORAGE_CPI,       JSON.stringify(cpi));
      localStorage.setItem(STORAGE_INCREASES,  JSON.stringify(increases));
      localStorage.setItem(STORAGE_NOTES,      notes);
      localStorage.setItem(STORAGE_CPI_MONTH,  cpiMonth);
      localStorage.setItem(STORAGE_NMW,        JSON.stringify(nmw));
      localStorage.setItem(STORAGE_UNION,      JSON.stringify(unionAdj));
    } catch {}
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  const sortedHotels = sortHotels(hotels);

  return (
    <div className="bg-white rounded-xl border p-6 space-y-6">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
        Inflation &amp; Increase History
      </h2>

      {/* CPI table */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <p className="text-xs font-medium text-muted-foreground">
            CPI — Annual Average % as @
          </p>
          <select
            value={cpiMonth}
            onChange={e => setCpiMonth(e.target.value)}
            className="rounded border border-input px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          >
            {MONTH_NAMES_SHORT.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs w-40">Country</th>
                {YEARS.map(y => (
                  <th key={y} className="text-center px-3 py-2.5 font-medium text-muted-foreground text-xs w-24">{y}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(cpi).map(([country, yearData], i) => (
                <tr key={country} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                  <td className="px-4 py-2 text-xs font-medium">{country}</td>
                  {YEARS.map(y => (
                    <td key={y} className="px-3 py-2">
                      <div className="flex items-center gap-0.5">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={yearData[y] ?? ''}
                          onChange={e => setCpiCell(country, y, e.target.value)}
                          className="w-16 rounded border border-input px-1.5 py-1 text-xs text-right font-mono outline-none focus:ring-1 focus:ring-ring"
                        />
                        <span className="text-xs text-muted-foreground">%</span>
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Historic increases */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Historic Salary Increases — % and / or flat monetary adjustment, with optional threshold band (set a Threshold to split into &ge;/&lt; tiers)
        </p>
        <div className="overflow-x-auto">
          <table className="text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs w-56">Hotel</th>
                {HISTORIC_YEARS.map(y => (
                  <th key={y} className="text-center px-3 py-2.5 font-medium text-muted-foreground text-xs w-36">{y}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedHotels.map((hotel, i) => {
                const sym       = currencySymbol(hotel);
                const hasNmw    = showNmw(hotel);
                const hasUnion  = showUnion(hotel);
                // Row count is uniform per <tr> (tallest cell wins), so size the
                // hotel-name spacer off whichever year cell has the most rows.
                const maxRows     = Math.max(3, ...HISTORIC_YEARS.map(y => entryRowCount(increases[hotel.id]?.[y])));
                const spacerCount = maxRows - 1;
                // Only 3 (no year uses a threshold) or 5 (some year does) are possible —
                // years without a threshold need 2 padding rows to match a threshold year's height.
                const needsPad    = maxRows === 5;
                return (
                  <tr key={hotel.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                    {/* Hotel name cell — NMW/Union labels written once here, aligned via invisible spacer rows */}
                    <td className="px-4 py-2 align-top">
                      <div className="flex flex-col gap-1">
                        {/* Row 1: hotel name — aligns with the top (≥ / %) input row */}
                        <span className="text-xs font-medium">{hotel.name}</span>
                        {hasNmw && <>
                          {Array.from({ length: spacerCount }).map((_, idx) => (
                            <SpacerRow key={`nmw-sp-${idx}`} />
                          ))}
                          {/* NMW label — aligns with the amber NMW input row */}
                          <span className="text-[10px] font-medium text-amber-600">National Minimum Wage</span>
                        </>}
                        {hasUnion && <>
                          {Array.from({ length: spacerCount }).map((_, idx) => (
                            <SpacerRow key={`un-sp-${idx}`} />
                          ))}
                          {/* Union adjustment label — aligns with the blue union input row */}
                          <span className="text-[10px] font-medium text-blue-600">Union Adjustment</span>
                        </>}
                      </div>
                    </td>
                    {HISTORIC_YEARS.map(y => {
                      const entry     = increases[hotel.id]?.[y] ?? { pct: '', flat: '' };
                      const hasThresh = hasThreshold(entry);
                      return (
                        <td key={y} className="px-3 py-2 align-top">
                          <div className="flex flex-col gap-1">
                            {/* % row — "≥ threshold" band once a threshold is set, otherwise the flat rate */}
                            <div className="flex items-center gap-0.5">
                              {hasThresh && <span className="text-[9px] text-green-600 w-2.5">&ge;</span>}
                              <input
                                type="text"
                                inputMode="decimal"
                                value={entry.pct}
                                onChange={e => setIncreaseField(hotel.id, y, 'pct', e.target.value)}
                                className={`w-14 rounded border px-1.5 py-0.5 text-xs text-right font-mono outline-none focus:ring-1 focus:ring-ring ${hasThresh ? 'border-green-200 bg-green-50 text-green-700' : 'border-input'}`}
                                placeholder="—"
                              />
                              <span className="text-xs text-muted-foreground">%</span>
                            </div>
                            {/* Adj row — above-threshold flat adjustment */}
                            <div className="flex items-center gap-0.5">
                              {hasThresh && <span className="w-2.5" />}
                              <span className="text-xs text-muted-foreground">{sym}</span>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={entry.flat}
                                onChange={e => setIncreaseField(hotel.id, y, 'flat', e.target.value)}
                                className={`w-14 rounded border px-1.5 py-0.5 text-xs text-right font-mono outline-none focus:ring-1 focus:ring-ring ${hasThresh ? 'border-green-200 bg-green-50 text-green-700' : 'border-input'}`}
                                placeholder="—"
                              />
                            </div>
                            {/* Below-threshold band — only shown once a threshold is entered */}
                            {hasThresh && <>
                              <div className="flex items-center gap-0.5">
                                <span className="text-[9px] text-muted-foreground w-2.5">&lt;</span>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={entry.belowPct ?? ''}
                                  onChange={e => setIncreaseField(hotel.id, y, 'belowPct', e.target.value)}
                                  className="w-14 rounded border border-input bg-muted/30 px-1.5 py-0.5 text-xs text-right font-mono text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
                                  placeholder="—"
                                />
                                <span className="text-xs text-muted-foreground">%</span>
                              </div>
                              <div className="flex items-center gap-0.5">
                                <span className="w-2.5" />
                                <span className="text-xs text-muted-foreground">{sym}</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={entry.belowFlat ?? ''}
                                  onChange={e => setIncreaseField(hotel.id, y, 'belowFlat', e.target.value)}
                                  className="w-14 rounded border border-input bg-muted/30 px-1.5 py-0.5 text-xs text-right font-mono text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
                                  placeholder="—"
                                />
                              </div>
                            </>}
                            {/* Padding — keeps this cell's height level with sibling years that use a
                                threshold, so the NMW/Union row below lands on the same line for every column */}
                            {!hasThresh && needsPad && <><SpacerRow /><SpacerRow /></>}
                            {/* Threshold input — entering a value here reveals the below-threshold band above */}
                            <div className="flex items-center gap-0.5 mt-0.5 pt-0.5 border-t border-dashed border-input/60">
                              <span className="text-xs text-purple-500">{sym}</span>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={entry.threshold ?? ''}
                                onChange={e => setIncreaseField(hotel.id, y, 'threshold', e.target.value)}
                                className="w-14 rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-xs text-right font-mono text-purple-700 outline-none focus:ring-1 focus:ring-purple-400"
                                placeholder="Thresh"
                              />
                            </div>
                            {/* NMW input — SA hotels only, not APA; label is in the hotel name cell */}
                            {hasNmw && (
                              <input
                                type="text"
                                inputMode="decimal"
                                value={nmw[y] ?? ''}
                                onChange={e => setNmwCell(y, e.target.value)}
                                className="w-14 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs text-right font-mono text-amber-700 outline-none focus:ring-1 focus:ring-amber-400"
                                placeholder="—"
                              />
                            )}
                            {/* Union adjustment input — Chobe Safari Lodge and Nata Lodge only; label is in the hotel name cell */}
                            {hasUnion && (
                              <input
                                type="text"
                                inputMode="numeric"
                                value={unionAdj[hotel.id]?.[y] ?? ''}
                                onChange={e => setUnionCell(hotel.id, y, e.target.value)}
                                className="w-14 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-xs text-right font-mono text-blue-700 outline-none focus:ring-1 focus:ring-blue-400"
                                placeholder="—"
                              />
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Notes + Save */}
      <div className="flex items-end justify-between gap-4 pt-1">
        <div className="flex-1 max-w-md">
          <label className="text-xs font-medium text-muted-foreground block mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="Any notes about increases or CPI context…"
            className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
          />
        </div>
        <button
          onClick={saveAll}
          className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          {saved
            ? <><CheckCircle className="h-4 w-4" /> Saved!</>
            : <><Save className="h-4 w-4" /> Save All</>}
        </button>
      </div>
    </div>
  );
}
