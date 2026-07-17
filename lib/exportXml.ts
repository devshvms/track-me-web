export function escapeXml(value: unknown): string {
  return String(value ?? '').replace(/[<>&'\"]/g, (character) => {
    switch (character) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return character;
    }
  });
}

export function finiteCoordinate(value: unknown, fallback = 0): string {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? String(number) : String(fallback);
}

export function isoTimestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
