import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, COOKIE_NAME, CONFIGURABLE_TABS, DEFAULT_SUB_TABS, type TabKey } from '@/lib/auth';

// Permanently admin-only, regardless of any sub user's allowedTabs.
const SUB_BLOCKED = [
  '/dashboard/salary-review',
  '/dashboard/access',
];

// Route prefixes per configurable tab. 'dashboard' is matched as an EXACT
// path only (see matchTab) since '/dashboard' is also a prefix of every
// other tab's route. '/dashboard/settings' is a redirect shim to Methods,
// so it's gated the same as the 'methods' tab.
const TAB_ROUTES: Record<TabKey, string[]> = {
  dashboard:      ['/dashboard'],
  employees:      ['/dashboard/employees'],
  import:         ['/dashboard/import'],
  reconciliation: ['/dashboard/reconciliation'],
  reports:        ['/dashboard/reports'],
  methods:        ['/dashboard/methods', '/dashboard/settings'],
};

function matchTab(pathname: string): TabKey | undefined {
  if (pathname === '/dashboard') return 'dashboard';
  for (const [key, prefixes] of Object.entries(TAB_ROUTES) as [TabKey, string[]][]) {
    if (key === 'dashboard') continue;
    if (prefixes.some(p => pathname.startsWith(p))) return key;
  }
  return undefined;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow login and auth API routes
  if (pathname.startsWith('/login') || pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  const token = request.cookies.get(COOKIE_NAME)?.value ?? '';
  if (!token) return NextResponse.redirect(new URL('/login', request.url));

  const user = await verifyToken(token);
  if (!user) {
    const res = NextResponse.redirect(new URL('/login', request.url));
    res.cookies.delete(COOKIE_NAME);
    return res;
  }

  // Sub-users: enforce permanently-admin-only routes, then per-user tab access
  if (user.role === 'sub') {
    const allowedTabs = (user.allowedTabs ?? DEFAULT_SUB_TABS) as TabKey[];
    const fallbackRoute = CONFIGURABLE_TABS
      .map(t => t.key)
      .filter((k): k is TabKey => allowedTabs.includes(k))
      .map(k => TAB_ROUTES[k][0])[0];

    if (SUB_BLOCKED.some(p => pathname.startsWith(p))) {
      return NextResponse.redirect(new URL(fallbackRoute ?? '/login', request.url));
    }

    const matchedTab = matchTab(pathname);
    if (matchedTab && !allowedTabs.includes(matchedTab)) {
      return NextResponse.redirect(new URL(fallbackRoute ?? '/login', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
