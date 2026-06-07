'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Employee, Hotel, SalaryRecord } from '@/types/database';
import { fmtCurrency, MONTH_NAMES } from '@/lib/utils';
import { ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';
import { isBotswana } from '@/lib/payroll-calc';

const GRADE_OPTIONS = ['ANO', 'FTC', 'DNQ', 'Frontline', 'Supervisory', 'Management', 'Executive'];
const STATUS_OPTIONS = ['active', 'terminated', 'on_leave'] as const;

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sb = createClient();

  const [emp, setEmp] = useState<Employee | null>(null);
  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [salaries, setSalaries] = useState<SalaryRecord[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Editable fields
  const [form, setForm] = useState({
    job_title: '',
    department_code: '',
    grade_label: '',
    status: 'active' as Employee['status'],
    employment_date: '',
    aka: '',
    comments: '',
    nmw_applicable: false,
    severance_applicable: false,
    incentive_applicable: false,
    incentive_multiplier: 2,
    gratuity_applicable: false,
    gratuity_rate: 0,
  });

  useEffect(() => {
    async function load() {
      const [{ data: e }, { data: sals }] = await Promise.all([
        sb.from('employees').select('*, hotels(*)').eq('id', id).single(),
        sb.from('salary_records').select('*').eq('employee_id', id).order('period_year', { ascending: false }).order('period_month', { ascending: false }),
      ]);
      if (e) {
        setEmp(e as any);
        setHotel((e as any).hotels as Hotel);
        setSalaries((sals ?? []) as SalaryRecord[]);
        setForm({
          job_title: e.job_title ?? '',
          department_code: e.department_code ?? '',
          grade_label: e.grade_label ?? '',
          status: e.status as Employee['status'],
          employment_date: e.employment_date ?? '',
          aka: e.aka ?? '',
          comments: e.comments ?? '',
          nmw_applicable: e.nmw_applicable ?? false,
          severance_applicable: (e as any).severance_applicable ?? false,
          incentive_applicable: (e as any).incentive_applicable ?? false,
          incentive_multiplier: (e as any).incentive_multiplier ?? 2,
          gratuity_applicable:  (e as any).gratuity_applicable  ?? false,
          gratuity_rate:        (e as any).gratuity_rate        ?? 0,
        });
      }
    }
    load();
  }, [id]);

  async function save() {
    setSaving(true);
    await sb.from('employees').update({
      ...form,
      grade_label:     form.grade_label || null,
      employment_date: form.employment_date || null,
      aka:             form.aka || null,
      comments:        form.comments || null,
      updated_at:      new Date().toISOString(),
    }).eq('id', id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (!emp) return <div className="p-8 text-muted-foreground">Loading…</div>;

  const latestSal = salaries[0];
  const fmt = (n: number) => fmtCurrency(n, hotel?.country ?? '');

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/dashboard/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Employees
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">{emp.surname}, {emp.first_name}</h1>
        <p className="text-muted-foreground text-sm">{emp.employee_code} · {hotel?.name}</p>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Edit form */}
        <div className="bg-white rounded-xl border p-6 space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Employee Details</h2>

          <Field label="Job Title">
            <input
              value={form.job_title}
              onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))}
              className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>

          <Field label="Department Code">
            <input
              value={form.department_code}
              onChange={e => setForm(f => ({ ...f, department_code: e.target.value }))}
              className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>

          <Field label="Grade">
            <select
              value={form.grade_label}
              onChange={e => setForm(f => ({ ...f, grade_label: e.target.value }))}
              className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
            >
              <option value="">— Not set —</option>
              {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </Field>

          <Field label="Status">
            <select
              value={form.status}
              onChange={e => setForm(f => ({ ...f, status: e.target.value as Employee['status'] }))}
              className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
            >
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>

          <Field label="Employment Date">
            <input
              type="date"
              value={form.employment_date}
              onChange={e => setForm(f => ({ ...f, employment_date: e.target.value }))}
              className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>

          <Field label="Known As (AKA)">
            <input
              value={form.aka}
              onChange={e => setForm(f => ({ ...f, aka: e.target.value }))}
              className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>

          <Field label="Comments / Notes">
            <textarea
              value={form.comments}
              onChange={e => setForm(f => ({ ...f, comments: e.target.value }))}
              rows={3}
              className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </Field>

          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={form.nmw_applicable}
              onChange={e => setForm(f => ({ ...f, nmw_applicable: e.target.checked }))}
              className="rounded"
            />
            <span>National Minimum Wage (NMW) applicable</span>
          </label>

          {hotel && isBotswana(hotel.country) && (
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={form.severance_applicable}
                onChange={e => setForm(f => ({ ...f, severance_applicable: e.target.checked }))}
                className="rounded"
              />
              <span>Calculate severance accrual</span>
            </label>
          )}

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={form.incentive_applicable}
                onChange={e => setForm(f => ({ ...f, incentive_applicable: e.target.checked }))}
                className="rounded"
              />
              <span>Incentive applicable</span>
            </label>
            {form.incentive_applicable && (
              <div className="ml-6">
                <label className="text-xs font-medium text-muted-foreground block mb-1">Incentive multiplier</label>
                <select
                  value={form.incentive_multiplier}
                  onChange={e => setForm(f => ({ ...f, incentive_multiplier: Number(e.target.value) }))}
                  className="rounded-md border border-input px-3 py-1.5 text-sm bg-white outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value={2}>Gross × 2</option>
                  <option value={3}>Gross × 3</option>
                  <option value={4}>Gross × 4</option>
                </select>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={form.gratuity_applicable}
                onChange={e => setForm(f => ({ ...f, gratuity_applicable: e.target.checked }))}
                className="rounded"
              />
              <span>Gratuity applicable</span>
            </label>
            {form.gratuity_applicable && (
              <div className="ml-6 flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground">Rate</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.gratuity_rate}
                  onChange={e => setForm(f => ({ ...f, gratuity_rate: parseFloat(e.target.value) || 0 }))}
                  className="w-24 rounded-md border border-input px-3 py-1.5 text-sm text-right font-mono outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            )}
          </div>

          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Save className="h-4 w-4" />
            {saved ? 'Saved!' : saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>

        {/* Read-only info */}
        <div className="space-y-6">
          <div className="bg-white rounded-xl border p-6">
            <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground mb-4">VIP Info</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Employee Code" value={emp.employee_code} />
              <Row label="ID Number" value={emp.id_number ?? '—'} />
              <Row label="Paypoint" value={emp.paypoint ?? '—'} />
              <Row label="Category" value={emp.category?.toString() ?? '—'} />
              <Row label="Job Grade" value={emp.job_grade?.toString() ?? '—'} />
            </dl>
          </div>

          {latestSal && (
            <div className="bg-white rounded-xl border p-6">
              <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground mb-4">
                Latest Salary — {MONTH_NAMES[latestSal.period_month - 1]} {latestSal.period_year}
              </h2>
              <dl className="space-y-2 text-sm">
                <Row label="Basic Salary" value={fmt(latestSal.basic_salary)} bold />
                <Row label="Total Earnings" value={fmt(latestSal.total_earnings)} />
                <Row label="CTC" value={fmt(latestSal.ctc)} bold />
                <div className="border-t my-2" />
                <Row label="PAYE" value={fmt(latestSal.tax_paye)} />
                <Row label="UIF (Emp)" value={fmt(latestSal.uif_employee)} />
                <Row label="Medical (Emp)" value={fmt(latestSal.medical_employee)} />
                <Row label="Provident (Emp)" value={fmt(latestSal.provident_employee)} />
                <div className="border-t my-2" />
                <Row label="Medical (Co)" value={fmt(latestSal.medical_company)} />
                <Row label="Provident (Co)" value={fmt(latestSal.provident_company)} />
                <Row label="SDL" value={fmt(latestSal.sdl_company)} />
                <Row label="UIF (Co)" value={fmt(latestSal.uif_company)} />
                <div className="border-t my-2" />
                <Row label="Net Salary" value={fmt(latestSal.net_salary)} bold />
              </dl>
            </div>
          )}
        </div>
      </div>

      {/* Salary history */}
      {salaries.length > 1 && (
        <div className="mt-6 bg-white rounded-xl border p-6">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground mb-4">Salary History</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 font-medium text-muted-foreground">Period</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Basic</th>
                <th className="text-right py-2 font-medium text-muted-foreground">CTC</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Net</th>
              </tr>
            </thead>
            <tbody>
              {salaries.map(s => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="py-2">{MONTH_NAMES[s.period_month - 1]} {s.period_year}</td>
                  <td className="py-2 text-right font-mono">{fmt(s.basic_salary)}</td>
                  <td className="py-2 text-right font-mono">{fmt(s.ctc)}</td>
                  <td className="py-2 text-right font-mono">{fmt(s.net_salary)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground block mb-1">{label}</label>
      {children}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={bold ? 'font-semibold' : ''}>{value}</dd>
    </div>
  );
}
