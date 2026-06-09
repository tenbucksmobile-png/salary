import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, COOKIE_NAME } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value ?? '';
  const user  = token ? await verifyToken(token) : null;
  if (!user) return NextResponse.json(null, { status: 401 });
  return NextResponse.json(user);
}
