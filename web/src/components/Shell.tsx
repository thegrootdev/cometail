"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { nav, product, experience as copy } from "@/content/cometail";
import { PriceReference } from "./Money";
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
/** The project's social links as icon pills, sticker style, new tab. */
export function SocialPills() {
  return (
    <span className="social-pills">
      <a className="social-pill" href={product.x} target="_blank" rel="noopener noreferrer" aria-label={product.socialX} title={product.socialX}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214 -6.817L4.99 21.75H1.68l7.73 -8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
      </a>
      <a className="social-pill" href={product.github} target="_blank" rel="noopener noreferrer" aria-label={product.socialGithub} title={product.socialGithub}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59 .4 .07 .55 -.17 .55 -.38 0 -.19 -.01 -.82 -.01 -1.49 -2.01 .37 -2.53 -.49 -2.69 -.94 -.09 -.23 -.48 -.94 -.82 -1.13 -.28 -.15 -.68 -.52 -.01 -.53 .63 -.01 1.08 .58 1.23 .82 .72 1.21 1.87 .87 2.33 .66 .07 -.52 .28 -.87 .51 -1.07 -1.78 -.2 -3.64 -.89 -3.64 -3.95 0 -.87 .31 -1.59 .82 -2.15 -.08 -.2 -.36 -1.02 .08 -2.12 0 0 .67 -.21 2.2 .82 .64 -.18 1.32 -.27 2 -.27 .68 0 1.36 .09 2 .27 1.53 -1.04 2.2 -.82 2.2 -.82 .44 1.1 .16 1.92 .08 2.12 .51 .56 .82 1.27 .82 2.15 0 3.07 -1.87 3.75 -3.65 3.95 .29 .25 .54 .73 .54 1.48 0 1.07 -.01 1.93 -.01 2.2 0 .21 .15 .46 .55 .38A8.013 8.013 0 0016 8c0 -4.42 -3.58 -8 -8 -8z" /></svg>
      </a>
    </span>
  );
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
    { href: "/", label: nav.home, icon: "home" },
    { href: "/launch", label: nav.launch, icon: "launch" },
    { href: "/sell", label: nav.sell, icon: "sell" },
    { href: "/fees", label: nav.fees, icon: "fees" },
    { href: "/portfolio", label: nav.portfolio, icon: "portfolio" },
  ];
  const desktop = [...links.slice(0, 1), { href: "/sky", label: nav.sky, icon: "" }, ...links.slice(1)];
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
          {desktop.map((l) => (
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
      <main id="content" tabIndex={-1} className={`page-content ${wide ? "page-wide" : ""}`}>
        {children}
        <div className="page-price-reference"><PriceReference /></div>
      </main>
      <footer className="site-footer">
        <div>
          <span className="footer-signature">{copy.footer}</span>
          <span className="micro">{product.domain}</span>
          <span className="footer-links micro">
            <Link href="/stats">{nav.stats}</Link>
            <Link href="/stats#verified">{nav.verified}</Link>
            <Link href="/tails">{nav.tails}</Link>
            <a href={product.github} target="_blank" rel="noopener noreferrer">{nav.source}</a>
          </span>
        </div>
        <span className="footer-right">
          <SocialPills />
          <span className="built-on">
            <span aria-hidden="true">✳</span> {product.builtOn}
          </span>
        </span>
      </footer>
      <nav className="mobile-nav" aria-label={copy.menu}>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={path === l.href ? "page" : undefined}
          >
            <TabIcon name={l.icon} />
            {l.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
/** Line icons for the phone tab bar: thin strokes that sit on the glass. */
function TabIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="M4 11.5 12 5l8 6.5" /><path d="M6.5 10v9h11v-9" /></>,
    launch: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v8M8 12h8" /></>,
    sell: <><circle cx="9" cy="12" r="5" /><path d="M14 8.5a5 5 0 1 1 0 7" /><path d="M9 10v4" /></>,
    fees: <><path d="M5 19V11M10 19V6M15 19v-6M20 19V9" /></>,
    portfolio: <><rect x="4" y="7.5" width="16" height="11.5" rx="2.5" /><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M4 12.5h16" /></>,
  };
  return <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
// Every sticker card carries a small illustrated icon; pages can name one, otherwise the
// title picks it (income and fees: coin; buybacks and burns: flame; streams, sky and
// vaults: telescope; anything else: planet).
export type Sticker = "planet" | "coin" | "flame" | "telescope";
function stickerFor(title?: string): Sticker {
  const t = (title ?? "").toLowerCase();
  if (/buyback|ladder|burn|bid/.test(t)) return "flame";
  if (/income|fee|cash|money|trade|buy/.test(t)) return "coin";
  if (/stream|sky|vault|position|tail/.test(t)) return "telescope";
  return "planet";
}
export function Card({
  title,
  children,
  className = "",
  icon,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  icon?: Sticker;
}) {
  const sticker = icon ?? stickerFor(title);
  return (
    <section
      className={`panel ${className}`}
      style={{ "--sticker": `url(/art/sticker-${sticker}.webp)` } as React.CSSProperties}
    >
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
  value: React.ReactNode;
  tone?: "ion" | "dust" | "plain";
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
