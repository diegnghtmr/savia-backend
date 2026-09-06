export function escapeCsvField(
  value: unknown,
  neutralize: (value: string) => string = (input) => input,
): string {
  return `"${neutralize(String(value ?? '')).replaceAll('"', '""')}"`;
}
