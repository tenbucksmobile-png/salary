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
