// Cluster addresses and endpoints. Every value comes from the environment with the devnet
// deployment as the fallback (configs/devnet.json), so a mainnet build only changes env.
import { PublicKey } from "@solana/web3.js";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8841";
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
export const EXPLORER = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`}`;

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
};
/** Meteora's DAMM v2 configs for DBC migrations, by the config's migration fee option (0-5 fixed fees, 6 customizable). */
export const DAMM_V2_MIGRATION_CONFIGS = [
  "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd", "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k", "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
  "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq", "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD", "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u", "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
].map((k) => new PublicKey(k));
export const DAMM_V2_CUSTOMIZABLE_CONFIG = DAMM_V2_MIGRATION_CONFIGS[6];
