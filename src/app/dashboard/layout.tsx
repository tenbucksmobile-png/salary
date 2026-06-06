import { NavSidebar } from '@/components/nav-sidebar';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-muted/30">
      <NavSidebar />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
