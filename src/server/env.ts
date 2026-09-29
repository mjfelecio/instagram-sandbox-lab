/**
 * Minimal .env loader for this experiment only. Loads from the experiment root
 * only — never from other repositories' environment files. Existing
 * process.env values win over file values.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export function loadEnvFromDir(dir: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const fileName of ['.env', '.env.local']) {
    const filePath = path.join(dir, fileName);
    if (!existsSync(filePath)) continue;
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    Object.assign(merged, parseEnvFile(text));
  }
  return merged;
}

/** Apply loaded values to process.env without overriding existing entries. */
export function applyEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined && value !== '') {
      process.env[key] = value;
    }
  }
}
