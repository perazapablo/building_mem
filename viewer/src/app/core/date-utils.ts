// Date formatting helpers. All timestamps from the backend are SQLite
// `datetime('now')` strings — "YYYY-MM-DD HH:MM:SS" in UTC, no `T`, no `Z`.
// This module parses that shape and renders it in the user's locale.
//
// Public API:
//   parseSqlUtc(s)   → Date | null
//   formatAbsolute(s, opts?) → e.g. "10 ago 2026, 22:27"
//   formatRelative(s)        → e.g. "hace 3 días"
//   formatFull(s)            → e.g. "10 ago 2026, 22:27 · hace 3 días"

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

const absFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function parseSqlUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  // Accept both "YYYY-MM-DD HH:MM:SS" (SQLite) and ISO with T/Z (JS).
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(s)
    ? s
    : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function formatAbsolute(s: string | null | undefined): string {
  const d = parseSqlUtc(s);
  return d ? absFmt.format(d) : '—';
}

export function formatRelative(s: string | null | undefined): string {
  const d = parseSqlUtc(s);
  if (!d) return '—';
  let diff = (d.getTime() - Date.now()) / 1000; // seconds, negative when in the past
  for (const { amount, unit } of DIVISIONS) {
    if (Math.abs(diff) < amount) return relFmt.format(Math.round(diff), unit);
    diff /= amount;
  }
  return relFmt.format(Math.round(diff), 'year');
}

export function formatFull(s: string | null | undefined): string {
  const d = parseSqlUtc(s);
  if (!d) return '—';
  return `${absFmt.format(d)} · ${formatRelative(s)}`;
}

// Age in whole days from now to the given timestamp. Negative if in the future.
export function ageDays(s: string | null | undefined): number {
  const d = parseSqlUtc(s);
  if (!d) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
