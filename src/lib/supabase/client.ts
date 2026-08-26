import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

// PostgREST caps every response at 1000 rows by default — a plain
// `.select('*')` on a table that has grown past that (salary_records
// crossed it in August 2026) silently truncates, dropping whichever rows
// don't fit rather than erroring. Confirmed live: the Employees page's
// unbounded salary_records fetch was missing freshly-imported rows purely
// because the table had grown past 1000 total records, making the page
// fall back to an employee's next-most-recent (older, stale) salary record
// with no indication anything was cut off. `build` must return a FRESH
// query each call — reusing an already-awaited builder across pages isn't
// supported by supabase-js.
export async function fetchAllRows<T>(
  build: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }> & { range: (from: number, to: number) => any },
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await build().range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}
