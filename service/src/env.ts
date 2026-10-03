export function parseOptionalPositiveNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

// An ISO-8601 timestamp of any known weekly-reset moment (past or future).
// Invalid or unset yields null, which makes the caller fall back to
// calendar-week aggregation rather than failing to start.
export function parseOptionalDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseRequiredPositiveInt(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got: ${JSON.stringify(value)}`);
  }
  return parsed;
}

// An on/off switch. Unset (or blank) means off; anything other than a clear
// yes/no throws, so a typo like "ture" fails loud instead of silently
// leaving the feature off.
export function parseFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  throw new Error(`${name} must be 1/true or 0/false, got: ${JSON.stringify(value)}`);
}
