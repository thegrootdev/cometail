"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { nav, product } from "@/content/cometail";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className={`mx-auto flex min-h-screen ${wide ? "max-w-7xl" : "max-w-6xl"} flex-col px-4 sm:px-6`}>
      <header className="flex items-center justify-between gap-4 py-6">
        <Link href="/" className="flex items-center gap-3">
          <img src="/brand/symbol.svg" alt="" width={36} height={36} />
          <span className="text-lg font-extrabold tracking-[0.2em]">{product.name}</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm text-starlight/80">
          <Link href="/sky">{nav.sky}</Link>
          <Link href="/launch" className="hidden sm:inline">{nav.launch}</Link>
          <Link href="/sell" className="hidden sm:inline">{nav.sell}</Link>
          <Link href="/portfolio">{nav.portfolio}</Link>
          <WalletButton className="!rounded-full !bg-ion !text-night !font-semibold !h-10" />
        </nav>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="flex items-center justify-between py-8 text-sm text-starlight/60">
        <span>{product.domain}</span>
        <span className="glass rounded-full px-3 py-1">{product.builtOn}</span>
      </footer>
    </main>
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`glass rounded-2xl p-5 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-starlight/60">{title}</h2>}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone = "ion" }: { label: string; value: string; tone?: "ion" | "dust" | "plain" }) {
  const color = tone === "dust" ? "text-dust" : tone === "ion" ? "text-ion" : "text-starlight";
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-starlight/50">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
    </div>
  );
}
