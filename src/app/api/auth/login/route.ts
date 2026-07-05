import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { hashPassword, makeToken, COOKIE_NAME, COOKIE_MAX_AGE, type UserContext } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
  }

  const sb = await createClient();

  // Bootstrap: if no users exist yet, first login auto-creates the admin
  const { count } = await sb.from('users').select('*', { count: 'exact', head: true });
  if (count === 0) {
    if (password !== process.env.SITE_PASSWORD) {
      return NextResponse.json({ error: 'Incorrect credentials' }, { status: 401 });
    }
    const hash = await hashPassword(username, password);
    const { data: newUser, error } = await sb
      .from('users')
      .insert({ username, password_hash: hash, role: 'admin', hotel_ids: null })
      .select()
      .single();
    if (error || !newUser) {
      return NextResponse.json({ error: 'Setup failed' }, { status: 500 });
    }
    return issueToken({ id: newUser.id, username: newUser.username, role: 'admin', hotelIds: null, allowedTabs: null });
  }

  // Normal login — look up by username, verify hash
  const { data: user } = await sb
    .from('users')
    .select('*')
    .eq('username', username)
    .maybeSingle();

  if (!user) {
    return NextResponse.json({ error: 'Incorrect credentials' }, { status: 401 });
  }

  const hash = await hashPassword(username, password);
  if (hash !== user.password_hash) {
    return NextResponse.json({ error: 'Incorrect credentials' }, { status: 401 });
  }

  const ctx: UserContext = {
    id: user.id,
    username: user.username,
    role: user.role as 'admin' | 'sub',
    hotelIds: user.hotel_ids ?? null,
    allowedTabs: user.allowed_tabs ?? null,
  };
  return issueToken(ctx);
}

async function issueToken(ctx: UserContext): Promise<NextResponse> {
  const token = await makeToken(ctx);
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
