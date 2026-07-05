export const COOKIE_NAME    = 'ihg-salary-auth';
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Tabs a sub user's access can be individually granted or revoked for.
// Everything else (Dashboard, Salary Review, Reports, Methods, Access) stays
// permanently admin-only regardless of this list.
export const CONFIGURABLE_TABS = [
  { key: 'employees',      label: 'Employees' },
  { key: 'import',         label: 'Import HR List' },
  { key: 'reconciliation', label: 'Reconciliation' },
] as const;
export type TabKey = typeof CONFIGURABLE_TABS[number]['key'];

// Pre-migration-016 sub users have no `allowed_tabs` row yet, and an
// already-issued cookie won't carry the field until next login — both cases
// fall back to the tabs every sub user had before this became configurable.
export const DEFAULT_SUB_TABS: TabKey[] = ['employees', 'import', 'reconciliation'];

export interface UserContext {
  id: string;
  username: string;
  role: 'admin' | 'sub';
  hotelIds: string[] | null;    // null = all hotels (admin)
  allowedTabs: string[] | null; // null = use DEFAULT_SUB_TABS (sub) / unused (admin)
}

// ── Encoding helpers (Edge-compatible, no Buffer) ─────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64Url(str: string): Uint8Array {
  const pad = (4 - (str.length % 4)) % 4;
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacHex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(process.env.COOKIE_SECRET ?? ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Hash a password for storage. Uses COOKIE_SECRET as pepper — server-side only. */
export async function hashPassword(username: string, password: string): Promise<string> {
  return hmacHex(`${username}:${password}`);
}

/** Encode a UserContext into a signed cookie value. */
export async function makeToken(user: UserContext): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(user));
  const payload = toBase64Url(bytes);
  const sig = await hmacHex(payload);
  return `${payload}.${sig}`;
}

/** Verify a cookie value and return the UserContext, or null if invalid. */
export async function verifyToken(token: string): Promise<UserContext | null> {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  const expected = await hmacHex(payload);
  if (sig !== expected) return null;
  try {
    const bytes = fromBase64Url(payload);
    const json  = new TextDecoder().decode(bytes);
    return JSON.parse(json) as UserContext;
  } catch {
    return null;
  }
}
