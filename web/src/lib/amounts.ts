// Exact decimal parsing and display of on-chain amounts. Nothing here goes through floating point
// on its way to a transaction: a typed amount becomes an integer of base units or null.

/** "1.5" with 9 decimals -> 1_500_000_000n; empty, malformed or too precise -> null. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  const m = /^(\d{1,18})(?:\.(\d*))?$|^\.(\d+)$/.exec(t);
  if (!m) return null;
  const whole = m[1] ?? "0";
  const frac = m[2] ?? m[3] ?? "";
  if (frac.length > decimals) return null;
  const scale = 10n ** BigInt(decimals);
  const fracUnits = frac ? BigInt(frac.padEnd(decimals, "0")) : 0n;
  return BigInt(whole) * scale + fracUnits;
}

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 100_000_000_000_000n with 6 decimals -> "100,000,000"; with a ticker -> "100,000,000 SMILE".
 *  Fractions are cut to `maxFraction` places (rounded down, so a balance is never overstated) and
 *  trailing zeros are dropped. */
export function formatAmount(raw: bigint, decimals: number, options: { ticker?: string | null; maxFraction?: number } = {}): string {
  const { ticker, maxFraction = decimals >= 9 ? 4 : 2 } = options;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const text = `${negative ? "-" : ""}${group(whole.toString())}${frac ? `.${frac}` : ""}`;
  return ticker ? `${text} ${ticker}` : text;
}

/** The plain decimal string an input holds for a raw amount: no grouping, no trailing zeros. */
export function inputValue(raw: bigint, decimals: number): string {
  if (raw <= 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  const frac = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${raw / scale}${frac ? `.${frac}` : ""}`;
}

/** A share of a balance in base units (25, 50, 75, 100 percent). */
export function share(raw: bigint, percent: number): bigint {
  return (raw * BigInt(percent)) / 100n;
}

/** What a wallet can spend after keeping `reserve` base units back for fees; never negative. */
export function spendable(balance: bigint | null, reserve: bigint): bigint | null {
  if (balance === null) return null;
  const left = balance - reserve;
  return left > 0n ? left : 0n;
}
