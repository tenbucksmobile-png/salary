import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, COOKIE_NAME } from '@/lib/auth';

const SUB_BLOCKED = [
  '/dashboard/methods',
  '/dashboard/salary-review',
  '/dashboard/reports',
  '/dashboard/reconciliation',
  '/dashboard/access',
  '/dashboard/settings',
];

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

  // Sub-users: redirect blocked routes to employees
  if (user.role === 'sub') {
    const blocked =
      pathname === '/dashboard' ||
      SUB_BLOCKED.some(p => pathname.startsWith(p));
    if (blocked) {
      return NextResponse.redirect(new URL('/dashboard/employees', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
