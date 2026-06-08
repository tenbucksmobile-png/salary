'use client';

import { useState, useRef, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseVIPReport, isTabularEmployeeFile, parseTSVEmployeeFile, isMedicalAidFile, parseMedicalAidFile } from '@/lib/vip-parser';
import { isEmployeeCsvExport, parseEmployeeCsvExport, type RoundtripRow } from '@/lib/employee-csv';
import { Hotel } from '@/types/database';
import { fmtCurrency, MONTH_NAMES } from '@/lib/utils';
import { Upload, CheckCircle, FileText, ChevronRight } from 'lucide-react';

type Step = 'select' | 'preview' | 'done';
type ImportType = 'vip' | 'employee' | 'medical' | 'roundtrip';

interface ImportRow {
  importType: ImportType;
  action: 'add' | 'update';
  existing_employee_id?: string;
  employeeCode: string;
  surname: string;
  firstName: string;
  aka: string;
  department: string;
  jobTitle: string;
  idNumber: string;
  paypoint: string;
  category: number;
  jobGrade: number;
  allowances: Record<string, number>;
  basicSalary: number;
  totalEarnings: number;
  taxPaye: number;
  uifEmployee: number;
  medicalEmployee: number;
  ancillaEmployee: number;
  providentEmployee: number;
  totalDeductions: number;
  uifCompany: number;
  medicalCompany: number;
  providentCompany: number;
  sdlCompany: number;
  ancillaCompany: number;
  totalCompanyContrib: number;
  netSalary: number;
  ctc: number;
  employmentDate?: string | null;
  gradeLabel?: string | null;
}

interface MedicalRow {
  surname: string;
  firstName: string;
  newMedical: number;
  employeeId: string | null;
  salaryRecordId: string | null;
  currentMedical: number;
}

const GRADE_MAP: Record<string, string> = {
  'frontline':   'Frontline',
  'front line':  'Frontline',
  'supervisor':  'Supervisory',
  'management':  'Management',
  'executive':   'Executive',
  'exec':        'Executive',
};
function normalizeGrade(g: string | null): string | null {
  if (!g) return null;
  return GRADE_MAP[g.toLowerCase()] ?? g;
}

function makeSyntheticCode(surname: string, firstName: string, used: Set<string>): string {
  const base = (surname.slice(0, 3) + firstName.slice(0, 3)).toUpperCase().replace(/[^A-Z]/g, '').padEnd(4, 'X');
  let code = base;
  let n = 2;
  while (used.has(code)) { code = base + n; n++; }
  used.add(code);
  return code;
}

const YEARS = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);

export default function ImportPage() {
  const sb = createClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [hotels, setHotels]     = useState<Hotel[]>([]);
  const [hotelId, setHotelId]   = useState('');
  const [step, setStep]         = useState<Step>('select');
  const [rows, setRows]         = useState<ImportRow[]>([]);
  const [medicalRows, setMedicalRows] = useState<MedicalRow[]>([]);
  const [errors, setErrors]     = useState<string[]>([]);
  const [importType, setImportType] = useState<ImportType>('vip');
  const [periodMonth, setPeriodMonth] = useState(new Date().getMonth() + 1);
  const [periodYear,  setPeriodYear]  = useState(new Date().getFullYear());
  const [roundtripRows, setRoundtripRows] = useState<RoundtripRow[]>([]);
  const [importMode, setImportMode] = useState<'update' | 'new'>('new');
  const [existingEmpData, setExistingEmpData] = useState<Map<string, Record<string, any>>>(new Map());
  const [loading,   setLoading]   = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult]       = useState({ added: 0, updated: 0 });

  useEffect(() => {
    sb.from('hotels').select('*').order('name').then(({ data }) => setHotels((data ?? []) as Hotel[]));
  }, []);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !hotelId) return;
    setLoading(true);

    const text = await file.text();
    const firstLine = text.split('\n')[0] ?? '';
    const isMedical    = isMedicalAidFile(firstLine);
    const isRoundtrip  = !isMedical && isEmployeeCsvExport(firstLine);
    const isEmployee   = !isMedical && !isRoundtrip && isTabularEmployeeFile(firstLine);
    setImportType(isMedical ? 'medical' : isRoundtrip ? 'roundtrip' : isEmployee ? 'employee' : 'vip');

    if (isRoundtrip) {
      // ── Employee CSV round-trip re-import ─────────────────────────────────
      const { data: existing } = await sb
        .from('employees').select('*').eq('hotel_id', hotelId);
      const existingList = (existing ?? []) as Record<string, any>[];
      setExistingEmpData(new Map(existingList.map(e => [e.id as string, e])));
      const { rows, errors: parseErrors } = parseEmployeeCsvExport(
        text,
        existingList as { id: string; employee_code: string }[],
      );
      setRoundtripRows(rows);
      setErrors(parseErrors);
      setLoading(false);
      setStep('preview');
      // Detect period from first row with salary data
      const firstWithPeriod = rows.find(r => r.periodMonth && r.periodYear);
      if (firstWithPeriod) {
        setPeriodMonth(firstWithPeriod.periodMonth);
        setPeriodYear(firstWithPeriod.periodYear);
      }
      return;
    }

    if (isMedical) {
      // ── Medical aid update ────────────────────────────────────────────────
      const { employees: emps } = parseMedicalAidFile(text);

      const { data: existingEmps } = await sb
        .from('employees')
        .select('id, surname, first_name')
        .eq('hotel_id', hotelId);

      const nameMap = new Map(
        (existingEmps ?? []).map((e: any) => [
          `${e.surname.toLowerCase()}|${e.first_name.toLowerCase()}`,
          e.id as string,
        ])
      );

      // Fetch latest salary record for each matched employee
      const matched = emps.map(emp => {
        const key1 = `${emp.surname.toLowerCase()}|${emp.firstName.toLowerCase()}`;
        const key2 = `${emp.firstName.toLowerCase()}|${emp.surname.toLowerCase()}`;
        const employeeId = nameMap.get(key1) ?? nameMap.get(key2) ?? null;
        return { ...emp, employeeId };
      });

      const employeeIds = matched.filter(m => m.employeeId).map(m => m.employeeId!);
      const { data: salRecs } = employeeIds.length
        ? await sb.from('salary_records').select('id, employee_id, medical_company, period_year, period_month').in('employee_id', employeeIds)
        : { data: [] };

      // Latest record per employee
      const latestSalMap = new Map<string, { id: string; medical_company: number; period_year: number; period_month: number }>();
      for (const s of (salRecs ?? []) as any[]) {
        const existing = latestSalMap.get(s.employee_id);
        if (!existing || s.period_year > existing.period_year || (s.period_year === existing.period_year && s.period_month > existing.period_month)) {
          latestSalMap.set(s.employee_id, { id: s.id, medical_company: s.medical_company ?? 0, period_year: s.period_year, period_month: s.period_month });
        }
      }

      const mRows: MedicalRow[] = matched.map(emp => {
        const sal = emp.employeeId ? latestSalMap.get(emp.employeeId) ?? null : null;
        return {
          surname:        emp.surname,
          firstName:      emp.firstName,
          newMedical:     emp.medicalCompany,
          employeeId:     emp.employeeId,
          salaryRecordId: sal?.id ?? null,
          currentMedical: sal?.medical_company ?? 0,
        };
      });

      setMedicalRows(mRows);
      setErrors([]);
      setLoading(false);
      setStep('preview');
      return;
    } else if (isEmployee) {
      // ── Employee details spreadsheet (TSV or CSV) ─────────────────────────
      const { employees: emps, errors: parseErrors } = parseTSVEmployeeFile(text);

      // Match by surname + first_name; also grab existing codes to avoid collisions
      const { data: existing } = await sb.from('employees').select('id, surname, first_name, employee_code').eq('hotel_id', hotelId);
      const existingNameMap = new Map(
        (existing ?? []).map((e: any) => [`${e.surname.toLowerCase()}|${e.first_name.toLowerCase()}`, e.id as string])
      );
      const existingCodes = new Set((existing ?? []).map((e: any) => e.employee_code as string));

      const importRows: ImportRow[] = emps.map(emp => {
        const nameKey = `${emp.surname.toLowerCase()}|${emp.firstName.toLowerCase()}`;
        const existingId = existingNameMap.get(nameKey);
        return {
          importType: 'employee' as const,
          action: existingId ? 'update' as const : 'add' as const,
          existing_employee_id: existingId,
          employeeCode: existingId ? '' : makeSyntheticCode(emp.surname, emp.firstName, existingCodes),
          surname: emp.surname,
          firstName: emp.firstName,
          aka: '',
          department: emp.department,
          jobTitle: emp.jobTitle,
          idNumber: '', paypoint: '', category: 0, jobGrade: 0,
          allowances: {},
          basicSalary: emp.grossSalary,
          totalEarnings: emp.grossSalary,
          taxPaye: 0, uifEmployee: 0, medicalEmployee: 0,
          ancillaEmployee: 0, providentEmployee: 0, totalDeductions: 0,
          uifCompany: 0, medicalCompany: emp.medicalCompany,
          providentCompany: 0, sdlCompany: 0, ancillaCompany: 0,
          totalCompanyContrib: emp.medicalCompany,
          netSalary: emp.grossSalary,
          ctc: emp.grossSalary + emp.medicalCompany,
          employmentDate: emp.employmentDate,
          gradeLabel: normalizeGrade(emp.gradeLabel),
        };
      });

      setRows(importRows);
      setErrors(parseErrors);
    } else {
      // ── VIP Report 710 ────────────────────────────────────────────────────
      const { employees, errors: parseErrors, periodMonth: pm, periodYear: py } = parseVIPReport(text);

      const { data: existing } = await sb.from('employees').select('id, employee_code').eq('hotel_id', hotelId);
      const existingMap = new Map((existing ?? []).map((e: any) => [e.employee_code as string, e.id as string]));

      const importRows: ImportRow[] = employees.map(emp => ({
        importType: 'vip' as const,
        action: existingMap.has(emp.employeeCode) ? 'update' as const : 'add' as const,
        existing_employee_id: existingMap.get(emp.employeeCode),
        employeeCode: emp.employeeCode,
        surname: emp.surname,
        firstName: emp.firstName,
        aka: emp.aka,
        department: emp.departmentCode,
        jobTitle: emp.jobTitle,
        idNumber: emp.idNumber,
        paypoint: emp.paypoint,
        category: emp.category,
        jobGrade: emp.jobGrade,
        allowances: emp.allowances,
        basicSalary: emp.basicSalary,
        totalEarnings: emp.totalEarnings,
        taxPaye: emp.taxPaye,
        uifEmployee: emp.uifEmployee,
        medicalEmployee: emp.medicalEmployee,
        ancillaEmployee: emp.ancillaEmployee,
        providentEmployee: emp.providentEmployee,
        totalDeductions: emp.totalDeductions,
        uifCompany: emp.uifCompany,
        medicalCompany: emp.medicalCompany,
        providentCompany: emp.providentCompany,
        sdlCompany: emp.sdlCompany,
        ancillaCompany: emp.ancillaCompany,
        totalCompanyContrib: emp.totalCompanyContrib,
        netSalary: emp.netSalary,
        ctc: emp.ctc,
      }));

      setRows(importRows);
      setErrors(parseErrors);
      setPeriodMonth(pm);
      setPeriodYear(py);
    }

    setLoading(false);
    setStep('preview');
  }

  async function confirmMedical() {
    setImporting(true);
    const sb2 = createClient();
    let updated = 0;

    for (const row of medicalRows) {
      if (!row.salaryRecordId) continue;
      // Fetch full record to compute accurate diffs
      const { data: sal } = await sb2.from('salary_records').select('*').eq('id', row.salaryRecordId).single();
      if (!sal) continue;
      const diff = row.newMedical - (sal.medical_company ?? 0);
      await sb2.from('salary_records').update({
        medical_company:       row.newMedical,
        total_company_contrib: (sal.total_company_contrib ?? 0) + diff,
        total_payroll_burden:  (sal.total_payroll_burden ?? 0) + diff,
        total_cost:            (sal.total_cost ?? 0) + diff,
        ctc:                   (sal.ctc ?? 0) + diff,
      }).eq('id', row.salaryRecordId);
      updated++;
    }

    setResult({ added: 0, updated });
    setImporting(false);
    setStep('done');
  }

  async function confirmRoundtrip() {
    setImporting(true);
    const sb2 = createClient();
    let added = 0, updated = 0;

    const { data: importRec } = await sb2.from('payroll_imports').insert({
      hotel_id:           hotelId,
      filename:           `Employee_CSV_Import_${MONTH_NAMES[periodMonth - 1]}_${periodYear}`,
      period_month:       periodMonth,
      period_year:        periodYear,
      employees_added:    roundtripRows.filter(r => r.action === 'add').length,
      employees_updated:  roundtripRows.filter(r => r.action === 'update').length,
      employees_flagged:  errors.length,
      status:             'confirmed',
    }).select().single();

    const importId = (importRec as any)?.id;

    for (const row of roundtripRows) {
      let employeeId = row.existingEmployeeId;

      if (row.action === 'add') {
        const { data: newEmp } = await sb2.from('employees').insert({
          hotel_id:        hotelId,
          employee_code:   row.employeeCode,
          surname:         row.surname,
          first_name:      row.firstName,
          aka:             row.aka || null,
          job_title:       row.jobTitle || null,
          department_code: row.department || null,
          grade_label:     row.gradeLabel || null,
          status:          row.status || 'active',
          nmw_applicable:        row.nmwApplicable,
          severance_applicable:  row.severanceApplicable,
          incentive_applicable:  row.incentiveApplicable,
          incentive_multiplier:  row.incentiveMultiplier,
          gratuity_applicable:   row.gratuityApplicable,
          gratuity_rate:         row.gratuityRate,
          comments:              row.comments || null,
          ...(row.employmentDate ? { employment_date: row.employmentDate } : {}),
        }).select().single();
        employeeId = (newEmp as any)?.id;
        added++;
      } else {
        if (importMode === 'update') {
          // Only patch fields that are currently null/empty in the DB
          const ex = existingEmpData.get(employeeId!) ?? {};
          const patch: Record<string, any> = {};
          if (!ex.surname       && row.surname)    patch.surname         = row.surname;
          if (!ex.first_name    && row.firstName)  patch.first_name      = row.firstName;
          if (!ex.aka           && row.aka)         patch.aka             = row.aka;
          if (!ex.job_title     && row.jobTitle)   patch.job_title       = row.jobTitle;
          if (!ex.department_code && row.department) patch.department_code = row.department;
          if (!ex.grade_label   && row.gradeLabel) patch.grade_label     = row.gradeLabel;
          if (!ex.status        && row.status)     patch.status          = row.status;
          if (ex.nmw_applicable        == null)    patch.nmw_applicable        = row.nmwApplicable;
          if (ex.severance_applicable  == null)    patch.severance_applicable  = row.severanceApplicable;
          if (ex.incentive_applicable  == null)    patch.incentive_applicable  = row.incentiveApplicable;
          if (!ex.incentive_multiplier)            patch.incentive_multiplier  = row.incentiveMultiplier;
          if (ex.gratuity_applicable   == null)    patch.gratuity_applicable   = row.gratuityApplicable;
          if (!ex.gratuity_rate)                   patch.gratuity_rate         = row.gratuityRate;
          if (!ex.comments      && row.comments)   patch.comments        = row.comments;
          if (!ex.employment_date && row.employmentDate) patch.employment_date = row.employmentDate;
          if (Object.keys(patch).length > 0) {
            patch.updated_at = new Date().toISOString();
            await sb2.from('employees').update(patch).eq('id', employeeId!);
          }
        } else {
          await sb2.from('employees').update({
            surname:         row.surname,
            first_name:      row.firstName,
            aka:             row.aka || null,
            job_title:       row.jobTitle || null,
            department_code: row.department || null,
            grade_label:     row.gradeLabel || null,
            status:          row.status || 'active',
            nmw_applicable:        row.nmwApplicable,
            severance_applicable:  row.severanceApplicable,
            incentive_applicable:  row.incentiveApplicable,
            incentive_multiplier:  row.incentiveMultiplier,
            gratuity_applicable:   row.gratuityApplicable,
            gratuity_rate:         row.gratuityRate,
            comments:              row.comments || null,
            ...(row.employmentDate ? { employment_date: row.employmentDate } : {}),
            updated_at: new Date().toISOString(),
          }).eq('id', employeeId!);
        }
        updated++;
      }

      if (employeeId && row.periodMonth && row.periodYear) {
        const salaryPayload = {
          employee_id:           employeeId,
          import_id:             importId,
          period_month:          row.periodMonth,
          period_year:           row.periodYear,
          basic_salary:          row.basicSalary,
          allowances:            row.allowances,
          total_earnings:        row.totalEarnings,
          tax_paye:              row.taxPaye,
          uif_employee:          row.uifEmployee,
          medical_employee:      row.medicalEmployee,
          ancilla_employee:      row.ancillaEmployee,
          provident_employee:    row.providentEmployee,
          total_deductions:      row.totalDeductions,
          uif_company:           row.uifCompany,
          medical_company:       row.medicalCompany,
          provident_company:     row.providentCompany,
          sdl_company:           row.sdlCompany,
          ancilla_company:       row.ancillaCompany,
          total_company_contrib: row.totalCompanyContrib,
          wca_company:           row.wcaCompany,
          staff_meals:           row.staffMeals,
          bonus_provision:       row.bonusProvision,
          incentive:             row.incentive,
          leave_provision:       row.leaveProvision,
          other_company_contrib: row.otherCompanyContrib,
          total_payroll_burden:  row.totalPayrollBurden,
          total_cost:            row.totalCost,
          leave_days:            row.leaveDays,
          leave_accrual:         row.leaveAccrual,
          bonus_payout_factor:   row.bonusPayoutFactor,
          bonus_accrual_dec:     row.bonusAccrualDec,
          bonus_accrual_july:    row.bonusAccrualJuly,
          mgmt_incentive:        row.mgmtIncentive,
          severance:             row.severance,
          gratuity:              row.gratuity,
          net_salary:            row.netSalary,
          ctc:                   row.ctc,
        };
        // Update mode: ignoreDuplicates=true means existing salary records are never overwritten
        await sb2.from('salary_records').upsert(salaryPayload, {
          onConflict: 'employee_id,period_year,period_month',
          ignoreDuplicates: importMode === 'update',
        });
      }
    }

    setResult({ added, updated });
    setImporting(false);
    setStep('done');
  }

  async function confirmImport() {
    setImporting(true);
    const sb2 = createClient();

    const { data: importRec } = await sb2.from('payroll_imports').insert({
      hotel_id: hotelId,
      filename: importType === 'employee' ? 'Employee_Details_Import' : `VIP_Import_${MONTH_NAMES[periodMonth - 1]}_${periodYear}`,
      period_month: periodMonth,
      period_year: periodYear,
      employees_added:   rows.filter(r => r.action === 'add').length,
      employees_updated: rows.filter(r => r.action === 'update').length,
      employees_flagged: errors.length,
      status: 'confirmed',
    }).select().single();

    const importId = (importRec as any)?.id;
    let added = 0, updated = 0;

    for (const row of rows) {
      let employeeId = row.existing_employee_id;

      if (row.action === 'add') {
        const { data: newEmp } = await sb2.from('employees').insert({
          hotel_id: hotelId,
          employee_code: row.employeeCode,
          surname: row.surname,
          first_name: row.firstName,
          aka: row.aka || null,
          id_number: row.idNumber || null,
          job_title: row.jobTitle || null,
          department_code: row.department || null,
          paypoint: row.paypoint || null,
          category: row.category || null,
          job_grade: row.jobGrade || null,
          grade_label: row.gradeLabel || null,
          ...(row.employmentDate ? { employment_date: row.employmentDate } : {}),
        }).select().single();
        employeeId = (newEmp as any)?.id;
        added++;
      } else {
        await sb2.from('employees').update({
          job_title: row.jobTitle || null,
          department_code: row.department || null,
          ...(row.paypoint ? { paypoint: row.paypoint } : {}),
          ...(row.category ? { category: row.category } : {}),
          ...(row.jobGrade ? { job_grade: row.jobGrade } : {}),
          ...(row.gradeLabel ? { grade_label: row.gradeLabel } : {}),
          ...(row.employmentDate ? { employment_date: row.employmentDate } : {}),
          updated_at: new Date().toISOString(),
        }).eq('id', employeeId!);
        updated++;
      }

      if (employeeId) {
        await sb2.from('salary_records').upsert({
          employee_id: employeeId,
          import_id: importId,
          period_month: periodMonth,
          period_year: periodYear,
          basic_salary: row.basicSalary,
          allowances: row.allowances,
          total_earnings: row.totalEarnings,
          tax_paye: row.taxPaye,
          uif_employee: row.uifEmployee,
          medical_employee: row.medicalEmployee,
          ancilla_employee: row.ancillaEmployee,
          provident_employee: row.providentEmployee,
          total_deductions: row.totalDeductions,
          uif_company: row.uifCompany,
          medical_company: row.medicalCompany,
          provident_company: row.providentCompany,
          sdl_company: row.sdlCompany,
          ancilla_company: row.ancillaCompany,
          total_company_contrib: row.totalCompanyContrib,
          net_salary: row.netSalary,
          ctc: row.ctc,
        }, { onConflict: 'employee_id,period_year,period_month' });
      }
    }

    setResult({ added, updated });
    setImporting(false);
    setStep('done');
  }

  function reset() {
    setStep('select');
    setRows([]);
    setMedicalRows([]);
    setRoundtripRows([]);
    setErrors([]);
    setImportMode('new');
    setExistingEmpData(new Map());
    if (fileRef.current) fileRef.current.value = '';
  }

  const addCount       = rows.filter(r => r.action === 'add').length;
  const updateCount    = rows.filter(r => r.action === 'update').length;
  const selectedCountry = hotels.find(h => h.id === hotelId)?.country ?? '';
  const fmt = (n: number) => fmtCurrency(n, selectedCountry);

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Import Employees</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Upload a VIP Report 710 payroll file <em>or</em> any tabular employee export (Excel CSV / TSV)
        </p>
      </div>

      {/* Steps indicator */}
      <div className="flex items-center gap-2 mb-8 text-sm">
        {(['select', 'preview', 'done'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <span className={`font-medium ${step === s ? 'text-primary' : 'text-muted-foreground'}`}>
              {i + 1}. {s === 'select' ? 'Select Hotel & File' : s === 'preview' ? 'Review Import' : 'Complete'}
            </span>
          </div>
        ))}
      </div>

      {/* Step 1 */}
      {step === 'select' && (
        <div className="bg-white rounded-xl border p-6 max-w-lg space-y-5">
          <div>
            <label className="text-sm font-medium block mb-1">Hotel</label>
            <select
              value={hotelId}
              onChange={e => setHotelId(e.target.value)}
              className="w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
            >
              <option value="">— Select hotel —</option>
              {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>

          {hotelId && (
            <>
              <div>
                <label className="text-sm font-medium block mb-1">Payroll period</label>
                <div className="flex gap-2">
                  <select
                    value={periodMonth}
                    onChange={e => setPeriodMonth(Number(e.target.value))}
                    className="flex-1 rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
                  >
                    {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                  <select
                    value={periodYear}
                    onChange={e => setPeriodYear(Number(e.target.value))}
                    className="w-28 rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring bg-white"
                  >
                    {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground mt-1">VIP files detect the period automatically. Required for all other file types.</p>
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">File</label>
                <label className={`flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-xl p-8 cursor-pointer transition-colors ${loading ? 'opacity-50' : 'hover:border-primary hover:bg-muted/20'}`}>
                  <Upload className="h-8 w-8 text-muted-foreground" />
                  <div className="text-center">
                    <p className="text-sm font-medium">Click to select file</p>
                    <p className="text-xs text-muted-foreground mt-1">.csv  ·  .txt  ·  .prn  — VIP or Excel export</p>
                  </div>
                  <input ref={fileRef} type="file" accept=".csv,.txt,.prn" onChange={handleFile} className="hidden" disabled={loading} />
                </label>
                {loading && <p className="text-sm text-muted-foreground mt-2 text-center">Detecting format and parsing…</p>}
              </div>
            </>
          )}
        </div>
      )}

      {/* Step 2: Preview — Medical Aid Update */}
      {step === 'preview' && importType === 'medical' && (
        <div className="space-y-4">
          <div className="flex gap-3 flex-wrap items-center">
            <span className="rounded-full px-3 py-1 text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
              Medical Aid Update
            </span>
            <span className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-1.5 text-sm text-blue-700">
              <strong>{medicalRows.filter(r => r.salaryRecordId).length}</strong> matched
            </span>
            {medicalRows.some(r => !r.employeeId) && (
              <span className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 text-sm text-amber-700">
                <strong>{medicalRows.filter(r => !r.employeeId).length}</strong> not found
              </span>
            )}
          </div>

          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current Medical</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">New Medical</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Change</th>
                </tr>
              </thead>
              <tbody>
                {medicalRows.map((r, i) => {
                  const diff = r.newMedical - r.currentMedical;
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/10">
                      <td className="px-4 py-2.5 font-medium">{r.surname}, {r.firstName}</td>
                      <td className="px-4 py-2.5">
                        {r.salaryRecordId
                          ? <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-blue-50 text-blue-700">Update</span>
                          : r.employeeId
                          ? <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700">No salary record</span>
                          : <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700">Not found</span>
                        }
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmt(r.currentMedical)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmt(r.newMedical)}</td>
                      <td className={`px-4 py-2.5 text-right font-mono ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                        {diff === 0 ? '—' : `${diff > 0 ? '+' : ''}${fmt(diff)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex gap-3">
            <button
              onClick={confirmMedical}
              disabled={importing || medicalRows.filter(r => r.salaryRecordId).length === 0}
              className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <FileText className="h-4 w-4" />
              {importing ? 'Updating…' : `Update Medical Aid (${medicalRows.filter(r => r.salaryRecordId).length} records)`}
            </button>
            <button onClick={reset} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Preview — Round-trip CSV */}
      {step === 'preview' && importType === 'roundtrip' && (
        <div className="space-y-4">
          <div className="flex gap-3 flex-wrap items-center">
            <span className="rounded-full px-3 py-1 text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
              Employee CSV (round-trip)
            </span>
            <span className="rounded-lg bg-muted px-3 py-1.5 text-sm text-muted-foreground">
              Period: <strong className="text-foreground">{MONTH_NAMES[periodMonth - 1]} {periodYear}</strong>
            </span>
            {roundtripRows.filter(r => r.action === 'update').length > 0 && (
              <span className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-1.5 text-sm text-blue-700">
                <strong>{roundtripRows.filter(r => r.action === 'update').length}</strong> update
              </span>
            )}
            {roundtripRows.filter(r => r.action === 'add').length > 0 && (
              <span className="rounded-lg bg-green-50 border border-green-200 px-3 py-1.5 text-sm text-green-700">
                <strong>{roundtripRows.filter(r => r.action === 'add').length}</strong> new
              </span>
            )}
            {errors.length > 0 && (
              <span className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 text-sm text-amber-700">
                {errors.length} warnings
              </span>
            )}
          </div>

          {/* Import mode toggle */}
          <div className="flex flex-wrap items-center gap-6 p-3 bg-muted/30 rounded-lg border text-sm">
            <span className="font-medium">Import mode:</span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="importMode" value="update" checked={importMode === 'update'} onChange={() => setImportMode('update')} className="accent-primary" />
              <span><strong>Update</strong> — fill missing fields only, don&apos;t overwrite existing data or salary records</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="importMode" value="new" checked={importMode === 'new'} onChange={() => setImportMode('new')} className="accent-primary" />
              <span><strong>New</strong> — override all employee data and salary records</span>
            </label>
          </div>

          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Action</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Code</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Grade</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Basic</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">CTC</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Period</th>
                </tr>
              </thead>
              <tbody>
                {roundtripRows.map((r, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/10">
                    <td className="px-4 py-2.5">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${r.action === 'add' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}`}>
                        {r.action === 'add' ? 'New' : 'Update'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{r.employeeCode}</td>
                    <td className="px-4 py-2.5 font-medium">{r.surname}, {r.firstName}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.gradeLabel || '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${r.status === 'active' ? 'bg-green-50 text-green-700' : r.status === 'terminated' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmt(r.basicSalary)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{r.ctc ? fmt(r.ctc) : '—'}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {r.periodMonth ? `${MONTH_NAMES[r.periodMonth - 1]} ${r.periodYear}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {errors.length > 0 && (
            <details className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <summary className="cursor-pointer font-medium">Show {errors.length} warnings</summary>
              <ul className="mt-2 space-y-1 list-disc list-inside">
                {errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </details>
          )}

          <p className="text-xs text-muted-foreground">
            All salary data is imported as-is. Run &ldquo;Calculate Burden&rdquo; afterwards to recalculate contributions.
          </p>

          <div className="flex gap-3">
            <button
              onClick={confirmRoundtrip}
              disabled={importing || roundtripRows.length === 0}
              className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <FileText className="h-4 w-4" />
              {importing ? 'Importing…' : `Confirm Import (${roundtripRows.length} employees)`}
            </button>
            <button onClick={reset} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Preview — Employee / VIP */}
      {step === 'preview' && importType !== 'medical' && importType !== 'roundtrip' && (
        <div className="space-y-4">
          <div className="flex gap-3 flex-wrap items-center">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${importType === 'employee' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-sky-50 text-sky-700 border border-sky-200'}`}>
              {importType === 'employee' ? 'Employee Details (CSV/TSV)' : 'VIP Report 710'}
            </span>
            <span className="rounded-lg bg-muted px-3 py-1.5 text-sm text-muted-foreground">
              Period: <strong className="text-foreground">{MONTH_NAMES[periodMonth - 1]} {periodYear}</strong>
            </span>
            <span className="rounded-lg bg-green-50 border border-green-200 px-3 py-1.5 text-sm text-green-700">
              <strong>{addCount}</strong> new
            </span>
            <span className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-1.5 text-sm text-blue-700">
              <strong>{updateCount}</strong> update
            </span>
            {errors.length > 0 && (
              <span className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 text-sm text-amber-700">
                {errors.length} warnings
              </span>
            )}
          </div>

          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Action</th>
                  {importType === 'vip' && <th className="text-left px-4 py-3 font-medium text-muted-foreground">Code</th>}
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Department</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Title</th>
                  {importType === 'employee' && <th className="text-left px-4 py-3 font-medium text-muted-foreground">Start Date</th>}
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Gross</th>
                  {importType === 'vip' && <th className="text-right px-4 py-3 font-medium text-muted-foreground">CTC</th>}
                  {importType === 'vip' && <th className="text-right px-4 py-3 font-medium text-muted-foreground">Net</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/10">
                    <td className="px-4 py-2.5">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${r.action === 'add' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}`}>
                        {r.action === 'add' ? 'New' : 'Update'}
                      </span>
                    </td>
                    {importType === 'vip' && <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{r.employeeCode}</td>}
                    <td className="px-4 py-2.5 font-medium">{r.surname}, {r.firstName}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.department || '—'}</td>
                    <td className="px-4 py-2.5">{r.jobTitle || '—'}</td>
                    {importType === 'employee' && (
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {r.employmentDate ? new Date(r.employmentDate).toLocaleDateString('en-ZA') : '—'}
                      </td>
                    )}
                    <td className="px-4 py-2.5 text-right font-mono">{fmt(r.basicSalary)}</td>
                    {importType === 'vip' && <td className="px-4 py-2.5 text-right font-mono">{fmt(r.ctc)}</td>}
                    {importType === 'vip' && <td className="px-4 py-2.5 text-right font-mono">{fmt(r.netSalary)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {errors.length > 0 && (
            <details className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <summary className="cursor-pointer font-medium">Show {errors.length} warnings</summary>
              <ul className="mt-2 space-y-1 list-disc list-inside">
                {errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </details>
          )}

          <div className="flex gap-3">
            <button
              onClick={confirmImport}
              disabled={importing || rows.length === 0}
              className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <FileText className="h-4 w-4" />
              {importing ? 'Importing…' : `Confirm Import (${rows.length} employees)`}
            </button>
            <button onClick={reset} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Done */}
      {step === 'done' && (
        <div className="bg-white rounded-xl border p-8 max-w-md text-center">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold mb-2">Import Complete</h2>
          <p className="text-muted-foreground text-sm mb-6">
            {result.added} employees added · {result.updated} updated for {MONTH_NAMES[periodMonth - 1]} {periodYear}
          </p>
          <div className="flex gap-3 justify-center">
            <a href="/dashboard/employees" className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors">
              View Employees
            </a>
            <button onClick={reset} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">
              Import Another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
