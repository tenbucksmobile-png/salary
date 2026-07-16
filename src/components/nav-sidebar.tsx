'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, Upload, TrendingUp, Settings, Shield, BarChart2, ClipboardCheck, CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEFAULT_SUB_TABS, type TabKey } from '@/lib/auth';

const ADMIN_NAV = [
  { label: 'Dashboard',        href: '/dashboard',               icon: LayoutDashboard },
  { label: 'Employees',        href: '/dashboard/employees',     icon: Users },
  { label: 'Leave Provision',  href: '/dashboard/leave-provision', icon: CalendarClock },
  { label: 'Import HR List',   href: '/dashboard/import',        icon: Upload },
  { label: 'Salary Review',    href: '/dashboard/salary-review', icon: TrendingUp },
  { label: 'Reports',          href: '/dashboard/reports',       icon: BarChart2 },
  { label: 'Reconciliation',   href: '/dashboard/reconciliation', icon: ClipboardCheck },
  { label: 'Methods',          href: '/dashboard/methods',       icon: Settings },
  { label: 'Access',           href: '/dashboard/access',        icon: Shield },
];

// Configurable per sub user — key must match CONFIGURABLE_TABS in src/lib/auth.ts
const SUB_NAV: { key: TabKey; label: string; href: string; icon: typeof Users }[] = [
  { key: 'dashboard',      label: 'Dashboard',      href: '/dashboard',               icon: LayoutDashboard },
  { key: 'employees',      label: 'Employees',      href: '/dashboard/employees',     icon: Users },
  { key: 'leaveProvision', label: 'Leave Provision', href: '/dashboard/leave-provision', icon: CalendarClock },
  { key: 'import',         label: 'Import HR List',  href: '/dashboard/import',        icon: Upload },
  { key: 'reconciliation', label: 'Reconciliation',  href: '/dashboard/reconciliation', icon: ClipboardCheck },
  { key: 'reports',        label: 'Reports',        href: '/dashboard/reports',       icon: BarChart2 },
  { key: 'methods',        label: 'Methods',        href: '/dashboard/methods',       icon: Settings },
];

interface NavSidebarProps {
  role: 'admin' | 'sub';
  username: string;
  allowedTabs?: string[] | null;
}

export function NavSidebar({ role, username, allowedTabs }: NavSidebarProps) {
  const pathname = usePathname();
  const tabs = allowedTabs ?? DEFAULT_SUB_TABS;
  const nav = role === 'admin' ? ADMIN_NAV : SUB_NAV.filter(item => tabs.includes(item.key));

  return (
    <aside className="w-60 shrink-0 border-r bg-white flex flex-col min-h-screen">
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2 mb-0.5">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">IHG Hotels</p>
        </div>
        <p className="text-lg font-bold text-foreground leading-tight">Salary Manager</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map(({ label, href, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="px-6 py-4 border-t space-y-1">
        {username && <p className="text-xs font-medium text-foreground">{username}</p>}
        <p className="text-xs text-muted-foreground">6 properties · CFE Group</p>
        <a
          href="/api/auth/logout"
          className="block text-xs text-muted-foreground hover:text-foreground pt-1 transition-colors"
        >
          Sign out
        </a>
      </div>
    </aside>
  );
}
