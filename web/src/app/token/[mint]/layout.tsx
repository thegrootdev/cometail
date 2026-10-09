import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { API_URL } from "@/lib/addresses";
import { shownName, shownSymbol, tickerText } from "@/lib/token-display";
import { pageTitles as t } from "@/content/cometail";

// The coin's name and ticker for the tab and for link previews, from the read API; a slow or missing answer
// falls back to a plain title rather than holding the page.
export async function generateMetadata({ params }: { params: Promise<{ mint: string }> }): Promise<Metadata> {
  const { mint } = await params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return { title: t.coin };
  try {
    const r = await fetch(`${API_URL}/api/tokens/${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(2500), next: { revalidate: 300 } });
    if (!r.ok) return { title: t.coin };
    const id = (await r.json())?.data?.identity;
    const name = shownName(mint, id?.name), ticker = tickerText(shownSymbol(mint, id?.symbol));
    const title = [name, ticker].filter(Boolean).join(" ") || t.coin;
    return { title, openGraph: { title } };
  } catch {
    return { title: t.coin };
  }
}

// an address that cannot be a Solana account is a real 404, not an empty page
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) notFound();
  return children;
}
