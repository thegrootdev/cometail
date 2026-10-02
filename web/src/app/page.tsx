import Link from "next/link";
import { Shell } from "@/components/Shell";
import { HomeAtlas } from "@/components/Atlas";
import { experience as copy, hero, plainLaunch } from "@/content/cometail";
export default function Home() {
  return (
    <Shell wide>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span />
            {copy.eyebrow}
          </div>
          <h1>
            {hero.title.split(". ")[0]}.
            <br />
            <em>{hero.title.split(". ")[1]}</em>
          </h1>
          <p>{copy.homeBody}</p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/launch">
              {hero.launch}
              <span>↗</span>
            </Link>
            <Link className="button button-secondary" href="/sell">
              {hero.sell}
              <span>→</span>
            </Link>
          </div>
          <div className="hero-footnote">{plainLaunch.creationFee}</div>
        </div>
        <div className="hero-art">
          <picture>
            <source media="(max-width: 760px)" srcSet="/art/hero-mobile.webp" />
            <img src="/art/hero.webp" alt="" width="1600" height="900" />
          </picture>
          <span className="art-caption">{copy.illustration}</span>
        </div>
      </section>
      <HomeAtlas />
      <section className="chapter-grid">
        {copy.chapters.map((c, i) => (
          <article
            className="chapter"
            key={c.number}
            style={{ "--sticker": `url(/art/sticker-${["planet", "coin", "flame"][i % 3]}.webp)` } as React.CSSProperties}
          >
            <span className="micro">{c.number} /</span>
            <h3>{c.title}</h3>
            <p>{c.body}</p>
          </article>
        ))}
      </section>
      <section className="mechanics">
        <h2>{copy.mechanics}</h2>
        <p>{copy.mechanicsBody}</p>
      </section>
    </Shell>
  );
}
