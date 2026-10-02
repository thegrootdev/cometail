"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { nav, product, experience as copy } from "@/content/cometail";
import { CLUSTER } from "@/lib/addresses";
const WalletButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  {
    ssr: false,
    loading: () => (
      <button className="wallet-placeholder" disabled>
        {copy.connect}
      </button>
    ),
  },
);
export function ConnectWallet() {
  return <WalletButton />;
}
export function Shell({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  const path = usePathname();
  const links = [
    { href: "/sky", label: nav.sky, mark: "✧" },
    { href: "/launch", label: nav.launch, mark: "↗" },
    { href: "/sell", label: nav.sell, mark: "⌁" },
    { href: "/portfolio", label: nav.portfolio, mark: "◌" },
  ];
  return (
    <div className="site-frame">
      <a className="skip-link" href="#content">
        {copy.skip}
      </a>
      <header className="site-header">
        <Link href="/" className="brand-link" aria-label={product.name}>
          <img src="/brand/symbol.svg" alt="" width="36" height="36" />
          <img
            className="wordmark"
            src="/brand/wordmark.svg"
            alt={product.name}
            width="150"
            height="30"
          />
        </Link>
        <nav className="desktop-nav" aria-label={copy.menu}>
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={path === l.href ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="header-right">
          {CLUSTER !== "mainnet-beta" && (
            <span className="network-badge" title={product.clusterNote}>
              <i />
              {CLUSTER === "devnet" ? product.devnetBadge : CLUSTER}
            </span>
          )}
          <ConnectWallet />
        </div>
      </header>
      <main id="content" className={`page-content ${wide ? "page-wide" : ""}`}>
        {children}
      </main>
      <footer className="site-footer">
        <div>
          <span className="footer-signature">{copy.footer}</span>
          <span className="micro">{product.domain}</span>
        </div>
        <span className="built-on">
          <span aria-hidden="true">✳</span> {product.builtOn}
        </span>
      </footer>
      <nav className="mobile-nav" aria-label={copy.menu}>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={path === l.href ? "page" : undefined}
          >
            <span aria-hidden="true">{l.mark}</span>
            {l.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && <h2 className="panel-heading">{title}</h2>}
      {children}
    </section>
  );
}
export function Stat({
  label,
  value,
  tone = "ion",
}: {
  label: string;
  value: string;
  tone?: "ion" | "dust" | "plain";
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
