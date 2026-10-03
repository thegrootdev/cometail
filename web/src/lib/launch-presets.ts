import { PublicKey } from "@solana/web3.js";
import { ADDRESSES, CLUSTER } from "./addresses";

export type LaunchPresetId = "standard" | "long" | "flat";
const devnet = CLUSTER === "devnet";
const configured = (value: string | undefined, fallback: string) => {
  const address = value || (devnet ? fallback : null);
  if (!address) return null;
  try { return new PublicKey(address); } catch { return null; }
};
/** Mainnet requires its own explicit config addresses; devnet addresses never cross clusters. */
export const LAUNCH_PRESETS: { id: LaunchPresetId; config: PublicKey | null; curve: string }[] = [
  { id: "standard", config: devnet || process.env.NEXT_PUBLIC_PLAIN_CONFIG ? ADDRESSES.plainConfig : null, curve: "M4 54 C35 53 55 47 72 37 S99 15 116 4" },
  { id: "long", config: configured(process.env.NEXT_PUBLIC_LONG_CONFIG, "8cUQqkMkb7pU5LXdEBVtDgQoyAa77n388DGp7EfhBh6o"), curve: "M4 54 C36 53 66 51 82 40 S104 13 116 4" },
  { id: "flat", config: configured(process.env.NEXT_PUBLIC_FLAT_CONFIG, "8LtiCkfxkGzRkNLCQHc4ohudp3PxRNHbSCxHFkv5jin4"), curve: "M4 54 C18 42 24 26 38 24 L90 21 Q108 20 116 4" },
];
