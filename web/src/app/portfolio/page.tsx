"use client";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import {
  PageHeader,
  DataState,
  TokenAvatar,
  Badge,
} from "@/components/Experience";
import { experience as copy, nav } from "@/content/cometail";
import { api } from "@/lib/api";
import { poolsByCreator } from "@/lib/dbc";
import { cpAmm } from "@/lib/damm";
import { useLoad } from "@/lib/hooks";
import { short, sol } from "@/lib/format";
export default function PortfolioPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? null;
  const { data, loading, error, reload } = useLoad(
    async () => {
      if (!publicKey) return null;
      const [pools, positions, vaults] = await Promise.all([
        poolsByCreator(connection, publicKey),
        cpAmm(connection).getPositionsByUser(publicKey),
        api.vaults(),
      ]);
      if (!vaults) throw Error(copy.failed);
      return {
        pools,
        positions,
        vaults: vaults.vaults.filter((v) => String(v.data.depositor) === me),
      };
    },
    [me],
    30000,
  );
  return (
    <Shell>
      <PageHeader
        art="mascot"
        eyebrow={copy.portfolioKicker}
        title={nav.portfolio}
        body={copy.portfolioBody}
      >
        {me && <Badge tone="ion">{short(me)}</Badge>}
      </PageHeader>
      {!publicKey ? (
        <DataState
          kind="wallet"
          title={copy.connectTitle}
          body={copy.connectBody}
        >
          <ConnectWallet />
        </DataState>
      ) : loading ? (
        <DataState kind="loading" />
      ) : error ? (
        <DataState kind="error" onRetry={reload} />
      ) : data ? (
        <div className="portfolio-grid">
          <Card title={copy.launches}>
            {data.pools.length === 0 ? (
              <DataState compact title={copy.noLaunches} body={copy.launchBody}>
                <Link href="/launch" className="text-link">
                  {nav.launch} ↗
                </Link>
              </DataState>
            ) : (
              data.pools.map(({ pool, state }) => (
                <Link
                  className="portfolio-item"
                  key={pool.toBase58()}
                  href={`/token/${new PublicKey(state.baseMint).toBase58()}`}
                >
                  <span className="token-cell">
                    <TokenAvatar seed={String(state.baseMint)} />
                    <span>
                      {short(String(state.baseMint))}
                      <small>
                        {sol(state.creatorQuoteFee.toString())} {copy.accrued}
                      </small>
                    </span>
                  </span>
                  ↗
                </Link>
              ))
            )}
          </Card>
          <Card title={copy.vaults}>
            {data.vaults.length === 0 ? (
              <DataState compact title={copy.noVaults} body={copy.sellBody}>
                <Link href="/sell" className="text-link">
                  {nav.sell} ↗
                </Link>
              </DataState>
            ) : (
              data.vaults.map((v) => (
                <Link
                  className="portfolio-item"
                  key={v.vault}
                  href={`/vault/${v.vault}`}
                >
                  <span>
                    {short(v.vault)}
                    <small>
                      {sol(String(v.data.accounting?.toDepositor ?? 0))}
                    </small>
                  </span>
                  <Badge>{Object.keys(v.data.status ?? {})[0]}</Badge>
                </Link>
              ))
            )}
          </Card>
          <Card title={copy.positions}>
            {data.positions.length === 0 ? (
              <DataState
                compact
                title={copy.noPositions}
                body={copy.noStreamsBody}
              />
            ) : (
              data.positions.map((p) => (
                <div className="portfolio-item" key={p.position.toBase58()}>
                  <span>
                    {short(p.position.toBase58())}
                    <small>
                      {short(new PublicKey(p.positionState.pool).toBase58())}
                    </small>
                  </span>
                  <Badge tone="gold">{wizardPosition()}</Badge>
                </div>
              ))
            )}
          </Card>
        </div>
      ) : (
        <DataState />
      )}
    </Shell>
  );
}
function wizardPosition() {
  return "DAMM V2";
}
