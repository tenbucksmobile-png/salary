import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'ihg-salary-auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function makeToken(): Promise<string> {
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

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  if (!password || password !== process.env.SITE_PASSWORD) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }
  const token = await makeToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
  return res;
}
