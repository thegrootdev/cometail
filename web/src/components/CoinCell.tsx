"use client";
// A coin as a table shows it: its logo, name and ticker from the coin's metadata; the shortened mint
// only where the metadata has no name or ticker.
import Link from "next/link";
import { TokenAvatar } from "./Experience";
import { short } from "@/lib/format";
import { shownName, shownSymbol, tickerText } from "@/lib/token-display";

export function CoinCell({ mint, name: rawName, symbol: rawSymbol, imageUrl, href }: { mint: string; name: string | null; symbol: string | null; imageUrl: string | null; href: string }) {
  const name = shownName(mint, rawName), symbol = shownSymbol(mint, rawSymbol);
  const title = name?.trim() || tickerText(symbol) || short(mint);
  const sub = name?.trim() ? tickerText(symbol) || short(mint) : short(mint);
  return (
    <Link className="token-cell coin-cell" href={href}>
      <TokenAvatar seed={mint} image={imageUrl ?? undefined} />
      <span className="coin-cell-text"><strong>{title}</strong><small>{sub}</small></span>
    </Link>
  );
}
