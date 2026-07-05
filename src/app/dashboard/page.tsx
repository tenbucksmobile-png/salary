import SalarySummaryTable from './SalarySummaryTable';

export default function DashboardPage() {
  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
      </div>

      <SalarySummaryTable />
    </div>
  );
}
