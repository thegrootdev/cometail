"use client";
import { friendlyError, insufficientSol, insufficientTokens } from "@/lib/errors";
import { AmountInput } from "@/components/AmountInput";
import { readTokenBalance, useSolBalance, useTokenBalance } from "@/lib/balances";
import { formatAmount, inputValue, parseAmount, share, spendable } from "@/lib/amounts";
import { useSolUsd } from "@/lib/prices";
import { formatUsd, usdValue } from "@/lib/usd";
import { CopyAddress } from "@/components/CopyAddress";
import { Money } from "@/components/Money";
import { SocialLinks } from "@/components/SocialLinks";
import { metadataLinks } from "@/lib/token-display";
import { TokenMarket, TokenTrades } from "@/components/Market";
// Token page: the curve while bonding, the graduated pool after, the tail's income meter,
// trades in both states, the creator's fee claim, and the door to selling the tail.
import { use, useEffect, useRef, useState } from "react";
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
import { tokenPage, amounts, experience as c, failures } from "@/content/cometail";
import { EXPLORER } from "@/lib/addresses";
import {
  claimCreatorFeesTx,
  curveQuote,
  curveSwapTx,
  dbcState,
  derivedDammPool,
  loadPool,
  readMetadata,
  MigrationProgress,
} from "@/lib/dbc";
import { dammQuote, dammSwapTx } from "@/lib/damm";
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
      const found = await dbcState(connection).getPoolByBaseMint(mint);
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
    return { image: typeof data.image === "string" && /^https?:\/\//.test(data.image) ? data.image as string : undefined, links: metadataLinks(data) };
  }, [meta?.uri]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quote, setQuote] = useState<{ inRaw: bigint; out: bigint; minOut: bigint; side: "buy" | "sell" } | null>(null);
  const quoteSeq = useRef(0);
  const rate = useSolUsd();
  const solBalance = useSolBalance(publicKey);
  const tokenBalance = useTokenBalance(mint, publicKey);
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
  const ticker = meta?.symbol || "tokens";
  /** Lamports kept back on a buy for the network fee and the token account. */
  const TRADE_RESERVE = 10_000_000n;
  const amountRaw = () => {
    const raw = parseAmount(amount, side === "buy" ? 9 : dec);
    return raw && raw > 0n ? new BN(raw.toString()) : null;
  };
  const solWithUsd = (lamports: bigint) => {
    const usd = usdValue(inputValue(lamports, 9), rate);
    // small SOL amounts keep six decimals so a minimum after slippage never reads the same as the quote
    return `${formatAmount(lamports, 9, { ticker: "SOL", maxFraction: lamports < 100_000_000n ? 6 : 4 })}${usd === null ? "" : ` · ${formatUsd(usd)}`}`;
  };
  const quickAmounts = side === "buy"
    ? [...["0.1", "0.5", "1"].map((v) => ({ label: `${v} SOL`, value: v })), { label: amounts.max, value: solBalance.lamports === null ? null : inputValue(spendable(solBalance.lamports, TRADE_RESERVE) ?? 0n, 9) }]
    : [25, 50, 75, 100].map((p) => ({ label: `${p}%`, value: tokenBalance.raw === null ? null : inputValue(share(tokenBalance.raw, p), dec) }));
  const dammPool = view
    ? derivedDammPool(mint, view.migrationFeeOption)
    : PublicKey.default;
  // the quote follows the typed amount: a short debounce, the newest request wins, the trade
  // quotes again when it is sent
  useEffect(() => {
    const raw = amountRaw();
    const seq = ++quoteSeq.current;
    if (!raw || !view || (!bonding && !graduated)) { setQuote(null); setQuoting(false); return; }
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        let out: BN, minOut: BN;
        if (bonding) {
          const q: any = await curveQuote(connection, view, raw, side === "sell");
          out = q.outputAmount; minOut = q.minimumAmountOut;
        } else {
          const q = await dammQuote(connection, dammPool, side === "buy" ? NATIVE_MINT : mint, raw, { a: dec, b: 9 });
          out = q.out; minOut = q.minOut;
        }
        if (seq !== quoteSeq.current) return;
        setQuote({ inRaw: BigInt(raw.toString()), out: BigInt(out.toString()), minOut: BigInt(minOut.toString()), side });
        setActionError(null);
      } catch (e) {
        if (seq !== quoteSeq.current) return;
        setQuote(null);
        setActionError(friendlyError(e, failures.quoteFailed));
      } finally {
        if (seq === quoteSeq.current) setQuoting(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, view?.quoteReserve?.toString(), view?.progress, dec, status.state === "done" ? status.signature : null]);
  const trade = async () => {
    setActionError(null);
    try {
      const raw = amountRaw();
      if (!raw) { setActionError(tokenPage.enterAmount); return; }
      if (!view || !publicKey) return;
      // a buy needs the SOL plus network and account fees, a sell needs the tokens: say so before
      // the wallet prompt, from a fresh read
      if (side === "buy") {
        const need = BigInt(raw.toString()) + TRADE_RESERVE;
        const have = BigInt(await connection.getBalance(publicKey));
        if (have < need) { setActionError(insufficientSol(need, have)); return; }
      } else {
        const need = BigInt(raw.toString());
        const have = await readTokenBalance(connection, mint, publicKey);
        if (have < need) { setActionError(insufficientTokens(formatAmount(need, dec, { ticker }), formatAmount(have, dec, { ticker }))); return; }
      }
      // the trade sends with the minimum the user reviewed: the displayed quote for this exact
      // amount and side, never a fresh one computed behind the display
      const reviewed = quote && quote.side === side && quote.inRaw === BigInt(raw.toString()) ? quote : null;
      if (!reviewed) { setActionError(tokenPage.quoteStale); return; }
      const minimumOut = new BN(reviewed.minOut.toString());
      let signature: string | null = null;
      if (bonding) {
        signature = await run(
          () =>
            curveSwapTx(
              connection,
              pool,
              publicKey,
              raw,
              minimumOut,
              side === "sell",
            ),
          [],
          300_000,
        );
      } else if (graduated) {
        signature = await run(
          () =>
            dammSwapTx(
              connection,
              dammPool,
              publicKey,
              side === "buy" ? NATIVE_MINT : mint,
              raw,
              { a: dec, b: 9 },
              1,
              minimumOut,
            ).then((r) => r.tx),
          [],
          300_000,
        );
      }
      if (signature) setAmount("");
      reload();
      solBalance.reload();
      tokenBalance.reload();
    } catch (e) {
      setActionError(friendlyError(e, failures.actionFailed));
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
        <div className="token-header-identity"><TokenAvatar seed={mintStr} image={artwork?.image} size="large" /><span className="address-with-link"><CopyAddress address={mintStr} /><a className="address-explorer" href={EXPLORER("address", mintStr)} target="_blank" rel="noreferrer" aria-label="View the mint on the explorer">↗</a></span></div>
      </PageHeader>
      <SocialLinks links={artwork?.links} tokenName={meta?.name} />
      <div className="detail-address">
        {view && (
          <Link
            href={`/sell?pool=${pool.toBase58()}`}
            className="button button-secondary"
          >
            {tokenPage.sellTail} ↗
          </Link>
        )}
      </div>
      <TokenMarket mint={mintStr} onChain={!!view} />
      {loading && <DataState kind="loading" />}
      {!loading && error && <DataState kind="error" onRetry={reload} />}
      {!loading && !error && !view && (
        <DataState kind="empty" title={c.missing} body={c.missingBody}>
          <BackToSky />
        </DataState>
      )}
      {view && (
        <>
        <div className="token-execution-grid mt-6 grid gap-6 md:grid-cols-[3fr_2fr]">
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
                  value={<Money lamports={claimable.toString()} />}
                  tone="dust"
                />
                <Stat label={c.curveEstimate} value={<Money lamports={realized.toString()} />} />
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
          <Card title={tokenPage.trades} className="token-order-entry">
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
                <AmountInput
                  label={side === "buy" ? tokenPage.solIn : tokenPage.tokensIn}
                  unit={side === "buy" ? "SOL" : ticker}
                  value={amount}
                  onChange={setAmount}
                  balance={!publicKey ? undefined : side === "buy" ? (solBalance.lamports === null ? null : formatAmount(solBalance.lamports, 9, { ticker: "SOL" })) : (tokenBalance.raw === null ? null : formatAmount(tokenBalance.raw, dec, { ticker }))}
                  quick={quickAmounts}
                  hint={side === "buy" && publicKey ? amounts.maxKeepsTradeFees : undefined}
                  disabled={status.state === "sending"}
                />
                {(quote || quoting) && (
                  <div className="quote-card" aria-busy={quoting} aria-live="polite">
                    {quote ? (
                      <>
                        <div className="quote-row"><span>{quote.side === "buy" ? tokenPage.youPay : tokenPage.youSell}</span><strong>{quote.side === "buy" ? solWithUsd(quote.inRaw) : formatAmount(quote.inRaw, dec, { ticker })}</strong></div>
                        <div className="quote-row"><span>{tokenPage.youReceive}</span><strong>{quote.side === "buy" ? formatAmount(quote.out, dec, { ticker }) : solWithUsd(quote.out)}</strong></div>
                        <div className="quote-row"><span>{tokenPage.minimum}</span><strong>{quote.side === "buy" ? formatAmount(quote.minOut, dec, { ticker }) : solWithUsd(quote.minOut)}</strong></div>
                        <p className="quote-note">{tokenPage.quoteNote}</p>
                      </>
                    ) : (
                      <p className="quote-note">{tokenPage.quoting}</p>
                    )}
                  </div>
                )}
                <div className="mt-3 flex gap-3">
                  <button
                    onClick={trade}
                    disabled={!publicKey || status.state === "sending" || quoting || !quote || quote.side !== side || quote.inRaw !== (parseAmount(amount, side === "buy" ? 9 : dec) ?? -1n)}
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
        <TokenTrades mint={mintStr} onChain={!!view} decimals={dec} symbol={meta?.symbol ?? null} />
        </>
      )}
    </Shell>
  );
}
