import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'ihg-salary-auth';

async function expectedToken(): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(process.env.COOKIE_SECRET ?? ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(process.env.SITE_PASSWORD ?? ''));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/login') || pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }
  const cookie = request.cookies.get(COOKIE_NAME);
  if (!cookie?.value) return NextResponse.redirect(new URL('/login', request.url));
  const token = await expectedToken();
  if (cookie.value !== token) {
    const res = NextResponse.redirect(new URL('/login', request.url));
    res.cookies.delete(COOKIE_NAME);
    return res;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
