import Link from "next/link";
import { Shell } from "@/components/Shell";
import { CoinFeed } from "@/components/CoinFeed";
import { HomeNumbers } from "@/components/HomeNumbers";
import { home } from "@/content/cometail";
// Home is the coin feed: one promise, one launch button, three live figures (/stats), then every coin.
// How it works and the details stay one tap away, folded.
export default function Home() {
  return (
    <Shell wide>
      <section className="home-top">
        <img className="home-mascot" src="/art/mascot.webp" alt="" width="200" height="200" />
        <h1>{home.title}</h1>
        <p>{home.body}</p>
        <Link className="button button-primary button-launch" href="/launch">
          <span aria-hidden="true">+</span> {home.launch}
        </Link>
        <HomeNumbers />
        <div className="home-links">
          <Link className="home-sell" href="/fees">{home.feeIndex} →</Link>
          <Link className="home-sell" href="/sell">{home.sell} →</Link>
        </div>
      </section>
      <CoinFeed />
      <details className="glass-details home-how">
        <summary>{home.how}</summary>
        <ol className="how-steps">
          {home.steps.map((s, i) => (
            <li key={s.title}><span className="how-n">{i + 1}</span><span><strong>{s.title}</strong><p>{s.body}</p></span></li>
          ))}
        </ol>
      </details>
      <details className="glass-details">
        <summary>{home.details}</summary>
        <p>{home.marketCapNote}</p>
        <p><Link className="text-link" href="/sky">{home.explore} ↗</Link></p>
      </details>
    </Shell>
  );
}
