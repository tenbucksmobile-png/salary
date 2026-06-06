'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, Upload, TrendingUp, Building2, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

const nav = [
  { label: 'Dashboard',      href: '/dashboard',               icon: LayoutDashboard },
  { label: 'Employees',      href: '/dashboard/employees',     icon: Users },
  { label: 'Import Payroll', href: '/dashboard/import',        icon: Upload },
  { label: 'Salary Review',  href: '/dashboard/salary-review', icon: TrendingUp },
  { label: 'Settings',       href: '/dashboard/settings',      icon: Settings },
];

export function NavSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 shrink-0 border-r bg-white flex flex-col min-h-screen">
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2 mb-0.5">
          <Building2 className="h-4 w-4 text-muted-foreground" />
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
