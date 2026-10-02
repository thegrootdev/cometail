// Cluster addresses and endpoints. Every value comes from the environment with the devnet
// deployment as the fallback (configs/devnet.json), so a mainnet build only changes env.
import { PublicKey } from "@solana/web3.js";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";
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
/** Meteora's customizable DAMM v2 config for DBC migrations (migration fee option 6). */
export const DAMM_V2_CUSTOMIZABLE_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
