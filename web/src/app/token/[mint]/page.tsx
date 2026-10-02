"use client";
// Token page: the curve while bonding, the graduated pool after, the tail's income meter,
// trades in both states, the creator's fee claim, and the door to selling the tail.
import { use, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import {
  DataState,
  PageHeader,
  TokenAvatar,
  BackToSky,
} from "@/components/Experience";
import { Shell, Card, Stat, ConnectWallet } from "@/components/Shell";
import { tokenPage, experience as c } from "@/content/cometail";
import { EXPLORER } from "@/lib/addresses";
import {
  claimCreatorFeesTx,
  curveQuote,
  curveSwapTx,
  dbcClient,
  derivedDammPool,
  loadPool,
  readMetadata,
  MigrationProgress,
} from "@/lib/dbc";
import { dammSwapTx } from "@/lib/damm";
import { useLoad, useTx } from "@/lib/hooks";
import { short, sol, units } from "@/lib/format";

const STAGE = [
  "Bonding on the curve",
  "Curve complete, migrating",
  "Locked vesting",
  "Graduated to DAMM v2",
];

export default function TokenPage({
  params,
}: {
  params: Promise<{ mint: string }>;
}) {
  const { mint: mintStr } = use(params);
  try {
    new PublicKey(mintStr);
  } catch {
    return (
      <Shell>
        <DataState kind="error" title={c.invalid} body={c.missingBody}>
          <BackToSky />
        </DataState>
      </Shell>
    );
  }
  return <TokenDetail mintStr={mintStr} />;
}
function TokenDetail({ mintStr }: { mintStr: string }) {
  const { connection } = useConnection();
  const { run, status, publicKey } = useTx();
  const mint = new PublicKey(mintStr);
  const {
    data: view,
    reload,
    loading,
    error,
  } = useLoad(
    async () => {
      const found = await dbcClient(connection).state.getPoolByBaseMint(mint);
      return found ? loadPool(connection, found.publicKey) : null;
    },
    [mintStr],
    20_000,
  );
  const pool = view?.pool ?? PublicKey.default;
  const { data: meta } = useLoad(
    () => readMetadata(connection, mint),
    [mintStr],
  );
  const { data: artwork } = useLoad(async () => {
    if (!meta?.uri || !/^https?:\/\//.test(meta.uri)) return null;
    const response = await fetch(meta.uri, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.image === "string" && /^https?:\/\//.test(data.image)
      ? (data.image as string)
      : null;
  }, [meta?.uri]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quote, setQuote] = useState<string | null>(null);
  const graduated = view?.progress === MigrationProgress.CreatedPool;
  const bonding = view?.progress === MigrationProgress.PreBondingCurve;
  const progressPct = view
    ? Math.min(
        100,
        (Number(view.quoteReserve.toString()) /
          Math.max(1, Number(view.threshold.toString()))) *
          100,
      )
    : 0;
  const claimable = view?.creatorQuoteFee ?? new BN(0);
  const creatorTotal = view
    ? view.tradingQuoteFee.muln(view.creatorFeePct).divn(100)
    : new BN(0);
  const realized = creatorTotal.gt(claimable)
    ? creatorTotal.sub(claimable)
    : new BN(0);
  const isCreator = !!(publicKey && view && view.creator.equals(publicKey));
  const dec = view?.decimals ?? 6;
  const amountRaw = () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    return side === "buy"
      ? new BN(Math.round(n * 1e9))
      : new BN(Math.round(n * 10 ** dec));
  };
  const dammPool = view
    ? derivedDammPool(mint, view.migrationFeeOption)
    : PublicKey.default;
  const doQuote = async () => {
    setActionError(null);
    setQuoting(true);
    try {
      const raw = amountRaw();
      if (!raw || !view) return;
      if (bonding) {
        const q: any = await curveQuote(connection, view, raw, side === "sell");
        setQuote(
          side === "buy"
            ? `${units(q.outputAmount, dec)} tokens`
            : sol(q.outputAmount),
        );
      } else if (graduated) {
        const r = await dammSwapTx(
          connection,
          dammPool,
          publicKey ?? view.creator,
          side === "buy" ? NATIVE_MINT : mint,
          raw,
          { a: dec, b: 9 },
        );
        setQuote(side === "buy" ? `${units(r.out, dec)} tokens` : sol(r.out));
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : c.failed);
    } finally {
      setQuoting(false);
    }
  };
  const trade = async () => {
    setActionError(null);
    try {
      const raw = amountRaw();
      if (!raw || !view || !publicKey) return;
      if (bonding) {
        const q: any = await curveQuote(connection, view, raw, side === "sell");
        await run(
          () =>
            curveSwapTx(
              connection,
              pool,
              publicKey,
              raw,
              q.minimumAmountOut,
              side === "sell",
            ),
          [],
          300_000,
        );
      } else if (graduated) {
        await run(
          () =>
            dammSwapTx(
              connection,
              dammPool,
              publicKey,
              side === "buy" ? NATIVE_MINT : mint,
              raw,
              { a: dec, b: 9 },
            ).then((r) => r.tx),
          [],
          300_000,
        );
      }
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : c.failed);
    }
  };
  return (
    <Shell>
      <BackToSky />
      <PageHeader
        eyebrow={c.tokenKicker}
        title={meta?.name || short(mintStr)}
        body={meta?.symbol ? `$${meta.symbol}` : undefined}
      >
        <TokenAvatar seed={mintStr} image={artwork ?? undefined} size="large" />
      </PageHeader>
      <div className="detail-address">
        <a href={EXPLORER("address", mintStr)} target="_blank" rel="noreferrer">
          {short(mintStr)} ↗
        </a>
        {view && (
          <Link
            href={`/sell?pool=${pool.toBase58()}`}
            className="button button-secondary"
          >
            {tokenPage.sellTail} ↗
          </Link>
        )}
      </div>
      {loading && <DataState kind="loading" />}
      {!loading && error && <DataState kind="error" onRetry={reload} />}
      {!loading && !error && !view && (
        <DataState kind="empty" title={c.missing} body={c.missingBody}>
          <BackToSky />
        </DataState>
      )}
      {view && (
        <div className="mt-6 grid gap-6 md:grid-cols-[3fr_2fr]">
          <div className="space-y-6">
            <Card title={tokenPage.curve}>
              <p className="text-sm text-starlight/70">
                {STAGE[view.progress]}
              </p>
              {!graduated && (
                <div className="mt-3">
                  <div className="h-3 w-full overflow-hidden rounded-full bg-starlight/10">
                    <div
                      className="h-3 rounded-full bg-ion"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <p className="mt-2 text-sm text-starlight/70">
                    {sol(view.quoteReserve)} of {sol(view.threshold)}{" "}
                    {tokenPage.progress}
                  </p>
                </div>
              )}
              {graduated && (
                <p className="mt-2 text-sm">
                  <a
                    className="text-ion"
                    href={EXPLORER("address", dammPool.toBase58())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    DAMM v2 pool {short(dammPool.toBase58())}
                  </a>
                </p>
              )}
            </Card>
            <Card title={tokenPage.tail}>
              <p className="text-sm text-starlight/70">{tokenPage.tailBody}</p>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Stat
                  label="claimable now"
                  value={sol(claimable)}
                  tone="dust"
                />
                <Stat label={c.curveEstimate} value={sol(realized)} />
              </div>
              <p className="caption mt-4">{c.curveEstimateBody}</p>
              <p className="mt-3 text-xs text-starlight/50">
                Creator:{" "}
                <a
                  href={EXPLORER("address", view.creator.toBase58())}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(view.creator.toBase58())}
                </a>
              </p>
              {isCreator && claimable.gtn(0) && (
                <button
                  disabled={status.state === "sending"}
                  onClick={() =>
                    run(
                      () => claimCreatorFeesTx(connection, pool, publicKey!),
                      [],
                      300_000,
                    ).then(reload)
                  }
                  className="mt-4 rounded-full bg-dust px-5 py-2 font-semibold text-night"
                >
                  {tokenPage.claim}
                </button>
              )}
            </Card>
          </div>
          <Card title={tokenPage.trades}>
            {!bonding && !graduated && (
              <p className="text-sm text-starlight/60">
                Trading pauses while the curve migrates.
              </p>
            )}
            {(bonding || graduated) && (
              <>
                <div className="flex gap-2">
                  {(["buy", "sell"] as const).map((s) => (
                    <button
                      key={s}
                      aria-pressed={side === s}
                      onClick={() => {
                        setSide(s);
                        setQuote(null);
                      }}
                      className={`rounded-full px-4 py-1 text-sm ${side === s ? "bg-ion text-night" : "border border-starlight/20"}`}
                    >
                      {s === "buy" ? tokenPage.buy : tokenPage.sellToken}
                    </button>
                  ))}
                </div>
                <label className="mt-4 block text-sm">
                  {side === "buy" ? "SOL in" : "Tokens in"}
                  <input
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setQuote(null);
                    }}
                    inputMode="decimal"
                    className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2"
                  />
                </label>
                <div className="mt-3 flex gap-3">
                  <button
                    disabled={quoting || !amountRaw()}
                    onClick={doQuote}
                    className="rounded-full border border-starlight/30 px-4 py-2 text-sm"
                  >
                    {quoting ? "Quoting…" : "Quote"}
                  </button>
                  <button
                    onClick={trade}
                    disabled={!publicKey || status.state === "sending"}
                    className="rounded-full bg-ion px-5 py-2 font-semibold text-night disabled:opacity-40"
                  >
                    {status.state === "sending"
                      ? "Sending…"
                      : side === "buy"
                        ? tokenPage.buy
                        : tokenPage.sellToken}
                  </button>
                </div>
                {!publicKey && (
                  <div className="mt-4">
                    <ConnectWallet />
                  </div>
                )}
                {actionError && (
                  <p role="alert" className="form-error">
                    {actionError}
                  </p>
                )}
                {quote && (
                  <p className="mt-3 text-sm text-starlight/80">≈ {quote}</p>
                )}
                {status.state === "error" && (
                  <p className="mt-3 text-sm text-red-300">{status.message}</p>
                )}
                {status.state === "done" && (
                  <p className="mt-3 text-sm">
                    <a
                      href={EXPLORER("tx", status.signature!)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-ion"
                    >
                      Confirmed
                    </a>
                  </p>
                )}
                <p className="mt-4 text-xs text-starlight/50">
                  {bonding
                    ? "Trades go through Meteora's bonding curve."
                    : "Trades go through the graduated DAMM v2 pool."}
                </p>
              </>
            )}
          </Card>
        </div>
      )}
    </Shell>
  );
}
