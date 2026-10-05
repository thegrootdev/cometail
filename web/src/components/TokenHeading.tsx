"use client";
import { TokenAvatar } from "./Experience";
import { identity as copy } from "@/content/cometail";
import { tokenForMint, type TokenIdentity, tickerText } from "@/lib/token-display";
export function TokenHeading({
  token,
  mint,
  large = false,
}: {
  token?: TokenIdentity | null;
  mint?: string | null;
  large?: boolean;
}) {
  const known = mint ? tokenForMint(token, mint) : (token ?? null);
  return (
    <span className="token-heading">
      <TokenAvatar
        seed={mint || known?.mint || "pending"}
        image={known?.imageUrl || undefined}
        size={large ? "large" : "normal"}
      />
      <span className="token-heading-text">
        <strong>{known?.name?.trim() || copy.pendingName}</strong>
        <small>
          {tickerText(known?.symbol) || copy.pendingSymbol}
        </small>
      </span>
    </span>
  );
}
