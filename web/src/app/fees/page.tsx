"use client";
// The Fee Index: every SOL-paired Meteora DBC coin from any launchpad that has paid its creator, what
// the creator earns, what waits to be claimed, and whether the fees can launch a tail; the
// launchpads ranked by what their creators earn, with copy-paste snippets for the protocol's six
// launch configs. Read-only; the "Sell these fees" path opens the sell wizard on the creator's pool.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { Shell, Card } from "@/components/Shell";
import { DataState, Badge } from "@/components/Experience";
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
      <label className="feed-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input type="search" placeholder={copy.search} aria-label={copy.search} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="sort-chips" role="group" aria-label={copy.sort}>
        {([["day", copy.sortDay], ["claimable", copy.sortClaimable], ["lifetime", copy.sortLifetime], ["avg", copy.sortAvg]] as [Sort, string][]).map(([k, label]) => (
          <button type="button" key={k} aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>
        ))}
      </div>
      <div className="fee-filters">
        <label className="fee-stage"><span className="sr-only">{copy.stage}</span><select value={stage} onChange={(e) => setStage(e.target.value)} aria-label={copy.stage}><option value="all">{copy.all}</option><option value="bonding">{copy.bonding}</option><option value="graduated">{copy.graduated}</option></select></label>
        <label><input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} /> {copy.eligibleOnly}</label>
        {me && <label><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {copy.mine}</label>}
      </div>
      {state === "loading" && (search ? <DataState kind="loading" compact title={copy.searching} body={copy.searchingBody} /> : <DataState kind="loading" compact />)}
      {state === "error" && <DataState kind="error" compact title={search ? copy.searchFailed : copy.unavailable} body={search ? copy.searchFailedBody : undefined} onRetry={() => { setState("loading"); void load(0); }} />}
      {state === "ok" && rows.length === 0 && <DataState title={copy.empty} body={copy.emptyBody} />}
      {state === "ok" && rows.length > 0 && (
        <div className="mt-4">
          <ul className="fee-list">
            {rows.map((c) => {
              const main = sort === "claimable" ? c.claimableLamports : sort === "lifetime" ? c.creatorLifetimeEstimateLamports : c.creatorLast24hEstimateLamports;
              const mainLabel = sort === "claimable" ? copy.claimable : sort === "lifetime" ? copy.lifetime : copy.last24h;
              return (
                <li key={c.pool}>
                  <details className="fee-row">
                    <summary>
                      <span className="fee-coin">
                        <CoinCell mint={c.mint} name={c.name} symbol={c.symbol} imageUrl={c.imageUrl} href={`/token/${c.mint}`} />
                        <span className="source-kind">{c.stage === "graduated" ? copy.graduated : c.stage === "bonding" ? copy.bonding : copy.migrating}{c.configAllowsTail ? ` · ${copy.canTail}` : ""}</span>
                      </span>
                      <span className="fee-main"><span className="micro">{mainLabel}</span><Money lamports={main} />{sort !== "claimable" && sort !== "lifetime" && c.last24hWindowHours < 24 ? <span className="micro fee-window">{copy.window(c.last24hWindowHours)}</span> : null}</span>
                    </summary>
                    <dl className="detail-list">
                      <div><dt>{copy.launchpad}</dt><dd>{c.ours ? <Badge tone="gold">{copy.ours}</Badge> : c.launchpad ? <CopyAddress address={c.launchpad} label={copy.wallet} /> : "—"}</dd></div>
                      {c.creatorFeePct !== null && <div><dt>{copy.creatorShare}</dt><dd>{c.creatorFeePct}%</dd></div>}
                      <div><dt>{copy.last24h}</dt><dd className="money"><Money lamports={c.creatorLast24hEstimateLamports} />{c.last24hWindowHours < 24 ? <span className="micro"> {copy.window(c.last24hWindowHours)}</span> : null}</dd></div>
                      <div><dt>{copy.lifetime}</dt><dd className="money"><Money lamports={c.creatorLifetimeEstimateLamports} /><p className="micro">{c.noneClaimed ? copy.noneClaimed : <>{c.lifetimeExact ? copy.claimed : copy.claimedAtMost} <Money lamports={c.creatorClaimedAtMostLamports} /></>}</p></dd></div>
                      <div><dt>{copy.claimable}</dt><dd className="money"><Money lamports={c.claimableLamports} /></dd></div>
                      <div><dt>{copy.tail}</dt><dd>
                        <span className={`source-availability ${c.configAllowsTail ? "source-sellable" : ""}`} title={c.configAllowsTail ? copy.tailNote : c.reasons.join("; ")}>{c.configAllowsTail ? copy.canTail : copy.cannotTail}</span>
                        {!c.configAllowsTail && c.reasons.length > 0 && <p className="micro">{c.reasons[0]}</p>}
                      </dd></div>
                    </dl>
                    {me && c.creator === me && c.configAllowsTail && <p className="fee-sell"><Link className="button button-gold button-full" href={`/sell?pool=${c.pool}`}>{copy.sell} ↗</Link></p>}
                  </details>
                </li>
              );
            })}
          </ul>
          {more && <button type="button" className="button button-secondary mt-4" disabled={paging} onClick={() => void loadMore()}>{copy.more}</button>}
          <details className="glass-details">
            <summary>{copy.details}</summary>
            <p>{copy.estimateNote} {copy.tailNote}</p>
          </details>
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
      <div className="simple-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.short}</p>
        </div>
      </div>
      <details className="glass-details">
        <summary>{copy.about}</summary>
        <p>{copy.body}</p>
        <p><Link className="text-link" href="/tails">{copy.tails} ↗</Link></p>
      </details>
      <div className="feed-tabs" role="tablist" aria-label={copy.title}>
        <button type="button" role="tab" aria-selected={tab === "coins"} onClick={() => setTab("coins")}>{copy.coins}</button>
        <button type="button" role="tab" aria-selected={tab === "launchpads"} onClick={() => setTab("launchpads")}>{copy.launchpads}</button>
      </div>
      <section className="mt-4">{tab === "coins" ? <Coins /> : <Launchpads />}</section>
    </Shell>
  );
}
