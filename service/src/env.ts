export function parseOptionalPositiveNumber(
  value: string | undefined,
): number | null {
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
    throw new Error(
      `${name} must be a positive number, got: ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}
