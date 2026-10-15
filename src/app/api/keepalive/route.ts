import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Daily Vercel Cron target (see vercel.json). Runs one tiny real query so the
// free-tier Supabase project registers activity and isn't paused between
// month-end sessions. Vercel sends `Authorization: Bearer $CRON_SECRET`;
// anything else is rejected.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sb = await createClient();
  const { data, error } = await sb.from('hotels').select('id').limit(1);
  if (error) {
    console.error('keepalive query failed', error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rows: data?.length ?? 0, at: new Date().toISOString() });
}
