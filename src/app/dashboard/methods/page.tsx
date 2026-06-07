'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Hotel, Employee, SalaryRecord } from '@/types/database';
import { calculateBurden, isBotswana } from '@/lib/payroll-calc';
import { RefreshCw, CheckCircle } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

type HotelConfig = {
  providentEeRate: string;
  providentErRate: string;
  providentErRateSenior: string;
  uifRate: string;
  uifCap: string;
  sdlRate: string;
  wcaRate: string;
  mealsStandard: string;
  mealsManager: string;
  leaveDays: string;
  bonusDays: string;
  ctcProvidentEr: boolean;
  ctcUifEr: boolean;
  ctcSdl: boolean;
  ctcWca: boolean;
  ctcMeals: boolean;
  ctcLeaveAccrual: boolean;
  ctcBonus: boolean;
};

function fmtRate(decimal: number): string {
  return (decimal * 100).toFixed(2);
}

function hotelToConfig(h: Hotel): HotelConfig {
  const bw = isBotswana(h.country);
  return {
    providentEeRate:       fmtRate(h.provident_ee_rate        ?? (bw ? 0.05  : 0.07)),
    providentErRate:       fmtRate(h.provident_er_rate        ?? (bw ? 0.045 : 0.07)),
    providentErRateSenior: fmtRate(h.provident_er_rate_senior ?? (bw ? 0.09  : 0.07)),
    uifRate:               fmtRate(h.uif_rate                 ?? 0.01),
    uifCap:                String(h.uif_cap                   ?? 177.12),
    sdlRate:               fmtRate(h.sdl_rate                 ?? 0.01),
    wcaRate:               fmtRate(h.wca_rate                 ?? 0),
    mealsStandard:         String(h.meals_standard            ?? 330),
    mealsManager:          String(h.meals_manager             ?? 380),
    leaveDays:             String(h.leave_days                ?? (bw ? 21 : 24)),
    bonusDays:             String(h.bonus_days                ?? (bw ? 26 : 30.42)),
    ctcProvidentEr:        h.ctc_provident_er  ?? true,
    ctcUifEr:              h.ctc_uif_er        ?? true,
    ctcSdl:                h.ctc_sdl           ?? true,
    ctcWca:                h.ctc_wca           ?? true,
    ctcMeals:              h.ctc_meals         ?? false,
    ctcLeaveAccrual:       h.ctc_leave_accrual ?? false,
    ctcBonus:              h.ctc_bonus         ?? false,
  };
}

function yearsOfService(date: string | null): number {
  if (!date) return 0;
  const ms = Date.now() - new Date(date).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25) * 10) / 10;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function MethodsPage() {
  const sb = createClient();
  const [hotels,   setHotels]   = useState<Hotel[]>([]);
  const [configs,  setConfigs]  = useState<Map<string, HotelConfig>>(new Map());
  const [selected, setSelected] = useState('');
  const [saving,   setSaving]   = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [done,     setDone]     = useState<number | null>(null);

  useEffect(() => {
    sb.from('hotels').select('*').order('name').then(({ data }) => {
      const list = (data ?? []) as Hotel[];
      setHotels(list);
      setConfigs(new Map(list.map(h => [h.id, hotelToConfig(h)])));
      if (list.length) setSelected(list[0].id);
    });
  }, []);

  const hotel = hotels.find(h => h.id === selected);
  const cfg   = configs.get(selected);
  const bw    = hotel ? isBotswana(hotel.country) : false;

  function patch<K extends keyof HotelConfig>(key: K, val: HotelConfig[K]) {
    setConfigs(prev => {
      const next = new Map(prev);
      const cur  = next.get(selected);
      if (cur) next.set(selected, { ...cur, [key]: val });
      return next;
    });
  }

  async function handleSaveUpdate() {
    if (!hotel || !cfg) return;
    setSaving(true);
    setDone(null);
    setProgress('Saving rates…');

    const pct = (s: string) => parseFloat(s) / 100;

    await sb.from('hotels').update({
      provident_ee_rate:        pct(cfg.providentEeRate),
      provident_er_rate:        pct(cfg.providentErRate),
      provident_er_rate_senior: pct(cfg.providentErRateSenior),
      uif_rate:                 pct(cfg.uifRate),
      uif_cap:                  parseFloat(cfg.uifCap),
      sdl_rate:                 pct(cfg.sdlRate),
      wca_rate:                 pct(cfg.wcaRate),
      meals_standard:           parseFloat(cfg.mealsStandard),
      meals_manager:            parseFloat(cfg.mealsManager),
      leave_days:               parseFloat(cfg.leaveDays),
      bonus_days:               parseFloat(cfg.bonusDays),
      ctc_provident_er:         cfg.ctcProvidentEr,
      ctc_uif_er:               cfg.ctcUifEr,
      ctc_sdl:                  cfg.ctcSdl,
      ctc_wca:                  cfg.ctcWca,
      ctc_meals:                cfg.ctcMeals,
      ctc_leave_accrual:        cfg.ctcLeaveAccrual,
      ctc_bonus:                cfg.ctcBonus,
    }).eq('id', hotel.id);

    // Load active employees for this hotel
    setProgress('Loading employees…');
    const { data: empData } = await sb
      .from('employees').select('*')
      .eq('hotel_id', hotel.id).eq('status', 'active');
    const employees = (empData ?? []) as Employee[];

    if (!employees.length) {
      setSaving(false);
      setProgress(null);
      setDone(0);
      setTimeout(() => setDone(null), 3000);
      return;
    }

    const empIds = employees.map(e => e.id);
    const { data: salData } = await sb.from('salary_records').select('*').in('employee_id', empIds);
    const salList = (salData ?? []) as SalaryRecord[];

    // Latest salary record per employee
    const latestSalary = new Map<string, SalaryRecord>();
    for (const sal of salList) {
      const ex = latestSalary.get(sal.employee_id);
      if (!ex || sal.period_year > ex.period_year ||
        (sal.period_year === ex.period_year && sal.period_month > ex.period_month)) {
        latestSalary.set(sal.employee_id, sal);
      }
    }

    setProgress(`Updating ${employees.length} employees…`);

    const methodRates = {
      providentEeRate:       pct(cfg.providentEeRate),
      providentErRate:       pct(cfg.providentErRate),
      providentErRateSenior: pct(cfg.providentErRateSenior),
      uifRate:               pct(cfg.uifRate),
      uifCap:                parseFloat(cfg.uifCap),
      sdlRate:               pct(cfg.sdlRate),
      mealsStandard:         parseFloat(cfg.mealsStandard),
      mealsManager:          parseFloat(cfg.mealsManager),
      leaveDays:             parseFloat(cfg.leaveDays),
      bonusDays:             parseFloat(cfg.bonusDays),
      ctcProvidentEr:        cfg.ctcProvidentEr,
      ctcUifEr:              cfg.ctcUifEr,
      ctcSdl:                cfg.ctcSdl,
      ctcWca:                cfg.ctcWca,
      ctcMeals:              cfg.ctcMeals,
      ctcLeaveAccrual:       cfg.ctcLeaveAccrual,
      ctcBonus:              cfg.ctcBonus,
    };

    let updated = 0;
    await Promise.all(employees.map(async emp => {
      const sal = latestSalary.get(emp.id);
      if (!sal) return;

      const burden = calculateBurden({
        basic:               sal.basic_salary,
        totalEarnings:       sal.total_earnings,
        jobTitle:            emp.job_title,
        country:             hotel.country,
        wcaRate:             pct(cfg.wcaRate),
        hotelShortCode:      hotel.short_code,
        yearsOfService:      yearsOfService(emp.employment_date),
        severanceApplicable: emp.severance_applicable,
        incentiveApplicable: emp.incentive_applicable,
        incentiveMultiplier: emp.incentive_multiplier,
        gratuityApplicable:  emp.gratuity_applicable,
        gratuityRate:        emp.gratuity_rate,
        taxPaye:             sal.tax_paye,
        medicalEmployee:     sal.medical_employee,
        medicalCompany:      sal.medical_company,
        ancillaEmployee:     sal.ancilla_employee,
        ancillaCompany:      sal.ancilla_company,
        leaveProvision:      sal.leave_provision,
        otherCompanyContrib: sal.other_company_contrib,
        mgmtIncentive:       sal.mgmt_incentive,
        bonusAccrualDec:     sal.bonus_accrual_dec,
        bonusAccrualJuly:    sal.bonus_accrual_july,
        ...methodRates,
      });

      await sb.from('salary_records').update({
        provident_employee:    burden.provident_employee,
        uif_employee:          burden.uif_employee,
        total_deductions:      burden.total_deductions,
        net_salary:            burden.net_salary,
        provident_company:     burden.provident_company,
        uif_company:           burden.uif_company,
        sdl_company:           burden.sdl_company,
        wca_company:           burden.wca_company,
        staff_meals:           burden.staff_meals,
        bonus_provision:       burden.bonus_provision,
        leave_days:            burden.leave_days,
        leave_accrual:         burden.leave_accrual,
        severance:             burden.severance,
        incentive:             burden.incentive,
        gratuity:              burden.gratuity,
        total_company_contrib: burden.total_company_contrib,
        total_payroll_burden:  burden.total_payroll_burden,
        total_cost:            burden.total_cost,
        ctc:                   burden.ctc,
      }).eq('id', sal.id);

      updated++;
    }));

    setSaving(false);
    setProgress(null);
    setDone(updated);
    setTimeout(() => setDone(null), 4000);
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  const inputCls = 'w-20 rounded border border-input px-2 py-1 text-right font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring';
  const inputWide = 'w-24 rounded border border-input px-2 py-1 text-right font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring';
  const cbCls = 'h-4 w-4 rounded border-input accent-primary cursor-pointer';
  const exemptBadge = (
    <span className="text-xs text-muted-foreground italic px-2 py-0.5 bg-muted rounded">
      Exempt (Botswana)
    </span>
  );

  function RateCell({ field, disabled }: { field: keyof HotelConfig; disabled?: boolean }) {
    if (disabled || !cfg) return <td className="px-5 py-3 text-muted-foreground">{exemptBadge}</td>;
    return (
      <td className="px-5 py-3">
        <div className="flex items-center gap-1.5">
          <input
            type="number" step="0.01" min="0" max="100"
            value={(cfg[field] as string) ?? ''}
            onChange={e => patch(field, e.target.value as HotelConfig[typeof field])}
            className={inputCls}
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
      </td>
    );
  }

  function CbCell({ field, disabled, note }: { field: keyof HotelConfig; disabled?: boolean; note?: string }) {
    if (disabled || !cfg) return <td className="px-5 py-3 text-center text-muted-foreground text-xs">—</td>;
    if (note) return <td className="px-5 py-3 text-center text-xs text-muted-foreground">{note}</td>;
    return (
      <td className="px-5 py-3 text-center">
        <input
          type="checkbox"
          className={cbCls}
          checked={cfg[field] as boolean}
          onChange={e => patch(field, e.target.checked as HotelConfig[typeof field])}
        />
      </td>
    );
  }

  const thCls = 'text-left px-5 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide';

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-7">
        <h1 className="text-2xl font-bold">Payroll Methods</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure statutory rates, provisions, and CTC inclusions per hotel.
          &ldquo;Save &amp; Update&rdquo; writes the rates and immediately recalculates all active employees.
        </p>
      </div>

      {/* Hotel tabs */}
      <div className="flex gap-1 flex-wrap border-b mb-7">
        {hotels.map(h => (
          <button
            key={h.id}
            onClick={() => setSelected(h.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t-md border-b-2 transition-colors ${
              selected === h.id
                ? 'border-primary text-primary bg-primary/5'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {h.short_code}
            {isBotswana(h.country) && (
              <span className="ml-1.5 text-xs text-muted-foreground font-normal">BWP</span>
            )}
          </button>
        ))}
      </div>

      {cfg && hotel ? (
        <>
          <p className="text-sm font-medium text-muted-foreground mb-5">{hotel.name}</p>

          {/* ── Contributions ───────────────────────────────────────────── */}
          <div className="bg-white rounded-xl border mb-5 overflow-hidden">
            <div className="px-5 py-3 border-b bg-muted/30 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Contributions</h2>
              <span className="text-xs text-muted-foreground">Include in CTC = added to employee&apos;s cost-to-company total</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/10">
                  <th className={`${thCls} w-72`}>Item</th>
                  <th className={thCls}>Rate</th>
                  <th className={`${thCls} w-32 text-center`}>Include in CTC</th>
                </tr>
              </thead>
              <tbody className="divide-y">

                {/* Provident Fund EE */}
                <tr>
                  <td className="px-5 py-3">
                    Provident Fund — Employee
                    <span className="ml-1.5 text-xs text-muted-foreground">× Basic</span>
                  </td>
                  <RateCell field="providentEeRate" />
                  <td className="px-5 py-3 text-center text-xs text-muted-foreground">—</td>
                </tr>

                {/* Provident Fund ER — BW: junior + senior rows; SA: single row */}
                {bw ? (
                  <>
                    <tr>
                      <td className="px-5 py-3">
                        Provident Fund — Company
                        <span className="ml-1.5 text-xs text-muted-foreground">(&lt; 5 yrs service)</span>
                      </td>
                      <RateCell field="providentErRate" />
                      <CbCell field="ctcProvidentEr" />
                    </tr>
                    <tr>
                      <td className="px-5 py-3">
                        Provident Fund — Company
                        <span className="ml-1.5 text-xs text-muted-foreground">(5+ yrs service)</span>
                      </td>
                      <RateCell field="providentErRateSenior" />
                      <CbCell field="ctcProvidentEr" note="(same)" />
                    </tr>
                  </>
                ) : (
                  <tr>
                    <td className="px-5 py-3">
                      Provident Fund — Company
                      <span className="ml-1.5 text-xs text-muted-foreground">× Basic</span>
                    </td>
                    <RateCell field="providentErRate" />
                    <CbCell field="ctcProvidentEr" />
                  </tr>
                )}

                {/* UIF */}
                {bw ? (
                  <tr className="opacity-50 pointer-events-none">
                    <td className="px-5 py-3">UIF — Employee + Company</td>
                    <td className="px-5 py-3">{exemptBadge}</td>
                    <td className="px-5 py-3 text-center text-xs text-muted-foreground">—</td>
                  </tr>
                ) : (
                  <tr>
                    <td className="px-5 py-3">
                      UIF — Employee + Company
                      <span className="ml-1.5 text-xs text-muted-foreground">× Basic</span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number" step="0.01" min="0" max="100"
                            value={cfg.uifRate}
                            onChange={e => patch('uifRate', e.target.value)}
                            className={inputCls}
                          />
                          <span className="text-sm text-muted-foreground">%</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">cap R</span>
                          <input
                            type="number" step="0.01" min="0"
                            value={cfg.uifCap}
                            onChange={e => patch('uifCap', e.target.value)}
                            className={inputWide}
                          />
                        </div>
                      </div>
                    </td>
                    <CbCell field="ctcUifEr" />
                  </tr>
                )}

                {/* SDL */}
                {bw ? (
                  <tr className="opacity-50 pointer-events-none">
                    <td className="px-5 py-3">SDL</td>
                    <td className="px-5 py-3">{exemptBadge}</td>
                    <td className="px-5 py-3 text-center text-xs text-muted-foreground">—</td>
                  </tr>
                ) : (
                  <tr>
                    <td className="px-5 py-3">
                      SDL
                      <span className="ml-1.5 text-xs text-muted-foreground">× Gross</span>
                    </td>
                    <RateCell field="sdlRate" />
                    <CbCell field="ctcSdl" />
                  </tr>
                )}

                {/* WCA */}
                {bw ? (
                  <tr className="opacity-50 pointer-events-none">
                    <td className="px-5 py-3">WCA</td>
                    <td className="px-5 py-3">{exemptBadge}</td>
                    <td className="px-5 py-3 text-center text-xs text-muted-foreground">—</td>
                  </tr>
                ) : (
                  <tr>
                    <td className="px-5 py-3">
                      WCA
                      <span className="ml-1.5 text-xs text-muted-foreground">× Gross</span>
                    </td>
                    <RateCell field="wcaRate" />
                    <CbCell field="ctcWca" />
                  </tr>
                )}

              </tbody>
            </table>
          </div>

          {/* ── Provisions & Accruals ───────────────────────────────────── */}
          <div className="bg-white rounded-xl border mb-7 overflow-hidden">
            <div className="px-5 py-3 border-b bg-muted/30">
              <h2 className="text-sm font-semibold">Provisions &amp; Accruals</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/10">
                  <th className={`${thCls} w-72`}>Item</th>
                  <th className={thCls}>Amount</th>
                  <th className={`${thCls} w-32 text-center`}>Include in CTC</th>
                </tr>
              </thead>
              <tbody className="divide-y">

                <tr>
                  <td className="px-5 py-3">Staff Meals — Standard</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-muted-foreground">{bw ? 'P' : 'R'}</span>
                      <input
                        type="number" step="1" min="0"
                        value={cfg.mealsStandard}
                        onChange={e => patch('mealsStandard', e.target.value)}
                        className={inputWide}
                      />
                    </div>
                  </td>
                  <CbCell field="ctcMeals" />
                </tr>

                <tr>
                  <td className="px-5 py-3">Staff Meals — Manager</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-muted-foreground">{bw ? 'P' : 'R'}</span>
                      <input
                        type="number" step="1" min="0"
                        value={cfg.mealsManager}
                        onChange={e => patch('mealsManager', e.target.value)}
                        className={inputWide}
                      />
                    </div>
                  </td>
                  <CbCell field="ctcMeals" note="(same)" />
                </tr>

                <tr>
                  <td className="px-5 py-3">Leave Accrual</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number" step="1" min="0"
                        value={cfg.leaveDays}
                        onChange={e => patch('leaveDays', e.target.value)}
                        className={inputCls}
                      />
                      <span className="text-sm text-muted-foreground">days / year</span>
                    </div>
                  </td>
                  <CbCell field="ctcLeaveAccrual" />
                </tr>

                <tr>
                  <td className="px-5 py-3">Bonus Provision</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number" step="0.01" min="0"
                        value={cfg.bonusDays}
                        onChange={e => patch('bonusDays', e.target.value)}
                        className={inputCls}
                      />
                      <span className="text-sm text-muted-foreground">days / year</span>
                    </div>
                  </td>
                  <CbCell field="ctcBonus" />
                </tr>

              </tbody>
            </table>
          </div>

          {/* ── Action button ─────────────────────────────────────────────── */}
          <div className="flex items-center gap-4">
            <button
              onClick={handleSaveUpdate}
              disabled={saving}
              className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-5 py-2.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : done !== null ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {saving
                ? (progress ?? 'Working…')
                : done !== null
                ? `Updated ${done} employee${done === 1 ? '' : 's'}`
                : `Save & Update All ${hotel.short_code} Employees`}
            </button>
            {!saving && done === null && (
              <p className="text-xs text-muted-foreground">
                Saves these rates then recalculates payroll burden for all active employees.
                Employees with incentive protocol keep their incentive; bonus provision is not applied.
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}
    </div>
  );
}
