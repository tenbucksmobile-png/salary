import { createClient } from '@/lib/supabase/server';
import { Hotel, SalaryRecord, Employee, PayrollImport, ScenarioLine } from '@/types/database';
import { fmtCurrency, MONTH_NAMES, sortHotels } from '@/lib/utils';
import { Calendar } from 'lucide-react';
import SalarySummaryTable from './SalarySummaryTable';
import InflationHistoryCard from './InflationHistoryCard';

interface GradeStats {
  headcount:    number;
  currentBasic: number;
  currentCtc:   number;
  increaseAdj:  number;
  newBasic:     number;
  newCtc:       number;
}

async function getHotelStats() {
  const sb = await createClient();

  const [{ data: hotels }, { data: employees }, { data: salaries }, { data: imports }] =
    await Promise.all([
      sb.from('hotels').select('*'),
      sb.from('employees').select('*').eq('status', 'active'),
      sb.from('salary_records').select('*'),
      sb.from('payroll_imports').select('*').order('imported_at', { ascending: false }),
    ]);

  const empList = (employees ?? []) as Employee[];
  const salList = (salaries ?? []) as SalaryRecord[];
  const impList = (imports ?? []) as PayrollImport[];

  // Latest salary per employee
  const latestSalary = new Map<string, SalaryRecord>();
  for (const sr of salList) {
    const existing = latestSalary.get(sr.employee_id);
    if (!existing ||
      sr.period_year > existing.period_year ||
      (sr.period_year === existing.period_year && sr.period_month > existing.period_month)) {
      latestSalary.set(sr.employee_id, sr);
    }
  }

  // Load draft scenario lines (same priority as SalarySummaryTable)
  let slMap = new Map<string, ScenarioLine>();
  const { data: draftScenarios } = await sb
    .from('increase_scenarios')
    .select('id')
    .eq('status', 'draft');

  if ((draftScenarios ?? []).length > 0) {
    const ids = draftScenarios!.map(s => s.id);
    const { data: lines } = await sb.from('scenario_lines').select('*').in('scenario_id', ids);
    slMap = new Map((lines ?? []).map(l => [l.employee_id, l as ScenarioLine]));
  } else {
    const { data: latest } = await sb
      .from('increase_scenarios')
      .select('id')
      .in('status', ['approved', 'applied', 'committed'])
      .order('committed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest) {
      const { data: lines } = await sb.from('scenario_lines').select('*').eq('scenario_id', latest.id);
      slMap = new Map((lines ?? []).map(l => [l.employee_id, l as ScenarioLine]));
    }
  }

  const GRADE_ORDER = ['ANO', 'FTC', 'DNQ', 'Frontline', 'Supervisory', 'Management', 'Executive', 'Unclassified'];

  return sortHotels((hotels ?? []) as Hotel[]).map((h: Hotel) => {
    const hotelEmps = empList.filter(e => e.hotel_id === h.id);
    const lastImport = impList.find(i => i.hotel_id === h.id);

    const byGrade: Record<string, GradeStats> = {};

    for (const e of hotelEmps) {
      const sal = latestSalary.get(e.id);
      if (!sal) continue;
      const grade = e.grade_label ?? 'Unclassified';
      if (!byGrade[grade]) byGrade[grade] = { headcount: 0, currentBasic: 0, currentCtc: 0, increaseAdj: 0, newBasic: 0, newCtc: 0 };
      const g = byGrade[grade];
      const sl = slMap.get(e.id);
      g.headcount++;
      if (sl) {
        g.currentBasic += sl.current_basic;
        g.increaseAdj  += sl.increase_amount;
        g.newBasic     += sl.new_basic;
        g.currentCtc   += sl.current_ctc;
        g.newCtc       += sl.new_ctc;
      } else {
        g.currentBasic += sal.basic_salary ?? 0;
        g.newBasic     += sal.basic_salary ?? 0;
        g.currentCtc   += sal.ctc ?? 0;
        g.newCtc       += sal.ctc ?? 0;
      }
    }

    const grades = Object.entries(byGrade).sort(
      ([a], [b]) => (GRADE_ORDER.indexOf(a) === -1 ? 99 : GRADE_ORDER.indexOf(a)) -
                    (GRADE_ORDER.indexOf(b) === -1 ? 99 : GRADE_ORDER.indexOf(b)),
    );

    const totals = grades.reduce(
      (acc, [, g]) => ({
        headcount:    acc.headcount    + g.headcount,
        currentBasic: acc.currentBasic + g.currentBasic,
        currentCtc:   acc.currentCtc   + g.currentCtc,
        increaseAdj:  acc.increaseAdj  + g.increaseAdj,
        newBasic:     acc.newBasic     + g.newBasic,
        newCtc:       acc.newCtc       + g.newCtc,
      }),
      { headcount: 0, currentBasic: 0, currentCtc: 0, increaseAdj: 0, newBasic: 0, newCtc: 0 },
    );

    return {
      hotel:       h,
      last_import: lastImport ? `${MONTH_NAMES[lastImport.period_month - 1]} ${lastImport.period_year}` : null,
      grades,
      totals,
    };
  });
}

export default async function DashboardPage() {
  const stats = await getHotelStats();

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
      </div>

      <SalarySummaryTable />

      <div className="mt-8">
        <InflationHistoryCard hotels={stats.map(s => s.hotel)} />
      </div>

      <div className="grid grid-cols-1 gap-4 mt-8">
        {stats.map(s => (
          <HotelCard key={s.hotel.id} stats={s} />
        ))}
      </div>
    </div>
  );
}

function pct(inc: number, base: number) {
  return base > 0 && inc > 0 ? `${(inc / base * 100).toFixed(1)}%` : '—';
}

function HotelCard({ stats: s }: { stats: Awaited<ReturnType<typeof getHotelStats>>[0] }) {
  const country = s.hotel.country;
  const fmt = (n: number) => fmtCurrency(n, country);

  if (s.grades.length === 0) {
    return (
      <div className="bg-white rounded-xl border p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-base">{s.hotel.name}</h3>
            <span className="text-xs text-muted-foreground">{s.hotel.short_code} · {s.hotel.country}</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {s.last_import ? `Last import: ${s.last_import}` : 'No data imported'}
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">No employee data imported.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      {/* Card header */}
      <div className="flex items-center justify-between px-5 py-4 border-b bg-muted/20">
        <div>
          <h3 className="font-semibold text-base">{s.hotel.name}</h3>
          <span className="text-xs text-muted-foreground">{s.hotel.short_code} · {s.hotel.country}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Calendar className="h-3 w-3" />
          {s.last_import ? `Last import: ${s.last_import}` : 'No data imported'}
        </div>
      </div>

      {/* Grade breakdown table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b bg-muted/10">
              <th className="text-left px-5 py-2.5 font-medium text-muted-foreground text-xs">Grade</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">HC</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">Current Basic</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">Current CTC</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">Increase + Adj</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">New Basic</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">New CTC</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">Annualised CTC</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">%</th>
            </tr>
          </thead>
          <tbody>
            {s.grades.map(([grade, g], i) => (
              <tr key={grade} className={`border-b last:border-0 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                <td className="px-5 py-2.5 text-xs font-medium">{grade}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-xs">{g.headcount}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{g.currentBasic > 0 ? fmt(g.currentBasic) : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{g.currentCtc > 0 ? fmt(g.currentCtc) : '—'}</td>
                <td className={`px-4 py-2.5 text-right font-mono text-xs ${g.increaseAdj > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>
                  {g.increaseAdj > 0 ? `+${fmt(g.increaseAdj)}` : '—'}
                </td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold text-xs">{g.newBasic > 0 ? fmt(g.newBasic) : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold text-xs">{g.newCtc > 0 ? fmt(g.newCtc) : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono text-muted-foreground text-xs">{g.newCtc > 0 ? fmt(g.newCtc * 12) : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{pct(g.increaseAdj, g.currentBasic)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 bg-muted/20 font-semibold">
              <td className="px-5 py-3 text-xs">
                Total
                <span className="ml-1.5 font-normal text-muted-foreground">{s.totals.headcount} employees</span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-xs">{s.totals.headcount}</td>
              <td className="px-4 py-3 text-right font-mono text-xs">{fmt(s.totals.currentBasic)}</td>
              <td className="px-4 py-3 text-right font-mono text-xs">{fmt(s.totals.currentCtc)}</td>
              <td className={`px-4 py-3 text-right font-mono text-xs ${s.totals.increaseAdj > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>
                {s.totals.increaseAdj > 0 ? `+${fmt(s.totals.increaseAdj)}` : '—'}
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs">{fmt(s.totals.newBasic)}</td>
              <td className="px-4 py-3 text-right font-mono text-xs">{fmt(s.totals.newCtc)}</td>
              <td className="px-4 py-3 text-right font-mono text-muted-foreground text-xs">{fmt(s.totals.newCtc * 12)}</td>
              <td className="px-4 py-3 text-right font-mono text-xs">{pct(s.totals.increaseAdj, s.totals.currentBasic)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
