'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Hotel } from '@/types/database';
import { isBotswana } from '@/lib/payroll-calc';
import { Save, Shield } from 'lucide-react';

export default function SettingsPage() {
  const sb = createClient();
  const [hotels, setHotels] = useState<Hotel[]>([]);
  // Store WCA as percentage in UI (e.g. 0.50 = 0.50%), convert to decimal on save
  const [wca, setWca] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    sb.from('hotels').select('*').order('name').then(({ data }) => {
      const h = (data ?? []) as Hotel[];
      setHotels(h);
      setWca(Object.fromEntries(h.map(hotel => [hotel.id, ((hotel.wca_rate ?? 0) * 100).toFixed(4)])));
    });
  }, []);

  async function save() {
    setSaving(true);
    await Promise.all(
      hotels.map(h =>
        sb.from('hotels')
          .update({ wca_rate: parseFloat(wca[h.id] || '0') / 100 })
          .eq('id', h.id)
      )
    );
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  const saHotels = hotels.filter(h => !isBotswana(h.country));
  const bwHotels = hotels.filter(h => isBotswana(h.country));

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Payroll Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure statutory rates per hotel. Botswana entities are exempt from UIF, SDL, and WCA.
        </p>
      </div>

      {/* Fixed rates info */}
      <div className="bg-muted/40 rounded-xl border p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Fixed Rates (applied to all hotels)</h2>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <div className="flex justify-between border-b pb-2">
            <dt className="text-muted-foreground">Provident Fund (EE + ER)</dt>
            <dd className="font-mono font-medium">7.00% of Basic</dd>
          </div>
          <div className="flex justify-between border-b pb-2">
            <dt className="text-muted-foreground">UIF (EE + ER)</dt>
            <dd className="font-mono font-medium">1.00% of Basic, cap R177.12</dd>
          </div>
          <div className="flex justify-between border-b pb-2">
            <dt className="text-muted-foreground">SDL</dt>
            <dd className="font-mono font-medium">1.00% of Gross</dd>
          </div>
          <div className="flex justify-between border-b pb-2">
            <dt className="text-muted-foreground">Staff Meals — Manager</dt>
            <dd className="font-mono font-medium">R 380.00</dd>
          </div>
          <div className="flex justify-between border-b pb-2">
            <dt className="text-muted-foreground">Staff Meals — Standard</dt>
            <dd className="font-mono font-medium">R 330.00</dd>
          </div>
          <div className="flex justify-between border-b pb-2">
            <dt className="text-muted-foreground">Leave Accrual — SA (24 days)</dt>
            <dd className="font-mono font-medium">Basic × 24/365 = 6.575%</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Leave Accrual — Botswana (21 days)</dt>
            <dd className="font-mono font-medium">Basic × 21/365 = 5.753%</dd>
          </div>
        </dl>
      </div>

      {/* SA hotels — WCA rate input */}
      {saHotels.length > 0 && (
        <div className="bg-white rounded-xl border mb-4">
          <div className="px-6 py-4 border-b">
            <h2 className="text-sm font-semibold">South Africa — WCA Rate</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Assessed annually by the Compensation Fund. Enter as a percentage (e.g. 0.50 for 0.50%).</p>
          </div>
          <div className="divide-y">
            {saHotels.map(hotel => (
              <div key={hotel.id} className="flex items-center gap-4 px-6 py-4">
                <div className="flex-1">
                  <p className="font-medium text-sm">{hotel.name}</p>
                  <p className="text-xs text-muted-foreground">{hotel.short_code}</p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    max="10"
                    value={wca[hotel.id] ?? '0'}
                    onChange={e => setWca(r => ({ ...r, [hotel.id]: e.target.value }))}
                    className="w-24 rounded-md border border-input px-3 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-ring font-mono"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Botswana hotels — exempt */}
      {bwHotels.length > 0 && (
        <div className="bg-white rounded-xl border mb-6 opacity-60">
          <div className="px-6 py-4 border-b">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              Botswana — Exempt from UIF / SDL / WCA
            </h2>
          </div>
          <div className="divide-y">
            {bwHotels.map(hotel => (
              <div key={hotel.id} className="flex items-center gap-4 px-6 py-4">
                <div className="flex-1">
                  <p className="font-medium text-sm">{hotel.name}</p>
                  <p className="text-xs text-muted-foreground">{hotel.short_code} · {hotel.country}</p>
                </div>
                <span className="text-xs text-muted-foreground italic">No UIF · No SDL · No WCA</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={save}
        disabled={saving}
        className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        <Save className="h-4 w-4" />
        {saved ? 'Saved!' : saving ? 'Saving…' : 'Save Rates'}
      </button>
    </div>
  );
}
