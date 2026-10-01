import Link from "next/link";
import { Comet } from "@/components/Comet";
import { hero, nav, product } from "@/content/cometail";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Link href="/" className="flex items-center gap-3">
          <img src="/brand/symbol.svg" alt="" width={36} height={36} />
          <span className="text-lg font-extrabold tracking-[0.2em]">{product.name}</span>
        </Link>
        <nav className="flex gap-6 text-sm text-starlight/80">
          <Link href="/sky">{nav.sky}</Link>
          <Link href="/portfolio">{nav.portfolio}</Link>
        </nav>
      </header>
      <section className="grid flex-1 items-center gap-12 py-16 md:grid-cols-2">
        <div>
          <h1 className="text-5xl font-extrabold leading-tight md:text-6xl">{hero.title}</h1>
          <p className="mt-6 max-w-xl text-lg text-starlight/80">{hero.body}</p>
          <div className="mt-10 flex flex-wrap gap-4">
            <Link href="/launch" className="rounded-full bg-ion px-6 py-3 font-semibold text-night">{hero.launch}</Link>
            <Link href="/sell" className="rounded-full border border-dust px-6 py-3 font-semibold text-dust">{hero.sell}</Link>
          </div>
        </div>
        <div className="flex justify-center">
          <Comet intensity={0.6} size={360} />
        </div>
      </section>
      <footer className="flex items-center justify-between py-8 text-sm text-starlight/60">
        <span>{product.domain}</span>
        <span className="glass rounded-full px-3 py-1">{product.builtOn}</span>
      </footer>
    </main>
  );
}
