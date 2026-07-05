import { cookies } from 'next/headers';
import { verifyToken } from '@/lib/auth';
import { NavSidebar } from '@/components/nav-sidebar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get('ihg-salary-auth')?.value ?? '';
  const user  = token ? await verifyToken(token) : null;

  return (
    <div className="flex min-h-screen bg-muted/30">
      <NavSidebar role={user?.role ?? 'sub'} username={user?.username ?? ''} allowedTabs={user?.allowedTabs ?? null} />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
