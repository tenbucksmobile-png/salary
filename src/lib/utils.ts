import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtZAR(n: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(n);
}

const _numFmt = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });

export function fmtCurrency(n: number, country: string): string {
  const bw = country.toLowerCase().includes('botswana');
  return bw ? `P ${_numFmt.format(n)}` : fmtZAR(n);
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat('en-ZA').format(n);
}

export const MONTH_NAMES = [
  'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec',
];

const HOTEL_ORDER = ['african', 'indaba hotel', 'richards bay', 'gaborone', 'cfe', 'chobe', 'nata'];

export function hotelSortIndex(name: string): number {
  const lower = name.toLowerCase();
  const idx = HOTEL_ORDER.findIndex(kw => lower.includes(kw));
  return idx === -1 ? HOTEL_ORDER.length : idx;
}

// BURS-only hotels (currently just Pom Pom) are excluded by default from
// every hotel list app-wide — pass includeBursOnly to opt back in (the BURS
// page is the only caller that should).
export function sortHotels<T extends { name: string; is_burs_only?: boolean | null }>(
  hotels: T[],
  opts?: { includeBursOnly?: boolean },
): T[] {
  const visible = opts?.includeBursOnly ? hotels : hotels.filter(h => !h.is_burs_only);
  return [...visible].sort((a, b) => hotelSortIndex(a.name) - hotelSortIndex(b.name));
}
