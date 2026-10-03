import { ADDRESSES, CLUSTER } from "./addresses";
import { quoteAsset, WSOL } from "./quotes";

export type LaunchPresetId = "standard" | "long" | "flat" | "exp" | "stockUsdc" | "stockXstock";
const simple = "M4 54 C35 53 55 47 72 37 S99 15 116 4";
/** Config and quote addresses must both be available on the selected network.
 * Exponential and stock paths sample their configs: net quote raised horizontally, price vertically. */
export const LAUNCH_PRESETS = [
  { id: "standard", config: CLUSTER === "devnet" || process.env.NEXT_PUBLIC_PLAIN_CONFIG ? ADDRESSES.plainConfig : null, quoteMint: ADDRESSES.quoteMints.wsol, curve: simple },
  { id: "long", config: ADDRESSES.presets.long, quoteMint: ADDRESSES.quoteMints.wsol, curve: "M4 54 C36 53 66 51 82 40 S104 13 116 4" },
  { id: "flat", config: ADDRESSES.presets.flat, quoteMint: ADDRESSES.quoteMints.wsol, curve: "M4 54 C18 42 24 26 38 24 L90 21 Q108 20 116 4" },
  { id: "exp", config: ADDRESSES.presets.exp, quoteMint: ADDRESSES.quoteMints.wsol, curve: "M4.00 54.00 L23.93 53.24 L40.49 52.34 L54.27 51.30 L65.72 50.09 L75.23 48.66 L83.15 47.00 L89.73 45.06 L95.20 42.80 L99.74 40.15 L103.52 37.06 L106.67 33.45 L109.28 29.24 L111.45 24.32 L113.25 18.56 L114.75 11.85 L116.00 4.00" },
  { id: "stockUsdc", config: ADDRESSES.presets.stockUsdc, quoteMint: ADDRESSES.quoteMints.usdc, curve: simple },
  { id: "stockXstock", config: ADDRESSES.presets.stockXstock, quoteMint: ADDRESSES.quoteMints.stock, curve: "M4.00 54.00 L4.61 53.01 L5.40 51.88 L6.40 50.59 L7.69 49.13 L9.34 47.46 L11.45 45.56 L14.15 43.40 L17.61 40.94 L22.04 38.14 L27.71 34.94 L34.97 31.31 L44.28 27.17 L56.19 22.45 L71.45 17.08 L90.98 10.96 L116.00 4.00" },
].map(p => ({ ...p, id: p.id as LaunchPresetId, config: p.quoteMint ? p.config : null, quote: quoteAsset(p.quoteMint?.toBase58()), native: p.quoteMint?.toBase58() === WSOL }));
