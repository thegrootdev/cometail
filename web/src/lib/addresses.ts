// Cluster addresses and endpoints. Every value comes from the environment with the devnet
// deployment as the fallback (configs/devnet.json), so a mainnet build only changes env.
import { PublicKey } from "@solana/web3.js";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8841";
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
export const EXPLORER = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`}`;

function presetKey(value: string | undefined, devnetDefault: string): PublicKey | null {
  const address = value || ((process.env.NEXT_PUBLIC_CLUSTER ?? "devnet") !== "mainnet-beta" ? devnetDefault : null);
  if (!address) return null;
  try { return new PublicKey(address); } catch { return null; }
}
// The admin wallet (program upgrade authority and protocol admin) and the keeper hot key's public key;
// only the /admin/init page reads them, to build and check init_protocol for the owner's wallet.
export const ADMIN = presetKey(process.env.NEXT_PUBLIC_ADMIN, "3eBuya2rggMkpqJC4jM9vJo2u91njEWTuH7AV4RnNNEC");
export const KEEPER = presetKey(process.env.NEXT_PUBLIC_KEEPER, "A4iqXrFHjjpDzKbzHgwpeCMbYVFSdVeK5eHkpLe32gKz");
export const ADDRESSES = {
  protocol: new PublicKey(process.env.NEXT_PUBLIC_PROTOCOL ?? "3FrYZjy6uax82FqWVASL8GUQNM1DnRJ7UZU18cZbLHFR"),
  // devnet carries small-threshold configs with the presets' economics (configs/devnet.json, e2e), so curves fill with half a SOL
  plainConfig: new PublicKey(process.env.NEXT_PUBLIC_PLAIN_CONFIG ?? "8aoFV3oVKVBuJsh7vnEKhUhR8C5D48HsjLHoVZt6WsBF"),
  streamConfigs: [
    new PublicKey(process.env.NEXT_PUBLIC_STREAM_CONFIG_25 ?? "FhErNG8JK8hXM8PdkwGsfnr8jqxGuQmEWLSYjDtFGuXk"),
    new PublicKey(process.env.NEXT_PUBLIC_STREAM_CONFIG_50 ?? "6CQ4fXLaSeR3UvgTUAffbetDuzXU4JUMjfG2KcFJFsuz"),
    new PublicKey(process.env.NEXT_PUBLIC_STREAM_CONFIG_75 ?? "H53ojWBqXmxbtcCLVzA2YRveaNvdL1CKS11Kcwxg1Psd"),
  ] as [PublicKey, PublicKey, PublicKey],
  treasury: new PublicKey(process.env.NEXT_PUBLIC_TREASURY ?? "JdMo3ektR8etAHpYMiCMZnkPAoJ5djhf1eGaJBMni9H"),
  // the launch presets beyond Standard (configs/*.json; devnet addresses from configs/devnet.json).
  // Mainnet needs its own explicit addresses: a devnet address never crosses clusters.
  presets: {
    long: presetKey(process.env.NEXT_PUBLIC_LONG_CONFIG, "8cUQqkMkb7pU5LXdEBVtDgQoyAa77n388DGp7EfhBh6o"),
    flat: presetKey(process.env.NEXT_PUBLIC_FLAT_CONFIG, "8LtiCkfxkGzRkNLCQHc4ohudp3PxRNHbSCxHFkv5jin4"),
    exp: presetKey(process.env.NEXT_PUBLIC_EXP_CONFIG, "13mkYqFj1MU1DX8XP5VmnWpwjmdnqymxFsfeF3zKdNPf"),
    stockUsdc: presetKey(process.env.NEXT_PUBLIC_STOCK_USDC_CONFIG, "3SGJgHzALLPm15owz5Tw83SQdaBzd8AoSFyMZHy3NxBe"),
    stockXstock: presetKey(process.env.NEXT_PUBLIC_STOCK_XSTOCK_CONFIG, "AKQKx6QymFZ3A8y7QfBdNxnkdCFGMLVFBU1Dkpe9LQNa"),
    // coins paired with $COMETAIL (configs/paired.json): quote $COMETAIL, bought and sold with SOL through COMETAIL_POOL
    paired: presetKey(process.env.NEXT_PUBLIC_PAIRED_CONFIG, ""),
  },
  quoteMints: {
    wsol: new PublicKey("So11111111111111111111111111111111111111112"),
    usdc: presetKey(process.env.NEXT_PUBLIC_QUOTE_USDC, "9YSXk1YcKXHcTodgu4MuvKdRu7kW64Af61cKERH2Wtcd"),
    stock: presetKey(process.env.NEXT_PUBLIC_QUOTE_STOCK, "BN6zukGJEUGDCBgjYJxyDNs7KubMKeJVjS6RyfNBcXAN"),
  },
};
/** $COMETAIL's graduated DAMM v2 pool: the pool the burn program buys on (set at its setup; empty until known). */
export const COMETAIL_POOL = presetKey(process.env.NEXT_PUBLIC_COMETAIL_POOL, "");
/** Launch configs from before the burn program (their fees are claimed on /admin/fees with the 50% transfer). */
export const LEGACY_CONFIGS: { label: string; config: PublicKey }[] = (process.env.NEXT_PUBLIC_LEGACY_CONFIGS ?? "").split(",").map((x) => x.trim()).filter(Boolean)
  .map((entry) => { const [label, key] = entry.includes("=") ? entry.split("=") : ["older", entry]; try { return { label: `${label} (older)`, config: new PublicKey(key) }; } catch { return null; } })
  .filter((x): x is { label: string; config: PublicKey } => !!x);
/** The protocol's own token, pinned at the top of Explore and the home page once it is live (empty until then). */
export const OFFICIAL_MINT = presetKey(process.env.NEXT_PUBLIC_OFFICIAL_MINT, "");
/** Mints kept out of the Explore list and the home page, and out of every count and total those pages
 *  show, so nothing there refers to a coin that is not shown: their token and vault pages stay reachable
 *  by link, and the indexer, the API and /api/metrics are untouched; a comma-separated list. */
export const HIDDEN_MINTS = new Set((process.env.NEXT_PUBLIC_HIDDEN_MINTS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
export const isListed = (mint: string) => !HIDDEN_MINTS.has(mint);
/** Hidden wins over official: a mint in both lists is hidden everywhere. */
export const isOfficial = (mint: string) => !!OFFICIAL_MINT && OFFICIAL_MINT.toBase58() === mint && isListed(mint);
/** Meteora's DAMM v2 configs for DBC migrations, by the config's migration fee option (0-5 fixed fees, 6 customizable). */
export const DAMM_V2_MIGRATION_CONFIGS = [
  "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd", "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k", "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
  "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq", "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD", "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u", "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
].map((k) => new PublicKey(k));
export const DAMM_V2_CUSTOMIZABLE_CONFIG = DAMM_V2_MIGRATION_CONFIGS[6];
