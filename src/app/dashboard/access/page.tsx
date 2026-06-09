'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { sortHotels } from '@/lib/utils';
import { Hotel } from '@/types/database';
import { AppUser } from '@/types/database';
import { Plus, Pencil, Trash2, CheckCircle, X, Eye, EyeOff } from 'lucide-react';

interface FormState {
  id: string;
  username: string;
  password: string;
  role: 'admin' | 'sub';
  hotelIds: Set<string>;
}

const EMPTY_FORM: FormState = {
  id: '',
  username: '',
  password: '',
  role: 'sub',
  hotelIds: new Set(),
};

export default function AccessPage() {
  const sb = createClient();
  const [users,   setUsers]   = useState<AppUser[]>([]);
  const [hotels,  setHotels]  = useState<Hotel[]>([]);
  const [form,    setForm]    = useState<FormState | null>(null);
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [error,      setError]      = useState('');
  const [showPwd,    setShowPwd]    = useState(false);

  useEffect(() => {
    Promise.all([
      sb.from('users').select('*').order('created_at'),
      sb.from('hotels').select('*'),
    ]).then(([{ data: u }, { data: h }]) => {
      setUsers((u ?? []) as AppUser[]);
      setHotels(sortHotels((h ?? []) as Hotel[]));
    });
  }, []);

  function openAdd() {
    setForm({ ...EMPTY_FORM, hotelIds: new Set() });
    setError('');
    setShowPwd(false);
  }

  function openEdit(u: AppUser) {
    setForm({
      id:       u.id,
      username: u.username,
      password: '',
      role:     u.role,
      hotelIds: new Set(u.hotel_ids ?? []),
    });
    setError('');
    setShowPwd(false);
  }

  function closeForm() { setForm(null); setError(''); setShowPwd(false); }

  function toggleHotel(id: string) {
    if (!form) return;
    const next = new Set(form.hotelIds);
    next.has(id) ? next.delete(id) : next.add(id);
    setForm({ ...form, hotelIds: next });
  }

  async function save() {
    if (!form) return;
    if (!form.username.trim()) { setError('Username is required'); return; }
    if (!form.id && !form.password) { setError('Password is required for new users'); return; }
    setSaving(true);
    setError('');

    const body = {
      id:       form.id || undefined,
      username: form.username.trim(),
      password: form.password || undefined,
      role:     form.role,
      hotelIds: form.role === 'admin' ? null : [...form.hotelIds],
    };

    const res = await fetch('/api/access', {
      method:  form.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) { setError(data.error ?? 'Save failed'); setSaving(false); return; }

    // Refresh user list
    const { data: updated } = await sb.from('users').select('*').order('created_at');
    setUsers((updated ?? []) as AppUser[]);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    closeForm();
  }

  async function deleteUser(u: AppUser) {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    const res = await fetch('/api/access', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: u.id }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error ?? 'Delete failed'); return; }
    setUsers(prev => prev.filter(x => x.id !== u.id));
  }

  function hotelLabel(u: AppUser): string {
    if (u.role === 'admin' || !u.hotel_ids?.length) return 'All properties';
    return u.hotel_ids
      .map(id => hotels.find(h => h.id === id)?.short_code ?? id)
      .join(', ');
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Access Management</h1>
          <p className="text-muted-foreground text-sm mt-1">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add User
        </button>
      </div>

      {/* User list */}
      <div className="bg-white rounded-xl border overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Username</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Role</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Hotel Access</th>
              <th className="px-4 py-3 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground text-sm">No users yet</td></tr>
            )}
            {users.map(u => (
              <tr key={u.id} className="border-b last:border-0 hover:bg-muted/20">
                <td className="px-4 py-3 font-medium">{u.username}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    u.role === 'admin'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}>
                    {u.role === 'admin' ? 'Admin' : 'Sub User'}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground text-xs">{hotelLabel(u)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    <button onClick={() => openEdit(u)} className="text-muted-foreground hover:text-foreground transition-colors" title="Edit">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => deleteUser(u)} className="text-muted-foreground hover:text-red-500 transition-colors" title="Delete">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add / Edit form */}
      {form && (
        <div className="bg-white rounded-xl border p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-semibold text-base">{form.id ? 'Edit User' : 'Add User'}</h2>
            <button onClick={closeForm} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4">
            {/* Username */}
            <div>
              <label className="text-sm font-medium">Username</label>
              <input
                value={form.username}
                onChange={e => setForm({ ...form, username: e.target.value })}
                placeholder="e.g. jane"
                className="mt-1 w-full rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Password */}
            <div>
              <label className="text-sm font-medium">
                Password {form.id && <span className="text-muted-foreground font-normal">(leave blank to keep current)</span>}
              </label>
              <div className="relative mt-1">
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  placeholder={form.id ? '••••••••' : 'Enter password'}
                  className="w-full rounded-md border border-input px-3 py-2 pr-9 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                  title={showPwd ? 'Hide password' : 'Show password'}
                >
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Role */}
            <div>
              <label className="text-sm font-medium block mb-2">Role</label>
              <div className="flex items-center gap-6">
                {(['admin', 'sub'] as const).map(r => (
                  <label key={r} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      checked={form.role === r}
                      onChange={() => setForm({ ...form, role: r })}
                      className="accent-primary"
                    />
                    <span className="text-sm">{r === 'admin' ? 'Admin' : 'Sub User'}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Hotel access (sub only) */}
            <div className={form.role === 'admin' ? 'opacity-40 pointer-events-none' : ''}>
              <label className="text-sm font-medium block mb-2">
                Hotel Access
                {form.role === 'admin' && <span className="text-muted-foreground font-normal ml-2">— all properties (Admin)</span>}
              </label>
              <div className="space-y-1.5">
                {hotels.map(h => (
                  <label key={h.id} className="flex items-center gap-2.5 cursor-pointer hover:bg-muted/30 rounded px-2 py-1">
                    <input
                      type="checkbox"
                      checked={form.hotelIds.has(h.id)}
                      onChange={() => toggleHotel(h.id)}
                      className="rounded accent-primary"
                    />
                    <span className="text-sm">{h.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{h.short_code}</span>
                  </label>
                ))}
              </div>
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={closeForm}
                className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saved
                  ? <><CheckCircle className="h-4 w-4" /> Saved</>
                  : saving ? 'Saving…' : 'Save User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
