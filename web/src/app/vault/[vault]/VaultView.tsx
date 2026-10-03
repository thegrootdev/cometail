"use client";
// Vault page: streams with custody, income and payouts from the program's accounting, the
// buyback ladder and burn log from events, the disclosures, and the stream token's market.
import { CopyAddress } from "@/components/CopyAddress";
import { Money } from "@/components/Money";
import { addresses, identity } from "@/content/cometail";
import { TokenHeading } from "@/components/TokenHeading";
import { SocialLinks } from "@/components/SocialLinks";
import type { TokenIdentity } from "@/lib/token-display";
import dynamic from "next/dynamic";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  DataState,
  PageHeader,
  BackToSky,
  Badge,
} from "@/components/Experience";
import { Shell, Card, Stat } from "@/components/Shell";
import { vaultPage, experience as c } from "@/content/cometail";
import { EXPLORER } from "@/lib/addresses";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { ago, short, sol, units } from "@/lib/format";
import { q64ToCap } from "@/lib/q64";
const OpenVaultActions = dynamic(
  () => import("@/components/OpenVaultActions").then(m => m.OpenVaultActions),
  { loading: () => <DataState kind="loading" compact /> },
);

const STATUS = (v: any) => (v?.status ? Object.keys(v.status)[0] : "unknown");
const KIND = (s: any) => (s?.kind ? Object.keys(s.kind)[0] : "");

export default function VaultView({ vaultStr }: { vaultStr: string }) {
  try {
    new PublicKey(vaultStr);
  } catch {
    return (
      <Shell>
        <DataState kind="error" title={c.invalid} body={c.missingBody}>
          <BackToSky />
        </DataState>
      </Shell>
    );
  }
  return <VaultDetail vaultStr={vaultStr} />;
}
function VaultDetail({ vaultStr }: { vaultStr: string }) {
  const { connection } = useConnection();
  const { data, reload, loading, error } = useLoad(
    async () => {
      const fromApi = await api.vault(vaultStr);
      if (fromApi)
        return {
          vault: fromApi.data,
          streams: fromApi.streams.map((s) => ({ ...s.data, token: s.token })),
          stToken: fromApi.stToken ?? null,
          events: fromApi.events,
          updatedAt: fromApi.updatedAt,
        };
      const info = await connection.getAccountInfo(new PublicKey(vaultStr));
      if (!info) return null;
      const { VaultClientStep6 } = await import("@cometail/client");
      return {
        vault: new VaultClientStep6(connection).decodeVault(info.data),
        streams: [] as any[],
        stToken: null as TokenIdentity | null,
        events: [] as any[],
        updatedAt: Date.now(),
      };
    },
    [vaultStr],
    15_000,
  );
  const v = data?.vault;
  const acc = v?.accounting ?? {};
  const burns = (data?.events ?? []).filter((e) => e.name === "settled");
  const routes = (data?.events ?? []).filter((e) => e.name === "routed");
  const str = (x: any) => (x === undefined || x === null ? "0" : String(x));
  return (
    <Shell>
      <BackToSky />
      <PageHeader eyebrow={c.vaultKicker} title={identity.vaultName}>
        {v?.stMint && <TokenHeading token={data?.stToken} mint={String(v.stMint)} large />}
        {v ? (
          <Link href={`/token/${String(v.stMint)}`} className="button button-primary">
            Trade the stream token ↗
          </Link>
        ) : (
          <button className="button button-primary" type="button" disabled>
            Trade the stream token ↗
          </button>
        )}
      </PageHeader>
      <SocialLinks links={data?.stToken?.links} tokenName={data?.stToken?.name} />
      <div className="vault-addresses"><CopyAddress address={vaultStr} label={addresses.vault} />{v?.stMint && <CopyAddress address={String(v.stMint)} />}</div>
      {loading && <DataState kind="loading" />}
      {!loading && error && <DataState kind="error" onRetry={reload} />}
      {!loading && !error && !data && (
        <DataState kind="empty" title={c.missing} body={c.missingBody}>
          <BackToSky />
        </DataState>
      )}
      {data && v && (
        <>
          <div className="detail-address">
            <div className="flex items-center gap-4">
              <Badge tone={STATUS(v) === "live" ? "gold" : "neutral"}>
                {STATUS(v)}
              </Badge>
              <a
                href={EXPLORER("address", vaultStr)}
                target="_blank"
                rel="noreferrer"
              >
                {short(vaultStr)} ↗
              </a>
            </div>
            <span className="caption">
              {c.observed} {ago(Math.floor(data.updatedAt / 1000))}
            </span>
          </div>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <Card title={vaultPage.income}>
              <div className="grid grid-cols-2 gap-4">
                <Stat
                  label="harvested, gross"
                  value={<Money lamports={str(acc.harvestedGross)} />}
                  tone="dust"
                />
                <Stat label="kept for buybacks" value={<Money lamports={str(acc.income)} />} />
                <Stat
                  label="to the seller"
                  value={<Money lamports={str(acc.toDepositor)} />}
                  tone="plain"
                />
                <Stat
                  label="to the protocol"
                  value={<Money lamports={str(acc.toProtocol)} />}
                  tone="plain"
                />
              </div>
              <p className="mt-4 text-sm text-starlight/70">
                {vaultPage.cashout}:{" "}
                <span className="text-dust"><Money lamports={str(acc.cashedOut)} /></span>
              </p>
            </Card>
            <Card title={vaultPage.ladder}>
              <p className="text-sm text-starlight/70">
                {vaultPage.ladderBody}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Stat
                  label={vaultPage.bids}
                  value={String(v.routing?.outstandingOrders ?? 0)}
                  tone="plain"
                />
                <Stat label="placed, gross" value={<Money lamports={str(acc.routedGross)} />} />
                <Stat
                  label={vaultPage.burned}
                  value={units(str(acc.burnedSt), 6)}
                  tone="dust"
                />
                <Stat
                  label={vaultPage.cap}
                  value={
                    v.policy
                      ? `${q64ToCap(str(v.policy.maxPriceQ64), 6)} SOL/token`
                      : ""
                  }
                  tone="plain"
                />
              </div>
              {v.live?.ladder && v.live.ladder.status !== "ok" && v.live.ladder.status !== undefined && (
                <p className="mt-4 text-sm text-starlight/60">{vaultPage.ladderUnavailable}</p>
              )}
              {v.live?.ladder && (v.live.ladder.status === "ok" || v.live.ladder.status === undefined) && (
                <div className="mt-5">
                  <div className="caption">{vaultPage.depth}</div>
                  {(() => {
                    const bins = (v.live.ladder.orders as any[]).flatMap((o: any) => o.bins as any[]).sort((a: any, b: any) => b.price - a.price);
                    return bins.length === 0 ? (
                      <p className="mt-2 text-sm text-starlight/60">{vaultPage.noBins}</p>
                    ) : (
                      <ul className="ladder-bins">
                        {bins.map((b: any) => (
                          <li key={b.id}>
                            <span>{Number(b.price).toPrecision(4)} SOL/token</span>
                            <span className={b.status === "filled" ? "text-dust" : "text-ion"}>
                              {b.remaining === null
                                ? `${sol(String(b.amount))} · ${vaultPage.unknownFill}`
                                : b.status === "filled"
                                  ? `${sol(String(b.filled))} ${vaultPage.filled}`
                                  : b.status === "partial"
                                    ? `${sol(String(b.remaining))} ${vaultPage.resting} · ${sol(String(b.filled))} ${vaultPage.filled}`
                                    : `${sol(String(b.remaining))} ${vaultPage.resting}`}
                              {b.crossed && b.status !== "filled" ? ` · ${vaultPage.crossed}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    );
                  })()}
                  <p className="caption mt-3">
                    {vaultPage.poolPrice}: {Number(v.live.ladder.activePrice).toPrecision(4)} SOL/token · {ago(Math.floor(v.live.updatedAt / 1000))}
                  </p>
                </div>
              )}
            </Card>
          </div>
          {STATUS(v) === "open" && (
            <OpenVaultActions
              vault={vaultStr}
              v={v}
              streams={data.streams}
              onChange={reload}
            />
          )}
          <Card title={vaultPage.streams} className="mt-6">
            {data.streams.length === 0 && (
              <DataState
                compact
                title="No stream records indexed yet"
                body="Custody records will appear here after the indexer observes them."
              />
            )}
            <ul className="divide-y divide-starlight/10 text-sm">
              {data.streams.map((s: any, i: number) => (
                <li
                  key={i}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="vault-stream-identity">
                    {s.token?.mint ? <Link href={`/token/${s.token.mint}`} className="token-cell"><TokenHeading token={s.token} mint={s.token.mint}/></Link> : <TokenHeading/>}
                    <p className="source-kind">{KIND(s) === "dbcCreatorRights" ? identity.creatorFees : identity.positionFees}</p>
                    <p className="source-availability">{identity.heldHere}</p>
                    {s.token?.mint && <CopyAddress address={s.token.mint}/>}
                    <SocialLinks links={s.token?.links} tokenName={s.token?.name}/>
                    <a className="text-link" href={EXPLORER("address", String(s.pool))} target="_blank" rel="noopener noreferrer">{identity.viewPool} ↗</a>
                  </div>
                  <span className="text-starlight/60">
                    {s.live?.lockedSharePct != null && (
                      <>
                        {s.live.lockedSharePct}% {vaultPage.lockedShare} ·{" "}
                      </>
                    )}
                    harvested <Money lamports={str(s.harvested)} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <Card title="Bids placed">
              {routes.length === 0 && (
                <DataState
                  compact
                  title="No bids placed yet"
                  body="Buyback orders appear here when the keeper routes available income."
                />
              )}
              <ul className="space-y-1 text-sm">
                {routes.slice(0, 10).map((e) => (
                  <li key={e.signature + e.idx}>
                    <a
                      className="text-ion"
                      href={EXPLORER("tx", e.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {sol(str(e.data.gross))}
                    </a>{" "}
                    across {String(e.data.bins)} bins · {ago(e.blockTime)}
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Burn log">
              {burns.length === 0 && (
                <DataState
                  compact
                  title="No tokens burned yet"
                  body="Settled buybacks leave a verifiable record here."
                />
              )}
              <ul className="space-y-1 text-sm">
                {burns.slice(0, 10).map((e) => (
                  <li key={e.signature + e.idx}>
                    <a
                      className="text-dust"
                      href={EXPLORER("tx", e.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {units(str(e.data.burned), 6)} burned
                    </a>{" "}
                    · {sol(str(e.data.refunded))} refunded · {ago(e.blockTime)}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <Card title="What this is, exactly" className="mt-6">
            <p className="text-sm text-starlight/80">{vaultPage.disclosure}</p>
            <p className="mt-3 text-sm text-starlight/80">
              {vaultPage.authority}
            </p>
            <p className="mt-3 text-sm text-starlight/80">
              {vaultPage.noGraduation}
            </p>
          </Card>
        </>
      )}
    </Shell>
  );
}
