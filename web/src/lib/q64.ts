// Price cap encoding: SOL per whole token <-> Q64 lamports per raw unit, exact in integers.
import BN from "bn.js";

const Q64 = new BN(1).shln(64);
const LAMPORTS_PER_SOL = new BN(1_000_000_000);

/** Parse a decimal string like "0.0006" into { digits, scale }: value = digits / 10^scale. */
export function parseDecimal(s: string): { digits: BN; scale: number } | null {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? "";
  return { digits: new BN(m[1] + frac), scale: frac.length };
}

/** The largest Q64 price not above the user's maximum (floor), or null for an invalid or non-positive input. */
export function capToQ64(solPerToken: string, tokenDecimals: number): BN | null {
  const d = parseDecimal(solPerToken);
  if (!d || d.digits.isZero()) return null;
  // lamports per raw unit = sol * 1e9 / 10^decimals; Q64 = that * 2^64, all floored once at the end
  const num = d.digits.mul(LAMPORTS_PER_SOL).mul(Q64);
  const den = new BN(10).pow(new BN(d.scale + tokenDecimals));
  const q = num.div(den);
  return q.isZero() ? null : q;
}

/** Q64 lamports per raw unit -> SOL per whole token, as a display string (truncated, never rounded up). */
export function q64ToCap(q64: BN | string, tokenDecimals: number, digits = 9): string {
  const q = new BN(q64.toString());
  // sol per token = q / 2^64 * 10^decimals / 1e9; print with `digits` decimals by scaling first
  const scaled = q.mul(new BN(10).pow(new BN(tokenDecimals + digits))).div(LAMPORTS_PER_SOL).div(Q64);
  const s = scaled.toString().padStart(digits + 1, "0");
  const int = s.slice(0, -digits), frac = s.slice(-digits).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
