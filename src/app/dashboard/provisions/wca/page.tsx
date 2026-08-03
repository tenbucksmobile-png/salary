'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  Hotel, WcaAnnualConsolidation,
  WcaManualEntry, WcaManualEntryType, WcaManualEntryStatus, WcaRoeRate,
} from '@/types/database';
import { fmtCurrency, sortHotels } from '@/lib/utils';
import { ShieldCheck, Plus, Pencil, Trash2, X } from 'lucide-react';

// WCA reconciliation is being built hotel by hotel — each hotel gets its own
// separate reconciliation (same schema, own data).
const WCA_HOTEL_CODES = ['IH', 'ILRB', 'APA'];

const HOTEL_FILTER_KEY = 'ihg-salary-wca-hotel';
const INPUT_CLS = 'rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white w-full';

type Tab = 'consolidation' | 'reconciliation' | 'roe';

const ENTRY_TYPE_CONFIG: Record<WcaManualEntryType, { label: string; classes: string }> = {
  payment_not_reflected: { label: 'Payment Not Reflected', classes: 'bg-green-100 text-green-700' },
  dispute_raised:        { label: 'Dispute Raised',        classes: 'bg-amber-100 text-amber-700' },
  discrepancy_note:      { label: 'Discrepancy Note',      classes: 'bg-slate-100 text-slate-700' },
};

// Additions increase what's owed; subtractions reduce it.
const ADDITION_KEYS = ['opening_balance', 'provisional_invoice', 'actual_invoice', 'penalty', 'interest', 'other'] as const;
const SUBTRACTION_KEYS = ['reversal', 'payment', 'dispute_credit'] as const;

function netEffect(row: WcaAnnualConsolidation): number {
  const additions = ADDITION_KEYS.reduce((s, k) => s + row[k], 0);
  const subtractions = SUBTRACTION_KEYS.reduce((s, k) => s + row[k], 0);
  return additions - subtractions;
}

function emptyYearForm(hotelId: string, year: number) {
  return {
    id: null as string | null,
    hotel_id: hotelId,
    period_year: year,
    opening_balance: '',
    provisional_invoice: '',
    reversal: '',
    actual_invoice: '',
    penalty: '',
    interest: '',
    payment: '',
    dispute_credit: '',
    other: '',
    notes: '',
  };
}

function emptyEntryForm(hotelId: string) {
  return {
    id: null as string | null,
    hotel_id: hotelId,
    entry_date: new Date().toISOString().slice(0, 10),
    period_year: new Date().getFullYear(),
    entry_type: 'payment_not_reflected' as WcaManualEntryType,
    amount: '',
    status: 'open' as WcaManualEntryStatus,
    description: '',
  };
}

export default function WcaProvisionPage() {
  const sb = createClient();

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [hotelId, setHotelId] = useState('');
  const [tab, setTab] = useState<Tab>('consolidation');
  const [loading, setLoading] = useState(true);

  const [years, setYears] = useState<WcaAnnualConsolidation[]>([]);
  const [entries, setEntries] = useState<WcaManualEntry[]>([]);
  const [roeRates, setRoeRates] = useState<WcaRoeRate[]>([]);

  const [yearForm, setYearForm] = useState<ReturnType<typeof emptyYearForm> | null>(null);
  const [entryForm, setEntryForm] = useState<ReturnType<typeof emptyEntryForm> | null>(null);
  const [roeYearInput, setRoeYearInput] = useState(new Date().getFullYear());
  const [roeRateInput, setRoeRateInput] = useState('');

  async function load() {
    const [{ data: h }, meRes] = await Promise.all([
      sb.from('hotels').select('*'),
      fetch('/api/auth/me').then(r => (r.ok ? r.json() : null)),
    ]);
    const me = meRes as { role: string; hotelIds: string[] | null } | null;
    let hotelList = sortHotels((h ?? []) as Hotel[]).filter(hh => WCA_HOTEL_CODES.includes(hh.short_code));
    if (me?.role === 'sub' && me.hotelIds?.length) {
      hotelList = hotelList.filter(hh => me.hotelIds!.includes(hh.id));
    }
    setHotels(hotelList);
    if (hotelList.length > 0) {
      setHotelId(prev => {
        if (prev && hotelList.some(hh => hh.id === prev)) return prev;
        try {
          const saved = localStorage.getItem(HOTEL_FILTER_KEY);
          if (saved && hotelList.some(hh => hh.id === saved)) return saved;
        } catch {}
        return hotelList[0].id;
      });
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (hotelId) {
      try { localStorage.setItem(HOTEL_FILTER_KEY, hotelId); } catch {}
    }
  }, [hotelId]);

  async function loadHotelData(id: string) {
    const [{ data: y }, { data: e }, { data: r }] = await Promise.all([
      sb.from('wca_annual_consolidation').select('*').eq('hotel_id', id).order('period_year'),
      sb.from('wca_manual_entries').select('*').eq('hotel_id', id).order('entry_date', { ascending: false }),
      sb.from('wca_roe_rates').select('*').eq('hotel_id', id).order('period_year', { ascending: false }),
    ]);
    setYears((y ?? []) as WcaAnnualConsolidation[]);
    setEntries((e ?? []) as WcaManualEntry[]);
    setRoeRates((r ?? []) as WcaRoeRate[]);
  }

  useEffect(() => {
    if (hotelId) loadHotelData(hotelId);
  }, [hotelId]);

  const selectedHotel = hotels.find(h => h.id === hotelId);
  const fmt = (n: number) => fmtCurrency(n, selectedHotel?.country ?? 'South Africa');

  // Running closing balance per year, in period_year order.
  const rowsWithClosing = useMemo(() => {
    const sorted = [...years].sort((a, b) => a.period_year - b.period_year);
    let running = 0;
    return sorted.map(row => {
      running += netEffect(row);
      return { row, closingBalance: running };
    });
  }, [years]);

  const latestClosingBalance = rowsWithClosing.length ? rowsWithClosing[rowsWithClosing.length - 1].closingBalance : 0;

  const summary = useMemo(() => {
    const sum = (k: keyof WcaAnnualConsolidation) => years.reduce((s, r) => s + (r[k] as number), 0);
    return {
      openingBalance: sum('opening_balance'),
      invoiced: sum('provisional_invoice') + sum('actual_invoice') - sum('reversal'),
      penalties: sum('penalty'),
      interest: sum('interest'),
      payments: sum('payment'),
      disputeCredits: sum('dispute_credit'),
      closingBalance: latestClosingBalance,
    };
  }, [years, latestClosingBalance]);

  const reconciliation = useMemo(() => {
    const openPaymentsNotReflected = entries
      .filter(e => e.entry_type === 'payment_not_reflected' && e.status === 'open')
      .reduce((s, e) => s + e.amount, 0);
    const openDisputes = entries
      .filter(e => e.entry_type === 'dispute_raised' && e.status === 'open')
      .reduce((s, e) => s + e.amount, 0);
    const adjustedBalance = summary.closingBalance - openPaymentsNotReflected - openDisputes;
    return { openPaymentsNotReflected, openDisputes, adjustedBalance };
  }, [entries, summary.closingBalance]);

  async function saveYear() {
    if (!yearForm) return;
    const num = (v: string) => parseFloat(v) || 0;
    const payload = {
      hotel_id: yearForm.hotel_id,
      period_year: yearForm.period_year,
      opening_balance: num(yearForm.opening_balance),
      provisional_invoice: num(yearForm.provisional_invoice),
      reversal: num(yearForm.reversal),
      actual_invoice: num(yearForm.actual_invoice),
      penalty: num(yearForm.penalty),
      interest: num(yearForm.interest),
      payment: num(yearForm.payment),
      dispute_credit: num(yearForm.dispute_credit),
      other: num(yearForm.other),
      notes: yearForm.notes || null,
      updated_at: new Date().toISOString(),
    };
    if (yearForm.id) {
      const { data } = await sb.from('wca_annual_consolidation').update(payload).eq('id', yearForm.id).select().single();
      setYears(prev => prev.map(y => (y.id === yearForm.id ? (data as WcaAnnualConsolidation) : y)));
    } else {
      const { data } = await sb
        .from('wca_annual_consolidation')
        .upsert(payload, { onConflict: 'hotel_id,period_year' })
        .select()
        .single();
      setYears(prev => [...prev.filter(y => y.period_year !== yearForm.period_year), data as WcaAnnualConsolidation]);
    }
    setYearForm(null);
  }

  async function deleteYear(id: string) {
    await sb.from('wca_annual_consolidation').delete().eq('id', id);
    setYears(prev => prev.filter(y => y.id !== id));
  }

  async function saveEntry() {
    if (!entryForm) return;
    const payload = {
      hotel_id: entryForm.hotel_id,
      entry_date: entryForm.entry_date,
      period_year: entryForm.period_year || null,
      entry_type: entryForm.entry_type,
      amount: parseFloat(entryForm.amount) || 0,
      status: entryForm.status,
      description: entryForm.description || null,
      updated_at: new Date().toISOString(),
    };
    if (entryForm.id) {
      const { data } = await sb.from('wca_manual_entries').update(payload).eq('id', entryForm.id).select().single();
      setEntries(prev => prev.map(e => (e.id === entryForm.id ? (data as WcaManualEntry) : e)));
    } else {
      const { data } = await sb.from('wca_manual_entries').insert(payload).select().single();
      setEntries(prev => [data as WcaManualEntry, ...prev]);
    }
    setEntryForm(null);
  }

  async function deleteEntry(id: string) {
    await sb.from('wca_manual_entries').delete().eq('id', id);
    setEntries(prev => prev.filter(e => e.id !== id));
  }

  async function toggleEntryStatus(entry: WcaManualEntry) {
    const status: WcaManualEntryStatus = entry.status === 'open' ? 'resolved' : 'open';
    const { data } = await sb.from('wca_manual_entries').update({ status, updated_at: new Date().toISOString() }).eq('id', entry.id).select().single();
    setEntries(prev => prev.map(e => (e.id === entry.id ? (data as WcaManualEntry) : e)));
  }

  async function saveRoeRate() {
    if (!hotelId || !roeRateInput) return;
    const rate = parseFloat(roeRateInput);
    if (isNaN(rate)) return;
    const { data } = await sb
      .from('wca_roe_rates')
      .upsert({ hotel_id: hotelId, period_year: roeYearInput, rate_pct: rate, updated_at: new Date().toISOString() }, { onConflict: 'hotel_id,period_year' })
      .select()
      .single();
    if (data) {
      setRoeRates(prev => [data as WcaRoeRate, ...prev.filter(r => r.period_year !== roeYearInput)].sort((a, b) => b.period_year - a.period_year));
      setRoeRateInput('');
    }
  }

  async function deleteRoeRate(id: string) {
    await sb.from('wca_roe_rates').delete().eq('id', id);
    setRoeRates(prev => prev.filter(r => r.id !== id));
  }

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold text-foreground">WCA Reconciliation</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          One consolidated row per year summarising the Compensation Fund statement of account. Reconciliation captures what the company has done that the Fund hasn't reflected yet — payments not posted, disputes raised, discrepancies. Covers IH, ILRB and APA.
        </p>
      </div>

      {hotels.length === 0 ? (
        <div className="bg-white rounded-xl border p-10 text-center text-sm text-muted-foreground">No hotels available for WCA reconciliation.</div>
      ) : (
        <>
          <div className="flex items-end gap-4 mb-6 flex-wrap">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Hotel</label>
              <select value={hotelId} onChange={e => setHotelId(e.target.value)} className={`${INPUT_CLS} min-w-[220px] w-auto`}>
                {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
            <div className="flex gap-1 border-b flex-1">
              {(['consolidation', 'reconciliation', 'roe'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t === 'consolidation' ? 'Annual Consolidation' : t === 'reconciliation' ? 'Reconciliation' : 'Tourism ROE %'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
            {[
              ['Opening Balance', summary.openingBalance],
              ['Invoiced (net of reversals)', summary.invoiced],
              ['Penalties', summary.penalties],
              ['Interest', summary.interest],
              ['Payments', -summary.payments],
              ['Dispute Credits', -summary.disputeCredits],
              ['Closing Balance', summary.closingBalance],
            ].map(([label, value]) => (
              <div key={label as string} className="bg-white rounded-xl border p-3">
                <div className="text-xs text-muted-foreground mb-1">{label}</div>
                <div className="font-mono text-sm font-medium">{fmt(value as number)}</div>
              </div>
            ))}
          </div>

          {tab === 'consolidation' && (
            <ConsolidationTab
              rowsWithClosing={rowsWithClosing}
              fmt={fmt}
              yearForm={yearForm}
              setYearForm={setYearForm}
              saveYear={saveYear}
              deleteYear={deleteYear}
              hotelId={hotelId}
            />
          )}

          {tab === 'reconciliation' && (
            <ReconciliationTab
              entries={entries}
              fmt={fmt}
              entryForm={entryForm}
              setEntryForm={setEntryForm}
              saveEntry={saveEntry}
              deleteEntry={deleteEntry}
              toggleEntryStatus={toggleEntryStatus}
              reconciliation={reconciliation}
              closingBalance={summary.closingBalance}
              hotelId={hotelId}
            />
          )}

          {tab === 'roe' && (
            <RoeTab
              roeRates={roeRates}
              roeYearInput={roeYearInput}
              setRoeYearInput={setRoeYearInput}
              roeRateInput={roeRateInput}
              setRoeRateInput={setRoeRateInput}
              saveRoeRate={saveRoeRate}
              deleteRoeRate={deleteRoeRate}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Annual Consolidation tab ─────────────────────────────────────────────────

const YEAR_FIELDS: { key: keyof ReturnType<typeof emptyYearForm>; label: string }[] = [
  { key: 'opening_balance', label: 'Opening Balance' },
  { key: 'provisional_invoice', label: 'Provisional Invoice' },
  { key: 'reversal', label: 'Reversal' },
  { key: 'actual_invoice', label: 'Actual Invoice' },
  { key: 'penalty', label: 'Penalty' },
  { key: 'interest', label: 'Interest' },
  { key: 'payment', label: 'Payment' },
  { key: 'dispute_credit', label: 'Dispute Credit' },
  { key: 'other', label: 'Other' },
];

function ConsolidationTab({
  rowsWithClosing, fmt, yearForm, setYearForm, saveYear, deleteYear, hotelId,
}: {
  rowsWithClosing: { row: WcaAnnualConsolidation; closingBalance: number }[];
  fmt: (n: number) => string;
  yearForm: ReturnType<typeof emptyYearForm> | null;
  setYearForm: (f: ReturnType<typeof emptyYearForm> | null) => void;
  saveYear: () => void;
  deleteYear: (id: string) => void;
  hotelId: string;
}) {
  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/40 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Yearly Consolidation</h2>
        {!yearForm && (
          <button
            onClick={() => setYearForm(emptyYearForm(hotelId, (rowsWithClosing[rowsWithClosing.length - 1]?.row.period_year ?? new Date().getFullYear() - 1) + 1))}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add Year
          </button>
        )}
      </div>

      {yearForm && (
        <div className="p-4 border-b bg-muted/10">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
            <Field label="Year">
              <input type="number" value={yearForm.period_year} onChange={e => setYearForm({ ...yearForm, period_year: parseInt(e.target.value) || yearForm.period_year })} className={INPUT_CLS} />
            </Field>
            {YEAR_FIELDS.map(f => (
              <Field key={f.key} label={f.label}>
                <input
                  type="text"
                  inputMode="decimal"
                  value={yearForm[f.key] as string}
                  onChange={e => setYearForm({ ...yearForm, [f.key]: e.target.value })}
                  className={INPUT_CLS}
                />
              </Field>
            ))}
            <Field label="Notes" span2>
              <input type="text" value={yearForm.notes} onChange={e => setYearForm({ ...yearForm, notes: e.target.value })} className={INPUT_CLS} />
            </Field>
          </div>
          <div className="flex gap-2">
            <button onClick={saveYear} className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium">Save</button>
            <button onClick={() => setYearForm(null)} className="rounded-md border px-3 py-2 text-sm"><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      {rowsWithClosing.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">No yearly entries yet. Add each year's consolidated totals from the Compensation Fund statement of account.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Year</th>
                {YEAR_FIELDS.map(f => (
                  <th key={f.key} className="text-right px-4 py-2.5 font-medium text-muted-foreground">{f.label}</th>
                ))}
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Closing Balance</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Notes</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rowsWithClosing.map(({ row, closingBalance }, i) => (
                <tr key={row.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                  <td className="px-4 py-2.5 font-medium">{row.period_year}</td>
                  {YEAR_FIELDS.map(f => (
                    <td key={f.key} className="px-4 py-2.5 text-right font-mono text-muted-foreground">
                      {row[f.key as keyof WcaAnnualConsolidation] ? fmt(row[f.key as keyof WcaAnnualConsolidation] as number) : '—'}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right font-mono font-medium">{fmt(closingBalance)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{row.notes ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setYearForm({
                        id: row.id,
                        hotel_id: row.hotel_id,
                        period_year: row.period_year,
                        opening_balance: row.opening_balance ? String(row.opening_balance) : '',
                        provisional_invoice: row.provisional_invoice ? String(row.provisional_invoice) : '',
                        reversal: row.reversal ? String(row.reversal) : '',
                        actual_invoice: row.actual_invoice ? String(row.actual_invoice) : '',
                        penalty: row.penalty ? String(row.penalty) : '',
                        interest: row.interest ? String(row.interest) : '',
                        payment: row.payment ? String(row.payment) : '',
                        dispute_credit: row.dispute_credit ? String(row.dispute_credit) : '',
                        other: row.other ? String(row.other) : '',
                        notes: row.notes ?? '',
                      })}>
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      </button>
                      <button onClick={() => deleteYear(row.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-600" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Reconciliation tab ──────────────────────────────────────────────────────

function ReconciliationTab({
  entries, fmt, entryForm, setEntryForm, saveEntry, deleteEntry, toggleEntryStatus, reconciliation, closingBalance, hotelId,
}: {
  entries: WcaManualEntry[];
  fmt: (n: number) => string;
  entryForm: ReturnType<typeof emptyEntryForm> | null;
  setEntryForm: (f: ReturnType<typeof emptyEntryForm> | null) => void;
  saveEntry: () => void;
  deleteEntry: (id: string) => void;
  toggleEntryStatus: (e: WcaManualEntry) => void;
  reconciliation: { openPaymentsNotReflected: number; openDisputes: number; adjustedBalance: number };
  closingBalance: number;
  hotelId: string;
}) {
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/40">
          <h2 className="text-sm font-semibold">Adjusted Balance</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Closing Balance less open payments-not-reflected and open disputes = what's believed genuinely owed.</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
          <div><div className="text-xs text-muted-foreground mb-1">Closing Balance</div><div className="font-mono text-sm font-medium">{fmt(closingBalance)}</div></div>
          <div><div className="text-xs text-muted-foreground mb-1">Open Payments Not Reflected</div><div className="font-mono text-sm font-medium text-green-700">−{fmt(reconciliation.openPaymentsNotReflected)}</div></div>
          <div><div className="text-xs text-muted-foreground mb-1">Open Disputes</div><div className="font-mono text-sm font-medium text-amber-700">−{fmt(reconciliation.openDisputes)}</div></div>
          <div><div className="text-xs text-muted-foreground mb-1">Adjusted Balance</div><div className="font-mono text-sm font-bold">{fmt(reconciliation.adjustedBalance)}</div></div>
        </div>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/40 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Company Manual Entries</h2>
          {!entryForm && (
            <button onClick={() => setEntryForm(emptyEntryForm(hotelId))} className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors">
              <Plus className="h-3.5 w-3.5" /> Add Entry
            </button>
          )}
        </div>

        {entryForm && (
          <div className="p-4 border-b bg-muted/10 grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Date">
              <input type="date" value={entryForm.entry_date} onChange={e => setEntryForm({ ...entryForm, entry_date: e.target.value })} className={INPUT_CLS} />
            </Field>
            <Field label="Year">
              <input type="number" value={entryForm.period_year} onChange={e => setEntryForm({ ...entryForm, period_year: parseInt(e.target.value) || entryForm.period_year })} className={INPUT_CLS} />
            </Field>
            <Field label="Type">
              <select value={entryForm.entry_type} onChange={e => setEntryForm({ ...entryForm, entry_type: e.target.value as WcaManualEntryType })} className={INPUT_CLS}>
                {Object.entries(ENTRY_TYPE_CONFIG).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Amount">
              <input type="text" inputMode="decimal" value={entryForm.amount} onChange={e => setEntryForm({ ...entryForm, amount: e.target.value })} className={INPUT_CLS} />
            </Field>
            <Field label="Status">
              <select value={entryForm.status} onChange={e => setEntryForm({ ...entryForm, status: e.target.value as WcaManualEntryStatus })} className={INPUT_CLS}>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
              </select>
            </Field>
            <Field label="Description" span2>
              <input type="text" value={entryForm.description} onChange={e => setEntryForm({ ...entryForm, description: e.target.value })} className={INPUT_CLS} />
            </Field>
            <div className="flex items-end gap-2">
              <button onClick={saveEntry} className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium">Save</button>
              <button onClick={() => setEntryForm(null)} className="rounded-md border px-3 py-2 text-sm"><X className="h-4 w-4" /></button>
            </div>
          </div>
        )}

        {entries.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">No manual entries yet. Add a payment not reflected, a dispute, or a discrepancy note.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/20">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Year</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Type</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Amount</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Description</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                    <td className="px-4 py-2.5">{e.entry_date}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{e.period_year ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${ENTRY_TYPE_CONFIG[e.entry_type].classes}`}>
                        {ENTRY_TYPE_CONFIG[e.entry_type].label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmt(e.amount)}</td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => toggleEntryStatus(e)}
                        className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${e.status === 'open' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}
                      >
                        {e.status === 'open' ? 'Open' : 'Resolved'}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{e.description ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setEntryForm({
                          id: e.id,
                          hotel_id: e.hotel_id,
                          entry_date: e.entry_date,
                          period_year: e.period_year ?? new Date().getFullYear(),
                          entry_type: e.entry_type,
                          amount: String(e.amount),
                          status: e.status,
                          description: e.description ?? '',
                        })}>
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                        </button>
                        <button onClick={() => deleteEntry(e.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-600" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tourism ROE % tab ────────────────────────────────────────────────────────

function RoeTab({
  roeRates, roeYearInput, setRoeYearInput, roeRateInput, setRoeRateInput, saveRoeRate, deleteRoeRate,
}: {
  roeRates: WcaRoeRate[];
  roeYearInput: number;
  setRoeYearInput: (y: number) => void;
  roeRateInput: string;
  setRoeRateInput: (v: string) => void;
  saveRoeRate: () => void;
  deleteRoeRate: (id: string) => void;
}) {
  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/40">
        <h2 className="text-sm font-semibold">Tourism ROE % by Year</h2>
        <p className="text-xs text-muted-foreground mt-0.5">The rate charged against payroll submission per year — used to independently check a year's Actual Invoice.</p>
      </div>
      <div className="p-4 border-b bg-muted/10 flex items-end gap-3">
        <Field label="Year">
          <input type="number" value={roeYearInput} onChange={e => setRoeYearInput(parseInt(e.target.value) || roeYearInput)} className={`${INPUT_CLS} w-28`} />
        </Field>
        <Field label="Rate %">
          <input type="text" inputMode="decimal" value={roeRateInput} onChange={e => setRoeRateInput(e.target.value)} className={`${INPUT_CLS} w-28`} />
        </Field>
        <button onClick={saveRoeRate} className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium">Save</button>
      </div>
      {roeRates.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">No Tourism ROE % rates recorded yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/20">
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Year</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Rate %</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {roeRates.map((r, i) => (
              <tr key={r.id} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                <td className="px-4 py-2.5">{r.period_year}</td>
                <td className="px-4 py-2.5 text-right font-mono">{r.rate_pct}%</td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end">
                    <button onClick={() => deleteRoeRate(r.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-600" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Field({ label, children, span2 }: { label: string; children: React.ReactNode; span2?: boolean }) {
  return (
    <div className={span2 ? 'col-span-2' : ''}>
      <label className="text-xs font-medium text-muted-foreground block mb-1">{label}</label>
      {children}
    </div>
  );
}
