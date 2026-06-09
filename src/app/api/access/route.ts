import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { hashPassword, verifyToken, COOKIE_NAME } from '@/lib/auth';

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value ?? '';
  const user  = token ? await verifyToken(token) : null;
  return user?.role === 'admin' ? user : null;
}

// Create user
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { username, password, role, hotelIds } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
  }

  const hash = await hashPassword(username, password);
  const sb   = await createClient();
  const { data, error } = await sb
    .from('users')
    .insert({
      username,
      password_hash: hash,
      role: role ?? 'sub',
      hotel_ids: role === 'admin' ? null : (hotelIds ?? []),
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

// Update user
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id, username, password, role, hotelIds } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const sb      = await createClient();
  const updates: Record<string, unknown> = {
    username,
    role,
    hotel_ids: role === 'admin' ? null : (hotelIds ?? []),
  };
  if (password) updates.password_hash = await hashPassword(username, password);

  const { data, error } = await sb
    .from('users')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

// Delete user
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  if (id === admin.id) return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 });

  const sb = await createClient();
  const { error } = await sb.from('users').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
