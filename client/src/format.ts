/** Small presentational helpers for the lab UI. No HTML string injection: use React text nodes. */

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'unknown';
  // Never abbreviate to K/M; full digits only. Locale grouping is presentational.
  return value.toLocaleString('en-US');
}

export function formatIso(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return 'unknown';
  return new Date(ts).toISOString();
}

export function formatGap(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSec}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 48) return `${hours}h ${remMin}m`;
  return `${Math.round(hours / 24)}d`;
}

export function formatPercentDiff(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatSignedDiff(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString('en-US')}`;
}