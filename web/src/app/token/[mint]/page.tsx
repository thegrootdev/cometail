"use client";
import { api } from "@/lib/api";
import { friendlyError, insufficientSol, insufficientTokens } from "@/lib/errors";
import { AmountInput } from "@/components/AmountInput";
import { readTokenBalance, useSolBalance, useTokenBalance } from "@/lib/balances";
import { formatAmount, inputValue, parseAmount, share, spendable } from "@/lib/amounts";
import { isPairedMint, quoteAsset, quoteRate } from "@/lib/quotes";
import { pairedBuy, pairedSell, type PairedPlan } from "@/lib/paired";
import { useMarket, type MarketToken } from "@/lib/market";
import { formatUsd, usdValue } from "@/lib/usd";
import { CopyAddress } from "@/components/CopyAddress";
import { Money } from "@/components/Money";
import { SocialLinks } from "@/components/SocialLinks";
import { metadataLinks, shownName, shownSymbol, tickerText } from "@/lib/token-display";
import { TokenMarket, TokenTrades } from "@/components/Market";
import { OutsideCoinFees, type FeeCoinResult } from "@/components/OutsideCoin";
import { BurnPanel } from "@/components/BurnPanel";
import { TailPanel } from "@/components/TailPanel";
import { isOfficial } from "@/lib/addresses";
import { ourConfigs } from "@/lib/protocol-fees";
import { creatorClaims } from "@/lib/creator-fees";
// Token page: the curve while bonding, the graduated pool after, the tail's income meter,
// trades in both states, the creator's fee claim, and the door to selling the tail.
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PublicKey, Transaction } from "@solana/web3.js";
import { VAULT_PROGRAM_ID } from "@cometail/client";
import { useConnection } from "@solana/wallet-adapter-react";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import {
  DataState,
  TokenAvatar,
  BackToSky,
} from "@/components/Experience";
import { Shell, Stat, ConnectWallet } from "@/components/Shell";
import { tokenPage, amounts, experience as c, failures, tailsPage, tokenSimple as simple, paired as pairedCopy } from "@/content/cometail";
import { QuickStats, PriceChart, HolderList } from "@/components/TokenView";
import { ADDRESSES, EXPLORER } from "@/lib/addresses";
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
  return <TokenDetail key={mintStr} mintStr={mintStr} />;
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
  // a fee token's creator is the vault that launched it; a coin on a fee-sale config launched from a wallet (a tail
  // launched by our own wallet, or anyone's) has no vault behind it, so the vault's unwind note does not apply
  const creatorKey = view?.creator.toBase58() ?? "";
  const { data: creatorOwner } = useLoad(
    async () => (creatorKey ? (await connection.getAccountInfo(new PublicKey(creatorKey)))?.owner.toBase58() ?? "none" : null),
    [creatorKey],
  );
  const vaultBacked = creatorOwner === null ? null : creatorOwner === VAULT_PROGRAM_ID.toBase58();
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
  // what the Fee Index knows about the coin (any launchpad), including its logo read on the server
  const { data: feeResult, reload: reloadFee } = useLoad<NonNullable<FeeCoinResult>>(() => api.feeCoin(mintStr), [mintStr], 60_000);
  const feeCoin = feeResult?.state === "ok" ? feeResult.coin : null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [lower, setLower] = useState<"trades" | "holders">("trades");
  const [quote, setQuote] = useState<{ inRaw: bigint; out: bigint; minOut: bigint; side: "buy" | "sell"; plan?: PairedPlan; owner?: string; receive?: "sol" | "cometail" } | null>(null);
  // a coin paired with $COMETAIL: a sale returns SOL (the default) or keeps the $COMETAIL
  const [receive, setReceive] = useState<"sol" | "cometail">("sol");
  const quoteSeq = useRef(0);
  const market = useMarket<MarketToken>(`/api/tokens/${encodeURIComponent(mintStr)}`);
  const rate = quoteRate(market.data?.data.quoteMint === view?.quoteMint.toBase58() ? market.data?.data.quoteUsd : null, market.error ? null : market.data?.generatedAtMs);
  const quoteMint = view?.quoteMint ?? null;
  const nativeQuote = !!quoteMint?.equals(NATIVE_MINT);
  const quoteDecimals = view?.quoteDecimals ?? 9;
  const { data: quoteMeta } = useLoad(() => quoteMint && !nativeQuote ? readMetadata(connection, quoteMint) : Promise.resolve(null), [quoteMint?.toBase58()]);
  const asset = quoteAsset(quoteMint?.toBase58(), view?.quoteDecimals, nativeQuote ? null : quoteMeta?.symbol, market.data?.data.quoteUsd?.sol);
  // paired with $COMETAIL: buys are typed and paid in SOL, sales return SOL or $COMETAIL; amounts shown in SOL and dollars
  const pairedCoin = isPairedMint(quoteMint?.toBase58());
  const solAsset = quoteAsset("So11111111111111111111111111111111111111112");
  const solBalance = useSolBalance(publicKey);
  const tokenBalance = useTokenBalance(mint, publicKey);
  const quoteBalance = useTokenBalance(nativeQuote ? null : quoteMint, publicKey);
  const buyBalance = nativeQuote || pairedCoin ? solBalance.lamports : quoteBalance.raw;
  const buyDecimals = pairedCoin ? 9 : quoteDecimals;
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
  // the counter estimate is an upper bound (per-trade rounding), so already claimed is at most the gap
  const shown = creatorClaims(BigInt(creatorTotal.toString()), BigInt(claimable.toString()), view?.creatorFeePct ?? -1);
  const realized = new BN(shown.claimedAtMost.toString());
  // the main index tracks only the protocol's own configs; a coin from another launchpad never fills its market panel
  const ours = view ? ourConfigs().some((k) => k.config.toBase58() === new PublicKey(view.state.config).toBase58()) : true;
  const outside = !!view && !ours && !market.data;
  // the Fee Index logo is checked on the server (IPFS through a live gateway); the browser read is the fallback
  const logo = feeCoin?.imageUrl ?? artwork?.image ?? undefined;
  const isCreator = !!(publicKey && view && view.creator.equals(publicKey));
  const dec = view?.decimals ?? 6;
  const ticker = shownSymbol(mintStr, meta?.symbol) || "tokens";
  /** Lamports kept back on a buy for the network fee and the token account. */
  const TRADE_RESERVE = 10_000_000n;
  const amountRaw = () => {
    const raw = parseAmount(amount, side === "buy" ? buyDecimals : dec);
    return raw && raw > 0n ? new BN(raw.toString()) : null;
  };
  const quoteWithUsd = (lamports: bigint) => {
    const usd = usdValue(inputValue(lamports, quoteDecimals), rate);
    // Preserve quote-token units; USD is display-only and requires the matching fresh rate.
    return `${formatAmount(lamports, quoteDecimals, { ticker: asset.symbol, maxFraction: Math.min(quoteDecimals, 6) })}${usd === null ? "" : ` · ${formatUsd(usd)}`}`;
  };
  const solWithUsd = (lamports: bigint) => {
    const solRate = quoteRate(market.data?.solUsd ? { value: Number(market.data.solUsd.value), source: market.data.solUsd.source, status: market.data.solUsd.status === "ok" ? "fresh" : "stale" } : null, market.error ? null : market.data?.generatedAtMs);
    const usd = usdValue(inputValue(lamports, 9), solRate);
    return `${formatAmount(lamports, 9, { ticker: "SOL", maxFraction: 6 })}${usd === null ? "" : ` · ${formatUsd(usd)}`}`;
  };
  const cometailText = (raw: bigint) => { const v = asset.sol ? (Number(raw) / 1e6) * asset.sol : null; return `${formatAmount(raw, 6, { ticker: "$COMETAIL", maxFraction: 2 })}${v === null ? "" : ` · ≈ ${v >= 0.0001 ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v.toPrecision(2)} SOL`}`; };
  const buySymbol = pairedCoin ? solAsset.symbol : asset.symbol;
  const quickAmounts = side === "buy"
    ? [...["0.1", "0.5", "1"].map((v) => ({ label: `${v} ${buySymbol}`, value: v })), { label: amounts.max, value: buyBalance === null ? null : inputValue(nativeQuote || pairedCoin ? spendable(buyBalance, TRADE_RESERVE) ?? 0n : buyBalance, buyDecimals) }]
    : [25, 50, 75, 100].map((p) => ({ label: `${p}%`, value: tokenBalance.raw === null ? null : inputValue(share(tokenBalance.raw, p), dec) }));
  const dammPool = view
    ? derivedDammPool(mint, view.migrationFeeOption, view.quoteMint)
    : PublicKey.default;
  // the quote follows the typed amount: a short debounce, the newest request wins, the trade
  // quotes again when it is sent
  useEffect(() => {
    const raw = amountRaw();
    const seq = ++quoteSeq.current;
    if (!raw || !view || (!bonding && !graduated)) { setQuote(null); setQuoting(false); return; }
    setQuote(null); setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        let out: BN, minOut: BN;
        if (pairedCoin) {
          // the whole paired transaction is built for the quote and sent as reviewed (a placeholder owner until a wallet connects)
          const owner = publicKey ?? PublicKey.default;
          const venue = bonding ? { kind: "curve" as const, view } : { kind: "damm" as const, pool: dammPool, baseMint: mint, baseDecimals: dec };
          const plan = side === "buy" ? await pairedBuy(connection, owner, venue, raw) : await pairedSell(connection, owner, venue, raw, receive === "sol");
          if (seq !== quoteSeq.current) return;
          const toSol = side === "sell" && receive === "sol";
          setQuote({ inRaw: BigInt(raw.toString()), side, plan, owner: owner.toBase58(), receive,
            out: BigInt((side === "buy" ? plan.coinOut! : toSol ? plan.solOut! : plan.cometailOut!).toString()),
            minOut: BigInt((side === "buy" ? plan.coinMinOut! : toSol ? plan.solMinOut! : plan.cometailMinOut!).toString()) });
          setActionError(null);
          return;
        }
        if (bonding) {
          const q: any = await curveQuote(connection, view, raw, side === "sell");
          out = q.outputAmount; minOut = q.minimumAmountOut;
        } else {
          const q = await dammQuote(connection, dammPool, side === "buy" ? view.quoteMint : mint, raw, { a: dec, b: quoteDecimals });
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
    return () => { clearTimeout(timer); quoteSeq.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, receive, publicKey?.toBase58(), view?.quoteReserve?.toString(), view?.progress, view?.pool.toBase58(), quoteMint?.toBase58(), quoteDecimals, dec, status.state === "done" ? status.signature : null]);
  const trade = async () => {
    setActionError(null);
    try {
      const raw = amountRaw();
      if (!raw) { setActionError(tokenPage.enterAmount); return; }
      if (!view || !publicKey) return;
      // Check native fee funding separately from the input token, before the wallet prompt.
      const inputNeed = BigInt(raw.toString());
      const solNeed = TRADE_RESERVE + (side === "buy" && (nativeQuote || pairedCoin) ? inputNeed : 0n);
      const solHave = BigInt(await connection.getBalance(publicKey));
      if (solHave < solNeed) { setActionError(insufficientSol(solNeed, solHave)); return; }
      if (side === "sell" || (!nativeQuote && !pairedCoin)) {
        const inputMint = side === "buy" ? view.quoteMint : mint;
        const inputDecimals = side === "buy" ? quoteDecimals : dec;
        const inputTicker = side === "buy" ? asset.symbol : ticker;
        const have = await readTokenBalance(connection, inputMint, publicKey);
        if (have < inputNeed) { setActionError(insufficientTokens(formatAmount(inputNeed, inputDecimals, { ticker: inputTicker }), formatAmount(have, inputDecimals, { ticker: inputTicker }))); return; }
      }
      // the trade sends with the minimum the user reviewed: the displayed quote for this exact
      // amount and side, never a fresh one computed behind the display
      const reviewed = quote && quote.side === side && quote.inRaw === BigInt(raw.toString()) ? quote : null;
      if (!reviewed) { setActionError(tokenPage.quoteStale); return; }
      const minimumOut = new BN(reviewed.minOut.toString());
      let signature: string | null = null;
      if (pairedCoin) {
        // the reviewed transaction itself: both legs with the bounds shown; built for this wallet
        if (!reviewed.plan || reviewed.owner !== publicKey.toBase58() || reviewed.receive !== receive) { setActionError(tokenPage.quoteStale); return; }
        const plan = reviewed.plan;
        signature = await run(async () => new Transaction().add(...plan.instructions), [], 400_000);
      } else if (bonding) {
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
              side === "buy" ? view.quoteMint : mint,
              raw,
              { a: dec, b: quoteDecimals },
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
      quoteBalance.reload();
    } catch (e) {
      setActionError(friendlyError(e, failures.actionFailed));
    }
  };
  const marketToken = market.data?.data ?? null;
  const observedAt = market.error ? 0 : market.data?.generatedAtMs ?? 0;
  const tradeBox = view && (
    <section className="trade-box token-order-entry" aria-label={tokenPage.trades}>
      {bonding && vaultBacked !== false && ADDRESSES.streamConfigs.some((k) => k.equals(new PublicKey(view.state.config))) && (
        <p className="form-notice">{tokenPage.streamUnwindNote}</p>
      )}
      {pairedCoin && <p className="form-notice trade-paired">{pairedCopy.about}</p>}
      {!bonding && !graduated && <p className="trade-paused">{simple.migrating}</p>}
      {(bonding || graduated) && (
        <>
          <div className="trade-sides" role="group" aria-label={tokenPage.trades}>
            {(["buy", "sell"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={side === s}
                onClick={() => {
                  setSide(s);
                  setQuote(null);
                }}
                className={`trade-side-${s}`}
              >
                {s === "buy" ? tokenPage.buy : tokenPage.sellToken}
              </button>
            ))}
          </div>
          <AmountInput
            label={side === "buy" ? tokenPage.solIn : tokenPage.tokensIn}
            unit={side === "buy" ? buySymbol : ticker}
            value={amount}
            onChange={setAmount}
            balance={!publicKey ? undefined : side === "buy" ? (buyBalance === null ? null : formatAmount(buyBalance, buyDecimals, { ticker: buySymbol })) : (tokenBalance.raw === null ? null : formatAmount(tokenBalance.raw, dec, { ticker }))}
            quick={quickAmounts}
            hint={pairedCoin ? (side === "buy" && publicKey ? amounts.maxKeepsTradeFees : undefined) : !nativeQuote ? c.quoteFees : side === "buy" && publicKey ? amounts.maxKeepsTradeFees : undefined}
            disabled={status.state === "sending"}
          />
          {pairedCoin && side === "sell" && (
            <div className="trade-receive" role="group" aria-label={pairedCopy.receive}>
              <span>{pairedCopy.receive}</span>
              {(["sol", "cometail"] as const).map((r) => (
                <button key={r} type="button" aria-pressed={receive === r} onClick={() => { setReceive(r); setQuote(null); }}>{r === "sol" ? pairedCopy.receiveSol : pairedCopy.receiveCometail}</button>
              ))}
            </div>
          )}
          {(quote || quoting) && (
            <div className="quote-card" aria-busy={quoting} aria-live="polite">
              {quote && quote.plan ? (
                <>
                  {quote.side === "buy" ? <>
                    <div className="quote-row"><span>{tokenPage.youPay}</span><strong>{solWithUsd(BigInt((quote.plan.solIn ?? quote.plan.solMaxIn ?? 0).toString()))}</strong></div>
                    <div className="quote-row"><span>{pairedCopy.payAtMost}</span><strong>{solWithUsd(BigInt((quote.plan.solMaxIn ?? 0).toString()))}</strong></div>
                    <div className="quote-row"><span>{pairedCopy.through}</span><strong>{cometailText(BigInt(quote.plan.cometail.toString()))}</strong></div>
                    <div className="quote-row"><span>{tokenPage.youReceive}</span><strong>{formatAmount(quote.out, dec, { ticker })}</strong></div>
                    <div className="quote-row"><span>{tokenPage.minimum}</span><strong>{formatAmount(quote.minOut, dec, { ticker })}</strong></div>
                  </> : <>
                    <div className="quote-row"><span>{tokenPage.youSell}</span><strong>{formatAmount(quote.inRaw, dec, { ticker })}</strong></div>
                    <div className="quote-row"><span>{tokenPage.youReceive}</span><strong>{quote.receive === "sol" ? solWithUsd(quote.out) : cometailText(quote.out)}</strong></div>
                    <div className="quote-row"><span>{tokenPage.minimum}</span><strong>{quote.receive === "sol" ? solWithUsd(quote.minOut) : cometailText(quote.minOut)}</strong></div>
                  </>}
                  {quote.side === "buy" && quote.plan.nearCompletion && <p className="quote-note">{pairedCopy.nearCompletion}</p>}
                  <p className="quote-note">{quote.side === "sell" && quote.receive === "sol" && quote.plan.cometailKept.gtn(0) ? pairedCopy.kept(formatAmount(BigInt(quote.plan.cometailKept.toString()), 6, { ticker: "$COMETAIL", maxFraction: 2 })) : quote.side === "sell" ? pairedCopy.keepNote : pairedCopy.route}</p>
                </>
              ) : quote ? (
                <>
                  <div className="quote-row"><span>{quote.side === "buy" ? tokenPage.youPay : tokenPage.youSell}</span><strong>{quote.side === "buy" ? quoteWithUsd(quote.inRaw) : formatAmount(quote.inRaw, dec, { ticker })}</strong></div>
                  <div className="quote-row"><span>{tokenPage.youReceive}</span><strong>{quote.side === "buy" ? formatAmount(quote.out, dec, { ticker }) : quoteWithUsd(quote.out)}</strong></div>
                  <div className="quote-row"><span>{tokenPage.minimum}</span><strong>{quote.side === "buy" ? formatAmount(quote.minOut, dec, { ticker }) : quoteWithUsd(quote.minOut)}</strong></div>
                  <p className="quote-note">{tokenPage.quoteNote}</p>
                </>
              ) : (
                <p className="quote-note">{tokenPage.quoting}</p>
              )}
            </div>
          )}
          {publicKey ? (
            <button
              onClick={trade}
              disabled={!publicKey || status.state === "sending" || quoting || !quote || quote.side !== side || quote.inRaw !== (parseAmount(amount, side === "buy" ? buyDecimals : dec) ?? -1n) || (pairedCoin && (quote.owner !== publicKey.toBase58() || quote.receive !== receive))}
              className={`button button-full ${side === "buy" ? "button-primary" : "button-sell"}`}
            >
              {status.state === "sending"
                ? tokenPage.sending
                : side === "buy"
                  ? tokenPage.buy
                  : tokenPage.sellToken}
            </button>
          ) : (
            <div className="trade-connect"><ConnectWallet /></div>
          )}
          {actionError && (
            <p role="alert" className="form-error">
              {actionError}
            </p>
          )}
          {status.state === "error" && (
            <p className="form-error">{status.message}</p>
          )}
          {status.state === "done" && (
            <p className="trade-done">
              <a
                href={EXPLORER("tx", status.signature!)}
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                Confirmed ↗
              </a>
            </p>
          )}
        </>
      )}
    </section>
  );
  return (
    <Shell>
      <Link href="/" className="token-back">← {simple.back}</Link>
      <header className="token-top">
        <TokenAvatar seed={mintStr} image={logo} size="large" />
        <div className="token-top-text">
          <h1>{shownName(mintStr, meta?.name || feeCoin?.name) || short(mintStr)}</h1>
          <div className="token-top-sub">
            {tickerText(shownSymbol(mintStr, meta?.symbol)) && <span className="token-ticker">{tickerText(shownSymbol(mintStr, meta?.symbol))}</span>}
            {pairedCoin && <span className="token-paired">{pairedCopy.label}</span>}
            <span className="address-with-link"><CopyAddress address={mintStr} /><a className="address-explorer" href={EXPLORER("address", mintStr)} target="_blank" rel="noreferrer" aria-label="View the mint on the explorer">↗</a></span>
          </div>
        </div>
      </header>
      <SocialLinks links={artwork?.links} tokenName={shownName(mintStr, meta?.name) ?? undefined} />
      {!outside && <QuickStats token={marketToken} observedAt={observedAt} />}
      {!outside && (view || marketToken) && <PriceChart mint={mintStr} token={marketToken} observedAt={observedAt} />}
      {loading && <DataState kind="loading" />}
      {!loading && error && <DataState kind="error" onRetry={reload} />}
      {!loading && !error && !view && (
        <DataState kind="empty" title={c.missing} body={c.missingBody}>
          <BackToSky />
        </DataState>
      )}
      {view && (
        <div className="token-grid">
          <div className="token-main">
            {graduated ? (
              <section className="progress-card is-done">
                <div className="progress-head"><strong>{simple.graduatedTitle}</strong><span>100%</span></div>
                <div className="coin-bar is-done"><span style={{ width: "100%" }} /></div>
                <p>{simple.graduatedBody}</p>
              </section>
            ) : (
              <section className="progress-card">
                <div className="progress-head"><strong>{simple.progress}</strong><span>{progressPct < 10 ? progressPct.toFixed(1) : Math.round(progressPct)}%</span></div>
                <div className="coin-bar" role="progressbar" aria-label={simple.progress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressPct)}><span style={{ width: `${progressPct}%` }} /></div>
                <p>{simple.progressOf(formatAmount(BigInt(view.quoteReserve.toString()), quoteDecimals, { ticker: asset.symbol }), formatAmount(BigInt(view.threshold.toString()), quoteDecimals, { ticker: asset.symbol }))}</p>
              </section>
            )}
          </div>
          <div className="token-side">{tradeBox}</div>
        </div>
      )}
      {/* an outside coin's fees are in its Fee Index card below; this card stays only for its creator, to claim */}
      {view && (!outside || !!(publicKey && view.creator.equals(publicKey))) && (
        <section className="panel creator-card">
          <h2 className="panel-heading">{simple.creatorFees}</h2>
          <p className="creator-body">{simple.creatorFeesBody}</p>
          <div className="creator-stats">
            <Stat
              label={simple.claimable}
              value={<Money lamports={claimable.toString()} quote={asset} quoteRate={rate} />}
              tone="dust"
            />
            <Stat label={shown.lifetimeExact ? c.curveClaimed : c.curveEstimate} value={shown.noneClaimed ? c.curveNothingClaimed : <Money lamports={realized.toString()} quote={asset} quoteRate={rate} />} />
          </div>
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
              className="button button-gold button-full"
            >
              {tokenPage.claim}
            </button>
          )}
          {nativeQuote && (
            <Link href={`/sell?pool=${pool.toBase58()}`} className="button button-secondary button-full">
              {tokenPage.sellTail} ↗
            </Link>
          )}
          <details className="creator-more">
            <summary>{simple.feesMore}</summary>
            <p className="caption">{tokenPage.tailBody}</p>
            <p className="caption">{c.curveEstimateBody}</p>
          </details>
        </section>
      )}
      <TailLink mint={mintStr} pool={marketToken?.dammPool ?? null} />
      {isOfficial(mintStr) && <BurnPanel />}
      {!isOfficial(mintStr) && <TailPanel mint={mintStr} />}
      {outside && <OutsideCoinFees result={feeResult} pool={view ? pool.toBase58() : null} isCreator={!!(publicKey && view && view.creator.equals(publicKey))} onRetry={reloadFee} />}
      {view && !outside && (
        <section className="token-tabs">
          <div className="feed-tabs" role="tablist" aria-label={simple.trades}>
            {(["trades", "holders"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={lower === k} onClick={() => setLower(k)}>{k === "trades" ? simple.trades : simple.holderTab}</button>
            ))}
          </div>
          {lower === "trades"
            ? <TokenTrades mint={mintStr} onChain={!!view} decimals={dec} symbol={shownSymbol(mintStr, meta?.symbol)} quote={asset} rate={rate} />
            : <section className="holders-card"><h2 className="sr-only">{simple.holdersTitle}</h2><HolderList mint={mintStr} creator={view.creator.toBase58()} decimals={dec} /></section>}
        </section>
      )}
      <details className="glass-details">
        <summary>{simple.details}</summary>
        {!outside && <TokenMarket mint={mintStr} onChain={!!view} />}
        {view && (
          <dl className="detail-list">
            <div><dt>{simple.detailsStage}</dt><dd>{STAGE[view.progress]}</dd></div>
            <div><dt>{simple.creatorAddress}</dt><dd><a className="text-link" href={EXPLORER("address", view.creator.toBase58())} target="_blank" rel="noreferrer">{short(view.creator.toBase58())} ↗</a></dd></div>
            <div><dt>{simple.curvePool}</dt><dd><a className="text-link" href={EXPLORER("address", pool.toBase58())} target="_blank" rel="noreferrer">{short(pool.toBase58())} ↗</a></dd></div>
            {graduated && <div><dt>{simple.graduatedPool}</dt><dd><a className="text-link" href={EXPLORER("address", dammPool.toBase58())} target="_blank" rel="noreferrer">DAMM v2 {short(dammPool.toBase58())} ↗</a></dd></div>}
          </dl>
        )}
        {view && (bonding || graduated) && <p>{simple.route(bonding)}</p>}
      </details>
    </Shell>
  );
}

/** The tails this coin's fees fund (a vault holding them) and the wallet tails that feed this coin (their claims add
 *  liquidity to its pool): links to each and to the Tails page. */
function TailLink({ mint, pool }: { mint: string; pool: string | null }) {
  const [vaults, setVaults] = useState<string[]>([]);
  const [feeders, setFeeders] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    // every vault holding this coin's fees, on any launchpad's config (the worker joins streams by source mint)
    void api.tails({ source: mint, limit: 100 }).then((r) => { if (live && r) setVaults(r.tails.map((t) => t.vault)); });
    if (pool) void api.tailList().then((r) => { if (live && r) setFeeders(r.tails.filter((t) => t.targetPool === pool).map((t) => t.mint)); });
    return () => { live = false; };
  }, [mint, pool]);
  if (!vaults.length && !feeders.length) return null;
  return (
    <p className="form-notice mt-3">
      {vaults.length > 0 && <>{tailsPage.fromCoin}: {vaults.map((v, i) => <span key={v}>{i ? ", " : ""}<Link className="text-link" href={`/vault/${v}`}>{short(v)} ↗</Link></span>)} · </>}
      {feeders.length > 0 && <>{tailsPage.feedsCoin}: {feeders.map((m, i) => <span key={m}>{i ? ", " : ""}<TailName mint={m} /></span>)} · </>}
      <Link className="text-link" href="/tails">{tailsPage.title} ↗</Link>
    </p>
  );
}
function TailName({ mint }: { mint: string }) {
  const m = useMarket<MarketToken>(`/api/tokens/${encodeURIComponent(mint)}`);
  return <Link className="text-link" href={`/token/${mint}`}>{tickerText(shownSymbol(mint, m.data?.data?.symbol)) || short(mint)}</Link>;
}
