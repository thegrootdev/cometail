"use client";
// The Fee Index: every SOL-paired Meteora DBC coin from any launchpad that has paid its creator, what
// the creator earns, what waits to be claimed, and whether the fees can launch a tail; the
// launchpads ranked by what their creators earn, with copy-paste snippets for the protocol's six
// launch configs. Read-only; the "Sell these fees" path opens the sell wizard on the creator's pool.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { Shell, Card } from "@/components/Shell";
import { PageHeader, DataState, Badge } from "@/components/Experience";
import { Money } from "@/components/Money";
import { CopyAddress } from "@/components/CopyAddress";
import { CoinCell } from "@/components/CoinCell";
import { api, type FeeCoin, type FeeCoverage, type Launchpad, type OurConfig } from "@/lib/api";
import { ADDRESSES } from "@/lib/addresses";
import { short } from "@/lib/format";
import { feeIndex as copy } from "@/content/cometail";

type Sort = "day" | "claimable" | "lifetime" | "avg";
const PAGE = 50;

/** The six launch presets as a builder sees them: a name and a DBC config address. */
function ourPresets(): { label: string; config: string }[] {
  const out = [{ label: "Standard", config: ADDRESSES.plainConfig.toBase58() }];
  const names: Record<string, string> = { long: "Long", flat: "Flat", exp: "Exponential", stockUsdc: "Stock · USDC", stockXstock: "Stock · xStock" };
  for (const [k, v] of Object.entries(ADDRESSES.presets)) if (v) out.push({ label: names[k] ?? k, config: v.toBase58() });
  return out;
}

const snippet = (config: string) => `import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const client = DynamicBondingCurveClient.create(connection, "confirmed");
const baseMint = Keypair.generate();
const tx = await client.pool.createPool({
  config: new PublicKey("${config}"),
  baseMint: baseMint.publicKey,
  name: "My Coin", symbol: "MYC", uri: "https://example.com/my-coin.json",
  payer: wallet.publicKey, poolCreator: wallet.publicKey,
});
// sign with the wallet and baseMint, then send`;

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="pill" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ } }}>{done ? copy.copied : copy.copy}</button>;
}

function Coverage({ c }: { c: FeeCoverage | null }) {
  if (!c) return null;
  const at = c.deltaAtMs || c.fullAtMs;
  return <p className="micro mt-2">{copy.coverage(c.pools.toLocaleString("en-US"), c.configs.toLocaleString("en-US"), at ? new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "—")} {copy.coverageNote}</p>;
}

function Coins() {
  const { publicKey } = useWallet();
  const [sort, setSort] = useState<Sort>("day");
  const [stage, setStage] = useState("all");
  const [eligible, setEligible] = useState(false);
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [rows, setRows] = useState<FeeCoin[]>([]);
  const [coverage, setCoverage] = useState<FeeCoverage | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [more, setMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const me = publicKey?.toBase58() ?? null;
  // every response is tied to the query that asked for it: a newer query makes older answers void
  const generation = useRef(0);
  useEffect(() => { const t = setTimeout(() => setSearch(query.trim()), 300); return () => clearTimeout(t); }, [query]);
  const load = async (offset: number) => {
    const g = offset === 0 ? ++generation.current : generation.current;
    const r = await api.feeCoins({ sort, stage, eligible, creator: mine ? me : null, q: search || undefined, offset, limit: PAGE });
    if (g !== generation.current) return;
    if (!r) { if (offset === 0) setState("error"); return; }
    setCoverage(r.coverage); setRows((old) => (offset ? [...old, ...r.coins] : r.coins)); setMore(r.coins.length === PAGE); setState("ok");
  };
  const loadMore = async () => { if (paging) return; setPaging(true); try { await load(rows.length); } finally { setPaging(false); } };
  useEffect(() => { setState("loading"); setRows([]); void load(0); }, [sort, stage, eligible, mine, me, search]);
  return (
    <>
      <Coverage c={coverage} />
      <div className="market-controls mt-4">
        <div className="market-switch fee-switch" aria-label={copy.sort}>
          {([["day", copy.sortDay], ["claimable", copy.sortClaimable], ["lifetime", copy.sortLifetime], ["avg", copy.sortAvg]] as [Sort, string][]).map(([k, label]) => (
            <button type="button" key={k} aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>
          ))}
        </div>
        <label className="market-search"><span>{copy.search}</span><input type="search" placeholder={copy.search} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <label className="market-filter"><span>{copy.stage}</span><select value={stage} onChange={(e) => setStage(e.target.value)}><option value="all">{copy.all}</option><option value="bonding">{copy.bonding}</option><option value="graduated">{copy.graduated}</option></select></label>
      </div>
      <div className="atlas-search mt-3">
        <label><input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} /> {copy.eligibleOnly}</label>
        {me && <label><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {copy.mine}</label>}
      </div>
      {state === "loading" && <DataState kind="loading" compact />}
      {state === "error" && <DataState kind="error" compact title={copy.unavailable} onRetry={() => { setState("loading"); void load(0); }} />}
      {state === "ok" && rows.length === 0 && <DataState title={copy.empty} body={copy.emptyBody} />}
      {state === "ok" && rows.length > 0 && (
        <div className="table-scroll mt-4">
          <table className="stream-table fee-table">
            <thead><tr><th>{copy.coin}</th><th>{copy.launchpad}</th><th>{copy.last24h}</th><th>{copy.lifetime}</th><th>{copy.claimable}</th><th>{copy.tail}</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.pool}>
                  <td data-label={copy.coin}>
                    <CoinCell mint={c.mint} name={c.name} symbol={c.symbol} imageUrl={c.imageUrl} href={`/token/${c.mint}`} />
                    <p className="source-kind">{c.stage === "graduated" ? copy.graduated : c.stage === "bonding" ? copy.bonding : copy.migrating}{c.creatorFeePct !== null ? ` · creator ${c.creatorFeePct}%` : ""}</p>
                  </td>
                  <td data-label={copy.launchpad}>{c.ours ? <Badge tone="gold">{copy.ours}</Badge> : c.launchpad ? <CopyAddress address={c.launchpad} label={copy.wallet} /> : "—"}</td>
                  <td className="money" data-label={copy.last24h}><Money lamports={c.creatorLast24hEstimateLamports} />{c.last24hWindowHours < 24 ? <span className="micro"> {copy.window(c.last24hWindowHours)}</span> : null}</td>
                  <td className="money" data-label={copy.lifetime}><Money lamports={c.creatorLifetimeEstimateLamports} /><p className="micro">{c.noneClaimed ? copy.noneClaimed : <>{c.lifetimeExact ? copy.claimed : copy.claimedAtMost} <Money lamports={c.creatorClaimedAtMostLamports} /></>}</p></td>
                  <td className="money" data-label={copy.claimable}><Money lamports={c.claimableLamports} /></td>
                  <td data-label={copy.tail}>
                    <span className={`source-availability ${c.configAllowsTail ? "source-sellable" : ""}`} title={c.configAllowsTail ? copy.tailNote : c.reasons.join("; ")}>{c.configAllowsTail ? copy.canTail : copy.cannotTail}</span>
                    {!c.configAllowsTail && c.reasons.length > 0 && <p className="micro">{c.reasons[0]}</p>}
                    {me && c.creator === me && c.configAllowsTail && <p className="mt-1"><Link className="text-link" href={`/sell?pool=${c.pool}`}>{copy.sell} ↗</Link></p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {more && <button type="button" className="button button-secondary mt-4" disabled={paging} onClick={() => void loadMore()}>{copy.more}</button>}
          <p className="micro mt-3">{copy.estimateNote} {copy.tailNote}</p>
        </div>
      )}
    </>
  );
}

function Launchpads() {
  const [data, setData] = useState<{ coverage: FeeCoverage; rankedBy: "last24h" | "lifetime"; historySinceMs: number; launchpads: Launchpad[]; ourConfigs: OurConfig[] } | null | undefined>(undefined);
  useEffect(() => { void api.feeLaunchpads().then(setData); }, []);
  const presets = useMemo(ourPresets, []);
  const ours = new Map((data?.ourConfigs ?? []).map((c) => [c.config, c]));
  return (
    <>
      <Card title={copy.oursTitle}>
        <p className="text-sm">{copy.oursBody}</p>
        <ul className="mt-3 space-y-4">
          {presets.map((p) => {
            const s = ours.get(p.config);
            const code = snippet(p.config);
            return (
              <li key={p.config}>
                <div className="flex flex-wrap items-center gap-2"><strong>{p.label}</strong><CopyAddress address={p.config} label={copy.configLabel} /><CopyButton text={code} /></div>
                {s && !s.covered && <p className="micro mt-1">{copy.notCovered}</p>}
                {s && s.covered && <p className="micro mt-1">{s.coins} coins · creators lifetime (est.) <Money lamports={s.creatorLifetimeEstimateLamports} secondary={false} /> · 24 h (est.) <Money lamports={s.creatorLast24hEstimateLamports} secondary={false} />{s.tailEligibleConfig ? " · tail-ready config" : ""}</p>}
                <pre className="fee-snippet mt-2"><code>{code}</code></pre>
              </li>
            );
          })}
        </ul>
      </Card>
      <h2 className="mt-8">{copy.lpTitle}</h2>
      <p className="text-sm">{copy.lpBody}</p>
      <Coverage c={data?.coverage ?? null} />
      {data && <p className="micro mt-1">{data.rankedBy === "lifetime" ? copy.rankedByLifetime(new Date(data.historySinceMs || Date.now()).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC") : copy.rankedByDay} {copy.estimateNote}</p>}
      {data === undefined && <DataState kind="loading" compact />}
      {data === null && <DataState kind="error" compact title={copy.unavailable} />}
      {data && (
        <div className="table-scroll mt-4">
          <table className="stream-table fee-table">
            <thead><tr><th>{copy.launchpad}</th><th>{copy.lpCoins}</th><th>{copy.lpEligible}</th><th>{copy.lpDay}</th><th>{copy.lpLife}</th><th>{copy.lpClaimable}</th></tr></thead>
            <tbody>
              {data.launchpads.map((l) => (
                <tr key={l.launchpad}>
                  <td data-label={copy.launchpad}><span className="micro">#{l.rank} </span>{l.ours ? <Badge tone="gold">{copy.ours}</Badge> : null} <CopyAddress address={l.launchpad} label={copy.wallet} />{l.creatorFeePct !== null ? <p className="micro">creator share {l.creatorFeePct}%</p> : null}</td>
                  <td data-label={copy.lpCoins}>{l.coins.toLocaleString("en-US")}<p className="micro">{l.graduated.toLocaleString("en-US")} graduated · {l.configs.toLocaleString("en-US")} configs</p></td>
                  <td data-label={copy.lpEligible}>{l.tailEligibleCoins.toLocaleString("en-US")}</td>
                  <td className="money" data-label={copy.lpDay}><Money lamports={l.creatorLast24hEstimateLamports} />{l.coinsWithShorterWindow > 0 ? <p className="micro">{copy.shorter(l.coinsWithShorterWindow)}</p> : null}</td>
                  <td className="money" data-label={copy.lpLife}><Money lamports={l.creatorLifetimeEstimateLamports} /></td>
                  <td className="money" data-label={copy.lpClaimable}><Money lamports={l.claimableLamports} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function FeeIndexPage() {
  const [tab, setTab] = useState<"coins" | "launchpads">("coins");
  return (
    <Shell wide>
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body}>
        <Link className="button button-secondary" href="/tails">{copy.tails} ↗</Link>
      </PageHeader>
      <div className="market-switch mt-2" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "coins"} aria-pressed={tab === "coins"} onClick={() => setTab("coins")}>{copy.coins}</button>
        <button type="button" role="tab" aria-selected={tab === "launchpads"} aria-pressed={tab === "launchpads"} onClick={() => setTab("launchpads")}>{copy.launchpads}</button>
      </div>
      <section className="mt-4">{tab === "coins" ? <Coins /> : <Launchpads />}</section>
    </Shell>
  );
}
