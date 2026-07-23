'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Users, Upload, TrendingUp, Settings, Shield, BarChart2,
  ClipboardCheck, CalendarClock, ShieldCheck, Gift, HandCoins,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEFAULT_SUB_TABS, type TabKey } from '@/lib/auth';

interface NavItem {
  label: string;
  href: string;
  icon: typeof Users;
  key: TabKey | 'salaryReview' | 'access' | 'wca' | 'bonus' | 'severance';
  adminOnly?: boolean;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'HR LIST',
    items: [
      { label: 'Dashboard',      href: '/dashboard',               icon: LayoutDashboard, key: 'dashboard' },
      { label: 'Employees',      href: '/dashboard/employees',     icon: Users,           key: 'employees' },
      { label: 'Reconciliation', href: '/dashboard/reconciliation', icon: ClipboardCheck, key: 'reconciliation' },
    ],
  },
  {
    heading: 'BUDGET',
    items: [
      { label: 'Salary Review', href: '/dashboard/salary-review', icon: TrendingUp, key: 'salaryReview', adminOnly: true },
    ],
  },
  {
    heading: 'PROVISIONS',
    items: [
      { label: 'Leave',      href: '/dashboard/leave-provision', icon: CalendarClock, key: 'leaveProvision' },
      { label: 'WCA',        href: '/dashboard/provisions/wca',        icon: ShieldCheck, key: 'wca' },
      { label: 'Bonus',      href: '/dashboard/provisions/bonus',      icon: Gift,         key: 'bonus' },
      { label: 'Severance',  href: '/dashboard/provisions/severance',  icon: HandCoins,    key: 'severance' },
    ],
  },
  {
    heading: 'FUNCTION',
    items: [
      { label: 'Methods',        href: '/dashboard/methods', icon: Settings,   key: 'methods' },
      { label: 'Reports',        href: '/dashboard/reports', icon: BarChart2,  key: 'reports' },
      { label: 'Access',         href: '/dashboard/access',  icon: Shield,     key: 'access', adminOnly: true },
      { label: 'Import HR List', href: '/dashboard/import',  icon: Upload,     key: 'import' },
    ],
  },
];

interface NavSidebarProps {
  role: 'admin' | 'sub';
  username: string;
  allowedTabs?: string[] | null;
}

export function NavSidebar({ role, username, allowedTabs }: NavSidebarProps) {
  const pathname = usePathname();
  const tabs = allowedTabs ?? DEFAULT_SUB_TABS;

  const groups = NAV_GROUPS.map(group => ({
    heading: group.heading,
    items: group.items.filter(item => {
      if (role === 'admin') return true;
      if (item.adminOnly) return false;
      return tabs.includes(item.key as TabKey);
    }),
  })).filter(group => group.items.length > 0);

  return (
    <aside className="w-60 shrink-0 border-r bg-white flex flex-col min-h-screen">
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2 mb-0.5">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">IHG Hotels</p>
        </div>
        <p className="text-lg font-bold text-foreground leading-tight">Salary Manager</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
        {groups.map(group => (
          <div key={group.heading}>
            <p className="px-2 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.heading}
            </p>
            <div className="rounded-lg border border-border bg-muted/30 p-1 shadow-sm">
              {group.items.map(({ label, href, icon: Icon }) => {
                const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href));
                return (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-white hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
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
