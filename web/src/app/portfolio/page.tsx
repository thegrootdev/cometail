"use client";
import { CopyAddress } from "@/components/CopyAddress";
import { quoteAsset } from "@/lib/quotes";
import { Money } from "@/components/Money";
import { TokenHeading } from "@/components/TokenHeading";
import { SocialLinks } from "@/components/SocialLinks";
import { SourceStatus } from "@/components/SourceStatus";
import { addresses, money, identity } from "@/content/cometail";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { PageHeader, DataState, Badge } from "@/components/Experience";
import { experience as copy, nav } from "@/content/cometail";
import { api } from "@/lib/api";
import { poolsByCreator } from "@/lib/dbc";
import { cpAmm } from "@/lib/damm";
import { useLoad } from "@/lib/hooks";
import { short } from "@/lib/format";
import { EXPLORER } from "@/lib/addresses";
import { tokenForMint } from "@/lib/token-display";
export default function PortfolioPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? null;
  const { data, loading, error, reload } = useLoad(
    async () => {
      if (!publicKey) return null;
      const [pools, positions, vaults, sky] = await Promise.all([
        poolsByCreator(connection, publicKey),
        cpAmm(connection).getPositionsByUser(publicKey),
        api.vaults(),
        api.sky(),
      ]);
      if (!vaults) throw Error(copy.failed);
      return {
        pools,
        positions,
        streams: sky?.streams ?? [],
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
              data.pools.map(({ pool, state }) => {
                const mint = String(state.baseMint),
                  source = data.streams.find((s) => s.pool === pool.toBase58()),
                  token = tokenForMint(source?.token, mint);
                return (
                  <div
                    className="portfolio-item portfolio-owned"
                    key={pool.toBase58()}
                  >
                    <Link
                      className="portfolio-owned-link"
                      href={`/token/${mint}`}
                    >
                      <TokenHeading token={token} mint={mint} />
                    </Link>
                    <p className="source-kind">{identity.creatorFees}</p>
                    <SourceStatus stream={source} />
                    <CopyAddress address={mint} />
                    <SocialLinks links={token?.links} tokenName={token?.name} />
                    <div className="portfolio-income">
                      <span>{copy.accrued}</span>
                      <Money quote={quoteAsset(source?.quoteMint)} lamports={state.creatorQuoteFee.toString()} />
                    </div>
                    <Link href={`/token/${mint}`} className="text-link">
                      {identity.viewToken} ↗
                    </Link>
                  </div>
                );
              })
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
              data.vaults.map((v) => {
                const mint = v.data.stMint ? String(v.data.stMint) : null,
                  token = mint ? tokenForMint(v.stToken, mint) : null;
                return (
                  <div className="portfolio-item portfolio-owned" key={v.vault}>
                    <Link
                      className="portfolio-owned-link"
                      href={`/vault/${v.vault}`}
                    >
                      <TokenHeading token={token} mint={mint} />
                    </Link>
                    <Badge>{Object.keys(v.data.status ?? {})[0]}</Badge>
                    {mint && <CopyAddress address={mint} />}
                    <SocialLinks links={token?.links} tokenName={token?.name} />
                    <div className="portfolio-income">
                      <span>{money.toSeller}</span>
                      <Money
                        lamports={String(v.data.accounting?.toDepositor ?? 0)}
                      />
                    </div>
                    <Link href={`/vault/${v.vault}`} className="text-link">
                      {identity.viewVault} ↗
                    </Link>
                  </div>
                );
              })
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
              data.positions.map((p) => {
                const source = data.streams.find(
                  (s) =>
                    s.kind === "position" &&
                    s.position === p.position.toBase58(),
                );
                const token = source
                  ? tokenForMint(source.token, source.baseMint)
                  : null;
                return (
                  <div
                    className="portfolio-item portfolio-owned"
                    key={p.position.toBase58()}
                  >
                    {token ? (
                      <Link
                        className="portfolio-owned-link"
                        href={`/token/${token.mint}`}
                      >
                        <TokenHeading token={token} mint={token.mint} />
                      </Link>
                    ) : (
                      <TokenHeading />
                    )}
                    <p className="source-kind">{identity.positionFees}</p>
                    <SourceStatus stream={source} />
                    {token && <CopyAddress address={token.mint} />}
                    <CopyAddress
                      address={p.position.toBase58()}
                      label={addresses.position}
                    />
                    <SocialLinks links={token?.links} tokenName={token?.name} />
                    <a
                      href={EXPLORER("address", p.position.toBase58())}
                      className="text-link"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {identity.viewPosition} ↗
                    </a>
                  </div>
                );
              })
            )}
          </Card>
        </div>
      ) : (
        <DataState />
      )}
    </Shell>
  );
}
