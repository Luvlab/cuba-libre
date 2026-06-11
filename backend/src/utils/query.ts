/**
 * Safe query/param helpers for Express 5
 * req.query and req.params can be string | string[] | ParsedQs etc.
 */

/** Extract a single string from a query param, or undefined */
export function qs(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) return String(val[0]);
  if (typeof val === 'object') return undefined;
  const s = String(val);
  return s === 'undefined' ? undefined : s;
}

/** Extract a required string param (falls back to empty string) */
export function qsr(val: unknown): string {
  return qs(val) ?? '';
}

/** Parse a query param as an integer */
export function qsn(val: unknown, fallback = 0): number {
  const n = parseInt(String(val), 10);
  return isNaN(n) ? fallback : n;
}
