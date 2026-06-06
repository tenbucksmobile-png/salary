import { createClient } from '@/lib/supabase/server';
import { Hotel, SalaryRecord, Employee, PayrollImport } from '@/types/database';
import { fmtZAR, MONTH_NAMES } from '@/lib/utils';
import { Users, DollarSign, TrendingUp, Calendar } from 'lucide-react';

async function getHotelStats() {
  const sb = await createClient();

  const [{ data: hotels }, { data: employees }, { data: salaries }, { data: imports }] =
    await Promise.all([
      sb.from('hotels').select('*').order('name'),
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

  return (hotels ?? []).map((h: Hotel) => {
    const hotelEmps = empList.filter(e => e.hotel_id === h.id);
    const hotelSals = hotelEmps.map(e => latestSalary.get(e.id)).filter(Boolean) as SalaryRecord[];
    const lastImport = impList.find(i => i.hotel_id === h.id);

    const byGrade: Record<string, number> = {};
    for (const e of hotelEmps) {
      const g = e.grade_label ?? 'Unclassified';
      byGrade[g] = (byGrade[g] ?? 0) + 1;
    }

    return {
      hotel: h,
      headcount: hotelEmps.length,
      total_basic: hotelSals.reduce((s, r) => s + (r.basic_salary ?? 0), 0),
      total_ctc: hotelSals.reduce((s, r) => s + (r.ctc ?? 0), 0),
      total_earnings: hotelSals.reduce((s, r) => s + (r.total_earnings ?? 0), 0),
      last_import: lastImport
        ? `${MONTH_NAMES[lastImport.period_month - 1]} ${lastImport.period_year}`
        : null,
      by_grade: byGrade,
    };
  });
}

export default async function DashboardPage() {
  const stats = await getHotelStats();

  const totals = {
    headcount: stats.reduce((s, h) => s + h.headcount, 0),
    total_basic: stats.reduce((s, h) => s + h.total_basic, 0),
    total_ctc: stats.reduce((s, h) => s + h.total_ctc, 0),
  };

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">CFE Group — salary overview across all properties</p>
      </div>

      {/* Group totals */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard icon={Users} label="Total Headcount" value={totals.headcount.toString()} sub="All active employees" />
        <StatCard icon={DollarSign} label="Group Basic Payroll" value={fmtZAR(totals.total_basic)} sub="Per month" />
        <StatCard icon={TrendingUp} label="Group CTC" value={fmtZAR(totals.total_ctc)} sub="Per month" />
      </div>

      {/* Per-hotel cards */}
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">Properties</h2>
      <div className="grid grid-cols-1 gap-4">
        {stats.map(s => (
          <HotelCard key={s.hotel.id} stats={s} />
        ))}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub }: {
  icon: React.ElementType; label: string; value: string; sub: string;
}) {
  return (
    <div className="bg-white rounded-xl border p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{sub}</p>
    </div>
  );
}

function HotelCard({ stats: s }: { stats: Awaited<ReturnType<typeof getHotelStats>>[0] }) {
  const gradeOrder = ['ANO', 'Front Line', 'Supervisory', 'Middle Management', 'Management', 'Exec', 'Unclassified'];
  const grades = Object.entries(s.by_grade).sort(
    ([a], [b]) => (gradeOrder.indexOf(a) ?? 99) - (gradeOrder.indexOf(b) ?? 99),
  );

  return (
    <div className="bg-white rounded-xl border p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="font-semibold text-base">{s.hotel.name}</h3>
          <span className="text-xs text-muted-foreground">{s.hotel.short_code} · {s.hotel.country}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Calendar className="h-3 w-3" />
          {s.last_import ? `Last import: ${s.last_import}` : 'No data imported'}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-4">
        <Metric label="Headcount" value={s.headcount.toString()} />
        <Metric label="Basic Payroll" value={s.headcount > 0 ? fmtZAR(s.total_basic) : '—'} />
        <Metric label="Total CTC" value={s.headcount > 0 ? fmtZAR(s.total_ctc) : '—'} />
        <Metric label="Avg Basic" value={s.headcount > 0 ? fmtZAR(s.total_basic / s.headcount) : '—'} />
      </div>

      {grades.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {grades.map(([grade, count]) => (
            <span key={grade} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
              {grade} <span className="font-bold">{count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-semibold text-sm mt-0.5">{value}</p>
    </div>
  );
}
