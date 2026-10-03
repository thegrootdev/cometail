"use client";
import { PublicKey } from "@solana/web3.js";
import { metadataProofMessage } from "./metadata-proof";
import { experience as copy, failures } from "@/content/cometail";
import { DesignedError } from "./errors";
export async function uploadIdentity(a: {
  name: string;
  symbol: string;
  description: string;
  image: File;
  owner: PublicKey;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
  /** Optional socials (https); the form validates them, the route again. */
  links?: { x?: string; telegram?: string; discord?: string; website?: string };
}) {
  if (!a.signMessage) throw new DesignedError(copy.messageRequired);
  const encoder = new TextEncoder();
  if (
    !a.name.trim() ||
    !a.symbol.trim() ||
    encoder.encode(a.name.trim()).length > 32 ||
    encoder.encode(a.symbol.trim()).length > 10
  )
    throw new DesignedError(copy.identityLimit);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    await a.image.arrayBuffer(),
  );
  const intent = {
    owner: a.owner.toBase58(),
    name: a.name.trim(),
    symbol: a.symbol.trim(),
    description: a.description.trim(),
    imageHash: Array.from(new Uint8Array(hash), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join(""),
    issuedAt: Date.now(),
    origin: window.location.origin,
    ...(a.links && Object.values(a.links).some(Boolean) ? { links: Object.fromEntries(Object.entries(a.links).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v!.trim()])) } : {}),
  };
  const signature = await a.signMessage(
    new TextEncoder().encode(metadataProofMessage(intent)),
  );
  const body = new FormData();
  body.set("image", a.image);
  body.set("intent", JSON.stringify(intent));
  body.set("signature", btoa(String.fromCharCode(...signature)));
  const response = await fetch("/api/metadata", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(45_000),
  });
  // an HTML error page, a proxy page or an empty body is not an answer from the route
  let result: { uri?: string; image?: string; error?: string };
  try { result = await response.json(); } catch { throw new DesignedError(failures.serviceBadResponse); }
  if (!response.ok || typeof result.uri !== "string" || typeof result.image !== "string") throw new DesignedError(typeof result.error === "string" && result.error ? result.error : copy.uploadUnavailable);
  return result as { uri: string; image: string };
}
