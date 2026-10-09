import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageTitles as t } from "@/content/cometail";

export const metadata: Metadata = { title: t.vault };

// an address that cannot be a Solana account is a real 404, not an empty page
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(vault)) notFound();
  return children;
}
