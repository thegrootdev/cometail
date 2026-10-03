import { PublicKey } from "@solana/web3.js";
import { ADDRESSES, CLUSTER } from "./addresses";
import { quoteAsset, WSOL } from "./quotes";

export type LaunchPresetId = "standard" | "long" | "flat" | "stockUsdc" | "stockXstock";
const simple = "M4 54 C35 53 55 47 72 37 S99 15 116 4";
/** Config and quote addresses must both be available on the selected network. */
export const LAUNCH_PRESETS = [
  { id: "standard", config: CLUSTER === "devnet" || process.env.NEXT_PUBLIC_PLAIN_CONFIG ? ADDRESSES.plainConfig : null, quoteMint: ADDRESSES.quoteMints.wsol, curve: simple },
  { id: "long", config: ADDRESSES.presets.long, quoteMint: ADDRESSES.quoteMints.wsol, curve: "M4 54 C36 53 66 51 82 40 S104 13 116 4" },
  { id: "flat", config: ADDRESSES.presets.flat, quoteMint: ADDRESSES.quoteMints.wsol, curve: "M4 54 C18 42 24 26 38 24 L90 21 Q108 20 116 4" },
  { id: "stockUsdc", config: ADDRESSES.presets.stockUsdc, quoteMint: ADDRESSES.quoteMints.usdc, curve: simple },
  { id: "stockXstock", config: ADDRESSES.presets.stockXstock, quoteMint: ADDRESSES.quoteMints.stock, curve: simple },
].map(p => ({ ...p, id: p.id as LaunchPresetId, config: p.quoteMint ? p.config : null, quote: quoteAsset(p.quoteMint?.toBase58()), native: p.quoteMint?.toBase58() === WSOL }));
