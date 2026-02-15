export function parseNumber(value: string): number {
  const parsed = parseInt(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

export function parsePositiveNumber(value: string, fieldName: string = "number"): number {
  const parsed = parseNumber(value);
  if (parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value}. ${fieldName} must be greater than 0.`);
  }
  return parsed;
}
