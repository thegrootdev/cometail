// Pure checks for tests/mainnet/burn-configs.ts (review 133): before anything is simulated or sent, today's
// preset must match the planned parameters exactly (so the replacement cannot silently change economics),
// and a new config's bytes, simulated or created, must equal today's except the fee claimer.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { configParams, PresetName } from "../harness/dbc";
import { compareConfig } from "./readback";

export const CLAIMER_AT = 40; // PoolConfig.fee_claimer after the discriminator and quote_mint

/** Today's decoded preset against the parameters the replacement will be created with; [] when equal. */
export function todayMatchesPlan(todayDecoded: any, name: PresetName, todayFeeClaimer: string, leftoverReceiver: string): string[] {
  return compareConfig(todayDecoded, configParams(name), { quoteMint: NATIVE_MINT.toBase58(), quoteIs2022: false, feeClaimer: todayFeeClaimer, leftoverReceiver })
    .filter((c) => !c.ok).map((c) => `${c.what} ${c.detail}`);
}

/** Today's account and a new one: every byte equal except the fee claimer, which is the burn claimer; [] when so. */
export function sameExceptClaimer(today: Buffer, fresh: Buffer, claimer: PublicKey): string[] {
  if (today.length !== fresh.length) return [`sizes differ (${today.length} vs ${fresh.length})`];
  const diff = [...today.keys()].filter((i) => today[i] !== fresh[i] && (i < CLAIMER_AT || i >= CLAIMER_AT + 32));
  const out = diff.length ? [`bytes differ outside the fee claimer at offsets ${diff.slice(0, 8).join(",")}${diff.length > 8 ? "…" : ""}`] : [];
  if (!new PublicKey(fresh.subarray(CLAIMER_AT, CLAIMER_AT + 32)).equals(claimer)) out.push("fee claimer is not the burn claimer");
  return out;
}
