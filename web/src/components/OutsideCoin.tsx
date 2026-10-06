"use client";
// A coin from another launchpad: the main index tracks only coins on the protocol's own configs, so
// its market panel would never fill. This shows what the Fee Index knows instead: the creator's
// earnings, what waits to be claimed (exact), the launchpad, and whether its fees can launch a tail.
import Link from "next/link";
import { Card, Stat } from "./Shell";
import { Badge } from "./Experience";
import { Money } from "./Money";
import { CopyAddress } from "./CopyAddress";
import { type FeeCoin } from "@/lib/api";
import { EXPLORER } from "@/lib/addresses";
import { short } from "@/lib/format";
import { outsideCoin as copy } from "@/content/cometail";

export type FeeCoinResult = { state: "ok"; coin: FeeCoin } | { state: "missing" } | { state: "error" } | null;

export function OutsideCoinFees({ result, pool, isCreator, onRetry }: { result: FeeCoinResult; pool: string | null; isCreator: boolean; onRetry: () => void }) {
  const coin = result?.state === "ok" ? result.coin : null;
  return (
    <Card title={copy.title} className="mt-6">
      <p className="text-sm text-starlight/70">{copy.body}</p>
      {!result ? <p className="micro mt-3">{copy.loading}</p>
        : result.state === "missing" ? <p className="micro mt-3">{copy.notListed}</p>
        : result.state === "error" ? <p className="micro mt-3">{copy.unavailable} <button type="button" className="text-link" onClick={onRetry}>{copy.retry}</button></p>
        : coin && <>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Stat label={copy.claimable} value={<Money lamports={coin.claimableLamports} />} tone="dust" />
          <Stat label={copy.lifetime} value={<Money lamports={coin.creatorLifetimeEstimateLamports} />} />
          <Stat label={copy.day} value={<><Money lamports={coin.creatorLast24hEstimateLamports} />{coin.last24hWindowHours < 24 ? <span className="micro"> {copy.window(coin.last24hWindowHours)}</span> : null}</>} />
          <Stat label={copy.avg} value={<Money lamports={coin.creatorAvgPerDayEstimateLamports} />} />
        </div>
        <p className="micro mt-3">{coin.noneClaimed ? copy.noneClaimed : <>{coin.lifetimeExact ? copy.claimed : copy.claimedAtMost} <Money lamports={coin.creatorClaimedAtMostLamports} />.</>} {copy.exactNote}</p>
        <dl className="outside-facts mt-4">
          <div><dt>{copy.stage}</dt><dd>{coin.stage === "graduated" ? copy.graduated : coin.stage === "bonding" ? copy.bonding : copy.migrating}{coin.creatorFeePct !== null ? ` · ${copy.creatorShare(coin.creatorFeePct)}` : ""}</dd></div>
          <div><dt>{copy.launchpad}</dt><dd>{coin.ours ? <Badge tone="gold">{copy.ours}</Badge> : coin.launchpad ? <CopyAddress address={coin.launchpad} label={copy.wallet} /> : "—"}</dd></div>
          <div><dt>{copy.creator}</dt><dd><a className="text-link" href={EXPLORER("address", coin.creator)} target="_blank" rel="noreferrer">{short(coin.creator)} ↗</a></dd></div>
          <div><dt>{copy.tail}</dt><dd>{coin.configAllowsTail ? copy.canTail : <>{copy.cannotTail}{coin.reasons[0] ? <span className="micro"> · {coin.reasons[0]}</span> : null}</>}</dd></div>
        </dl>
        {isCreator && coin.configAllowsTail && <p className="mt-4"><Link className="button button-secondary" href={`/sell?pool=${coin.pool}`}>{copy.sell} ↗</Link></p>}
      </>}
      <p className="micro mt-4">{pool ? <><a className="text-link" href={EXPLORER("address", pool)} target="_blank" rel="noreferrer">{copy.trades} ↗</a> · </> : null}<Link className="text-link" href="/fees">{copy.index} ↗</Link></p>
    </Card>
  );
}
