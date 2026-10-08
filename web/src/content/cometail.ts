// Every user-facing name, ticker and line of copy lives here. Nothing else in the app
// hardcodes product wording, so a copy review is a review of this one file.

export const product = {
  name: "COMETAIL",
  tagline: "Launch a comet. Sell the tail.",
  domain: "cometail.fun",
  url: "https://cometail.fun",
  description:
    "A Meteora DBC launchpad where every launch grows a tail of fees, and a market where any creator can sell that tail.",
  protocolTicker: "$TAIL",
  streamTickerPrefix: "t",
  builtOn: "Built on Meteora",
  socialX: "COMETAIL on X",
  socialGithub: "COMETAIL on GitHub",
  x: "https://x.com/cometailfun",
  xHandle: "@cometailfun",
  github: "https://github.com/thegrootdev/cometail",
  devnetBadge: "Devnet",
  clusterNote:
    "This deployment runs on Solana devnet with test tokens. Nothing here has value.",
} as const;

/** What the user reads when something fails. Raw error text never reaches the page. */
export const failures = {
  serviceBadResponse:
    "The upload service didn’t answer properly, so nothing was sent to the chain. Try again in a minute. If it keeps happening, tell us on X.",
  imagingNotReady:
    "Image processing isn’t available on this deployment right now. Nothing was sent to the chain. Try again later.",
  storageNotReadyTitle: "Launching is paused on this deployment",
  storageNotReadyBody:
    "Image storage isn’t connected yet, so token identities can’t be saved. Browsing, trading and vault actions still work. Check back soon.",
  storageChecking: "Checking that uploads are ready…",
  walletRejected: "You declined in your wallet. Nothing was sent.",
  notEnoughSol: "Not enough SOL in this wallet for the transaction and its fees. Add SOL and try again.",
  txExpired:
    "The network didn’t confirm in time. Check your wallet’s activity before trying again, so you don’t send it twice.",
  busy: "The network is busy right now. Wait a moment and try again.",
  quoteFailed: "That amount can’t be filled at the moment. Try a smaller amount.",
  unwindTooEarly: "The thirty days since launch have not passed yet. Nothing was sent.",
  unwindGraduated: "The curve reached its threshold, so this vault graduates instead of unwinding. Nothing was sent.",
  registerPositionFirst: "This stream's pool has migrated, and its creator position must be registered on the stream before it can leave. Use \"Register the migrated position\" first, then withdraw. Nothing was sent.",
  txFailed: "The transaction didn’t go through. Nothing was charged beyond network fees. Try again, and tell us on X if it keeps failing.",
  txTooLarge: "This action does not fit in one transaction, so nothing was sent to your wallet. Tell us on X.",
  simulationFailed: "A dry run of this action failed, so nothing was sent to your wallet.",
  simulationReason: "Reason:",
  identityTooLong: "The name or symbol is too long for the chain: up to 32 bytes for the name and 10 for the symbol, including the fee-token prefix. Nothing was sent.",
  uriTooLong: "The metadata link produced for this token is too long for the chain (200 characters). Nothing was sent. Tell us on X.",
  walletCannotSign: "This wallet cannot sign without sending. Use Phantom or another wallet that supports signing.",
  actionFailed: "That didn’t work. Try again in a moment.",
} as const;

export const nav = {
  home: "Coins",
  launch: "Launch",
  sell: "Sell fees",
  sky: "All tokens",
  fees: "Fee Index",
  portfolio: "Portfolio",
} as const;

export const feeIndex = {
  eyebrow: "Every Meteora launchpad",
  title: "Fee Index",
  short: "Which Meteora coins pay their creators the most, from every launchpad.",
  about: "About the Fee Index",
  details: "How these numbers are counted",
  creatorShare: "Creator share",
  body: "Every SOL-paired Meteora coin that has paid its creator, from any launchpad: what the creator earns, what is waiting to be claimed, and whether those fees can launch a tail.",
  coverage: (pools: string, configs: string, at: string) => `${pools} coins on ${configs} configs, updated ${at}.`,
  coverageNote: "Curve fees only: fees on the creator's locked pool position after graduation are not in this number.",
  coins: "Coins", launchpads: "Launchpads", tails: "Tails",
  sort: "Sort", sortDay: "Last 24 hours", sortClaimable: "Claimable now", sortLifetime: "Lifetime", sortAvg: "Average per day",
  stage: "Stage", all: "All", bonding: "On the curve", graduated: "Graduated", migrating: "Moving to its pool",
  eligibleOnly: "Can launch a tail", mine: "My coins", search: "Name, symbol or mint",
  coin: "Coin", launchpad: "Launchpad", last24h: "Creator · 24 h (est.)", lifetime: "Creator · lifetime (est.)", claimable: "Claimable now (exact)",
  noneClaimed: "nothing claimed yet: all of it is claimable", claimed: "already claimed", claimedAtMost: "already claimed, at most", tail: "Tail",
  ours: "COMETAIL", canTail: "Config allows a tail", cannotTail: "Cannot launch a tail", window: (h: number) => (h === 0 ? "no history yet" : `over ${h} h only`),
  tailNote: "The deposit also checks the coin's mint (no freeze authority, metadata-only extensions).",
  estimateNote: "Claimable now is exact: it is what the creator's claim pays today. Lifetime is the pool's lifetime fee counter times the creator's share. Meteora rounds that share down on every trade, so lifetime can be a little high, by under a lamport per trade (it is exact at a 100% share). Already claimed is therefore at most lifetime minus claimable, and nothing has been claimed only when the two are equal. The 24-hour figure is an estimate the same way.",
  rankedByLifetime: (since: string) => `Ranked by lifetime: the index has held 24-hour history only since ${since}.`, rankedByDay: "Ranked by the last 24 hours, then lifetime.",
  shorter: (n: number) => `${n} with less than 24 h of history`, notCovered: "Not SOL-quoted: outside the Fee Index, and the vault takes SOL-quoted fees only.",
  sell: "Sell these fees", empty: "No coins match.", emptyBody: "Clear the filters, or come back after the next update.",
  unavailable: "The Fee Index is not available on this server yet.", more: "Show more",
  searching: "Searching…", searchingBody: "Searching every coin can take up to half a minute.",
  searchFailed: "The search could not be completed.", searchFailedBody: "Try again in a moment.",
  lpTitle: "Launchpads ranked by what their creators earn",
  lpBody: "Grouped by each launchpad's fee-claiming wallet. The protocol's own configs are marked.",
  lpCoins: "Coins", lpEligible: "Tail-ready", lpDay: "Creators · 24 h (est.)", lpLife: "Creators · lifetime (est.)", lpClaimable: "Unclaimed",
  oursTitle: "Launch on COMETAIL's configs",
  oursBody: "The six launch presets, each a Meteora DBC config. Any app can create a coin on them with Meteora's own SDK. On the SOL-quoted presets the creator can sell those fees here; the stock presets quote in USDC or xStock, which the vault does not take.",
  copy: "Copy", copied: "Copied", wallet: "Fee wallet", configLabel: "Config",
} as const;

/** $COMETAIL buyback and burn (components/BurnPanel.tsx, docs/burn.md). */
/** A tail's page (components/TailPanel.tsx). The split is ours, done by hand: the copy never says code forces it. */
export const tailPage = {
  title: (target: string) => `A tail of ${target}`,
  tagline: (target: string) => `Every claim of this coin's fees burns ${target} and deepens its pool.`,
  how: (target: string) => `We launched this coin from our own wallet. When we claim its creator fees, we split them in the same transaction: half stays with us, a quarter goes to the ${target} burn (which can only buy ${target} and burn it), and a quarter is added to ${target}'s pool as liquidity that is locked forever.`,
  honest: "No program forces this split. We do it by hand, in the open, and every claim is listed below with its transaction, so you can check each one.",
  graduation: (pct: number) => `When the curve fills, it graduates to its own pool. ${pct}% of what the curve raised goes to the creator (our wallet); the rest is locked in that pool as liquidity. After graduation, the fees from our locked share of that pool are claimed through the burn program, which sends half to the $COMETAIL burn by itself.`,
  sentToBurn: "Sent to the burn", burned: (target: string) => `${target} burned with it`, liquidity: "Liquidity locked", claims: "Claims",
  pending: "not yet known", waiting: (sol: string) => `${sol} SOL still waiting for a buyback`, waitingAll: "waiting for the next buybacks",
  list: (n: number) => `Every claim (${n})`, none: "No claims yet.", claimed: "Claimed", kept: "Kept", toBurn: "To the burn", added: "Locked as liquidity",
  tx: "Transaction", buybacks: "Buybacks that spent it", loading: "Reading this tail's claims…", unavailable: "The tail's claims are not answering right now.",
  partial: "Still reading the history: some claims may be missing.",
} as const;

export const burnPanel = {
  title: "$COMETAIL buyback and burn",
  body: "Half of the protocol's fees buy $COMETAIL on its pool and burn it, on chain.",
  everyBurn: (n: number) => `Every burn (${n}) and how it's counted`,
  loading: "Reading the burn program…",
  unavailable: "The burn figures are not answering right now.",
  notSetUp: "The burn program is not set up on this network yet.",
  unknown: "unknown",
  burned: "Burned", spent: "SOL spent", buybacks: "Buybacks", reserve: "Waiting to buy",
  dueNow: (sol: string) => `A buyback of ${sol} SOL can run now; the keeper runs it within minutes, and anyone can.`,
  dueAt: (t: string) => `Next buyback can run after ${t} (one every ten minutes at most).`,
  waitingForFunds: "Waiting for the reserve to reach the 0.001 SOL minimum.",
  nextUnknown: "The next buyback time is unknown right now.",
  claimedThroughProgram: "Fees the program claimed (new configs)", claimedByOwners: "Fees owners claimed through the program", carried: "Sent to its inbox and split",
  toReserve: "Half to the burn reserve", toTreasury: "Other half (treasury, or the claiming owner)",
  sentDirect: "Sent to the reserve directly", tailsShare: "Tails' protocol share received", olderClaims: "Older configs' fees claimed",
  claimableNow: "Waiting to be claimed (new configs)", supply: "$COMETAIL supply now",
  accountingNote: "Exact: the program's own counters, the reserve and the supply, read together. What each claim paid is measured by the program; those sums need the whole history read, and show unknown until it is. The program splits the new launch configs' fees 50/50; owners claiming older configs through it get exactly half back. Older claims made elsewhere, and the tails' share, reach the reserve as direct transfers.",
  listTitle: (shown: number, total: number) => (total > shown ? `Burns (newest ${shown} of ${total})` : `Every burn (${total})`), showMore: "Show older burns", historyPartial: "History is still loading; some burns may be missing below.", historyUnavailable: "Burn history is not available right now.",
  noBurns: "No burns yet.", program: "Burn program", more: "All burns",
} as const;

/** A coin from another launchpad on its token page: the Fee Index panel in place of the market panel. */
export const outsideCoin = {
  title: "Creator fees · Fee Index",
  body: "This coin launched on another Meteora launchpad. COMETAIL does not chart its market; the Fee Index reads what its creator earns straight from the chain.",
  loading: "Reading the Fee Index…",
  notListed: "Not in the Fee Index: it lists SOL-paired coins once their creator has earned fees.",
  claimable: "Claimable now (exact)", lifetime: "Creator · lifetime (est.)", day: "Creator · 24 h (est.)", avg: "Average per day (est.)",
  window: (h: number) => `(${h < 1 ? "under 1" : Math.floor(h)} h of history)`,
  noneClaimed: "Nothing claimed yet: all of it is claimable.", claimed: "Already claimed", claimedAtMost: "Already claimed, at most",
  exactNote: "Claimable is exactly what the creator's claim pays today. Lifetime can be a little high: Meteora rounds the creator's share down on every trade.",
  unavailable: "The Fee Index is not answering right now.", retry: "Try again",
  stage: "Stage", graduated: "Graduated", bonding: "On its curve", migrating: "Migrating", creatorShare: (pct: number) => `creator ${pct}% of trading fees`,
  launchpad: "Launchpad", ours: "COMETAIL", wallet: "Wallet", creator: "Creator",
  tail: "Tail", canTail: "Its fees can launch a tail", cannotTail: "Its config cannot launch a tail",
  sell: "Sell these fees", trades: "Trades on the explorer", index: "Fee Index",
} as const;

export const tailsPage = {
  eyebrow: "Fee tokens",
  title: "Tails",
  body: "Every tail: a token launched on a coin's future fees. Its fees buy the tail back below the market and burn what they buy.",
  source: "Fees from", raise: "Raise", flowing: "Fees in", buybacks: "Buybacks filled", placed: (sol: string) => `placed ${sol}`.trimEnd() + " ", burned: "Tail tokens burned", unwind: "Unwind opens",
  unavailable: "unavailable", more: "Show more", of: (n: number, total: number) => `${n} of ${total}`,
  live: "Live", launched: "On its curve", open: "Not launched", unwound: "Unwound",
  empty: "No tails yet.", unwindAvailable: "open now", noUnwind: "not applicable",
  fromCoin: "This coin's fees fund a tail",
} as const;

export const hero = {
  title: "Got a coin that still earns fees? Sell those future fees for SOL today.",
  titleLine1: "Got a coin that still earns fees?",
  titleLine2: "Sell those future fees for SOL today.",
  body: "Or launch a new coin here: 0.01 SOL, a fair price curve on Meteora, and 60% of every trading fee is yours on the curve, 32% once it trades in its pool.",
  launch: "Launch a token",
  sell: "Sell my coin's fees",
} as const;

export const sky = {
  title: "All tokens",
  body: "Every coin launched or tracked here, drawn as a comet. The longer the tail, the more fees it has earned.",
  legend: {
    claimable: "ready to claim",
    realized: "collected, 30 days",
    locked: "locked liquidity",
  },
  position: "Locked position",
  ofLocked: "of the locked liquidity",
} as const;

export const tokenPage = {
  sending: "Sending…",
  curve: "Bonding curve",
  progress: "to graduation",
  trades: "Trades",
  tail: "Fees this coin earns",
  tailBody: "Creator fees this coin has earned, on its curve and in its pool.",
  claim: "Claim creator fees",
  sellTail: "Sell this coin's future fees",
  buy: "Buy",
  sellToken: "Sell",
  enterAmount: "Enter an amount to get a quote.",
  solIn: "You pay",
  tokensIn: "You sell",
  quoting: "Getting a quote…",
  youPay: "You pay",
  youSell: "You sell",
  youReceive: "You receive about",
  minimum: "Minimum after 1% slippage",
  quoteNote: "Quotes follow the pool as you type; the trade sends with the minimum shown, or fails rather than take less.",
  quoteStale: "The quote changed while you were trading. Review the new minimum and try again.",
  confirmed: "Confirmed",
  refreshing: "Updating balances…",
  streamUnwindNote: "This fee token uses another coin's future fees to fund buybacks and burns. Holding it does not give you a right to those fees. If its curve is still below its target thirty days after launch, the seller can close the vault behind it and take those fee rights back. The token keeps trading on this curve either way.",
} as const;

export const amounts = {
  balance: "Balance",
  balanceUnknown: "…",
  quick: "Quick amounts",
  max: "MAX",
  maxKeepsFees: "MAX keeps enough SOL for the launch fee and network fees.",
  maxKeepsTradeFees: "MAX keeps 0.01 SOL for network and account fees.",
} as const;

export const vaultPage = {
  streams: "Fee sources in this vault",
  income: "Fees collected",
  cashout: "Payout at completion",
  ladder: "Buyback orders",
  depth: "Standing buy orders, by price",
  resting: "resting",
  crossed: "crossed, settling",
  filled: "filled",
  partial: "partly filled",
  unknownFill: "fill state unread",
  ladderUnavailable: "The standing buy orders could not be read just now.",
  poolPrice: "Pool price now",
  noBins: "No buy orders resting right now.",
  lockedShare: "of the locked liquidity",
  ladderBody:
    "Buy orders below the current price, funded by the fees this vault collects. Whatever they buy is burned.",
  burned: "Burned so far",
  bids: "Orders resting",
  cap: "Price cap",
  disclosure:
    "Realized fees fund finite standing buy orders at public limit prices. Holders of this token have no redemption claim and no guaranteed price floor. Orders can exhaust; fee income and market prices can fall. Burning reduces supply but does not guarantee appreciation. Bid placement remains exposed to manipulation and adverse selection. This vault is a disclosed, rule-bound buyback mechanism, not a redeemable claim on income.",
  authority:
    "The vault program is upgradeable by the protocol owner and that is not planned to change. Meteora's DBC and DAMM v2 programs are upgradeable by Meteora, and a Meteora operator can change how much of a compounding pool's fees are claimable. Every number on this page depends on those facts.",
  noGraduation:
    "If this fee token's curve never reaches its target, the seller is not stuck. Thirty days after launch, while the curve is still below its target, the seller can unwind: the fee rights go back to the seller's wallet with any fees the vault collected from them, and the vault closes for good. The fee token keeps trading on its curve, so holders can sell back; a later completion is no longer possible for that vault.",
  unwind: {
    title: "Unwind this vault",
    sending: "Sending…",
    readFailed: "We could not check the curve. Retry to see whether this vault can unwind.",
    retry: "Check again",
    bodyWaiting: "If the curve is still below its threshold by then, you can unwind from",
    bodyReady: "Thirty days have passed and the curve is still below its target. You can close this vault for good and take your fees back.",
    whatHappens: "Your fee rights return to your wallet, with the fees the vault collected from them. The fee token keeps trading on its curve; holders can sell back. This cannot be undone.",
    action: "Unwind and take my fees back",
    done: "Unwound. Withdraw each fee source below to move it back to your wallet.",
    unwound: "This vault was unwound by its seller. Its fee sources have gone or are going back to the seller; nothing runs here any more.",
    graduatedInstead: "The curve reached its threshold, so this vault graduates instead of unwinding.",
    tooEarly: "The thirty days since launch have not passed yet.",
    checking: "Reading the curve…",
    incomeReturned: "Returned to the seller at unwind",
    registerPosition: "Register the migrated position",
    registerPositionWhy: "This stream's pool has migrated. Its creator position is registered on the stream first, then both leave together.",
    noPositionYet: "The migrated position was not found on the vault yet. Try again in a moment.",
  },
} as const;

export const wizard = {
  title: "Sell your fees",
  intro:
    "Pick the fees you own, choose how much of the raise you take when the curve completes, and launch them as a fee token.",
  presets: [
    {
      key: "stream-25",
      label: "Take 25%",
      body: "When the curve completes, 25% of the raise is yours and 75% becomes permanently locked liquidity.",
    },
    {
      key: "stream-50",
      label: "Take 50%",
      body: "When the curve completes, half of the raise is yours and half becomes permanently locked liquidity.",
    },
    {
      key: "stream-75",
      label: "Take 75%",
      body: "When the curve completes, 75% of the raise is yours and 25% becomes permanently locked liquidity.",
    },
  ],
  withdrawLock:
    "Fee rights can be withdrawn until you launch. A coin whose curve has completed but not moved to its pool yet cannot be moved until it does.",
  irreversible: "Launching is final while the curve runs. If the curve is still below its target thirty days after launch, you can unwind: your fee rights come back with whatever the vault collected, and the vault closes for good.",
  connect: "Connect the wallet that owns the creator fee rights or a supported locked-liquidity position.",
  step1: "1. The fees you sell",
  step2: "2. Your share when the curve completes",
  step3: "3. The fee token",
  scanning: "Scanning the wallet…",
  nothingFound: "No eligible creator fee rights or locked positions found for this wallet.",
  rights: "Creator rights",
  position: "Locked position",
  claimable: "claimable",
  stages: ["on the curve", "curve complete", "locked vesting", "in the pool"],
  name: "Name",
  symbol: (prefix: string) => `Symbol (shown as ${prefix}SYMBOL)`,
  cap: "Highest price the buyback pays, SOL per token",
  capEncoded: "Encoded cap:",
  capInvalid: "Enter a positive price.",
  signing: "Signing…",
  stopped: "Stopped:",
  resumeHint:
    "The vault exists. Withdraw its fee rights or finish the launch from the vault page:",
  launched: "Launched.",
  openVault: "Open the vault",
  moneyTitle: "What you get",
  feesToggle: "How fees work",
} as const;

export const openVault = {
  title: "Finish or undo this vault",
  intro:
    "Nothing has launched yet. Every fee right can go back to your wallet, or the fee token can launch now.",
  withdraw: "Withdraw",
  launch: "Launch the fee token",
  mintKeyNote:
    "Launching needs the fee token key this browser generated; a vault created in another session can still withdraw its fee rights here.",
  needsMintKey:
    "This browser does not hold the fee token key for this vault. Open the vault in the browser that created it, or withdraw the fee rights and start again from Sell your fees.",
} as const;

export const splits = {
  summary:
    "You get your chosen share of the raise in SOL when the fee token's curve completes, plus 32% of the fee token's trading fees while it is on its curve and 16% once it trades in its pool. The fees you sold fund buybacks of the fee token (80%) and the protocol (20%).",
  curve:
    "While the fee token is on its curve: of its trading fees after Meteora's cut, 40% to you, 25% to the protocol, 35% to buybacks.",
  pool: "After the curve completes: half of the pool's fees after Meteora's cut compound into the pool (40% of the gross fee); the protocol holds 20% of the locked liquidity; the vault's claimable fees go half to you, half to buybacks.",
  external:
    "The fees from the coin you sold: 20% to the protocol, 80% to buybacks of the fee token.",
  cashout: "When the curve completes: your chosen share of the raise, in full.",
  orderFees: "Fees earned by the buyback bids themselves go back to buybacks.",
} as const;

/** The sell page before a wallet connects: what a seller gets, in real numbers (stream-50 at full size). */
export const sellExample = {
  title: "What you get, in numbers",
  lines: [
    "Say your coin earns about 1 SOL a month in creator fees, and you choose Take 50%.",
    "You put the coin's fee rights into a vault and launch a fee token. Its curve raises 40.685 SOL.",
    "When the curve completes you receive 20.343 SOL. The other half becomes locked liquidity for the fee token: about 20.302 SOL after Meteora's 0.2% migration fee (an illustration from the rounded raise, not an exact on-chain figure).",
    "From then on your coin's fees buy the fee token back: of that 1 SOL a month, 0.8 SOL goes to buybacks and 0.2 SOL to the protocol. You also get 32% of the fee token's own trading fees while it is on its curve, then 16% once it trades in its pool.",
    "If the curve has not completed thirty days after launch, you can unwind: your fee rights come back, with whatever was collected.",
  ],
  note: "Figures from the Take 50% setting at full size; fees and prices are never guaranteed.",
} as const;

export const experience = {
  eyebrow: "Launch a comet. Sell the tail.",
  homeBody:
    "Or launch a new coin here: 0.01 SOL, a fair price curve on Meteora, and 60% of every trading fee is yours on the curve, 32% once it trades in its pool.",
  explore: "Explore all tokens",
  observatory: "Every coin and the fees it earns",
  live: "Index connected",
  syncing: "Contacting the index",
  offline: "Connection interrupted",
  reconnect: "Try again",
  atlas: "Token map",
  atlasNote:
    "The longer a tail, the more fees that coin has earned: fees ready to claim plus fees collected in the last 30 days, compared within each paying token. When collection history is unavailable, we use an estimate from the curve. Gold sparks mark newly seen fees.",
  atlasEmpty: "An open sky. Room for your coin.",
  atlasEmptyBody:
    "No coins have been indexed in this view yet. They appear here as the data arrives.",
  atlasError: "The token list is temporarily out of reach.",
  atlasErrorBody:
    "We couldn’t reach the index. Your wallet and positions are unchanged. Try again.",
  known: "Coins indexed",
  accrued: "Ready to claim",
  harvested: "Collected · 30 days",
  tailScale:
    "Tails compare fee income within each paying token",
  chartLimit:
    "Up to 60 coins on desktop, 12 on mobile; the list below has all of them.",
  activity: "Activity is observed, never simulated.",
  anatomy: "Anatomy of a comet",
  tokenHead: "The token",
  tokenHeadBody: "A coin launched on Meteora’s price curve.",
  feeTail: "The tail",
  feeTailBody: "Trading fees, for as long as it trades.",
  illustration: "Illustration · not live trading data",
  chapters: [
    {
      number: "01",
      title: "Launch a coin.",
      body: "Name it, pick a price curve, pay 0.01 SOL. Clear fees, and liquidity that locks for good when the curve completes.",
    },
    {
      number: "02",
      title: "Watch the fees come in.",
      body: "As people trade, fees accrue to you. See what is ready to claim and what has actually been collected.",
    },
    {
      number: "03",
      title: "Sell the future fees, or keep them.",
      body: "Turn a coin's future fees into SOL now by selling them as a new token, bought back with those fees. Or just keep collecting.",
    },
  ],
  mechanics: "Built on Meteora. Visible on Solana.",
  mechanicsBody:
    "DBC for the launch. DAMM v2 for the market after the curve completes. DLMM for the vault’s standing buyback orders. Inspect the addresses before you sign.",
  footer: "Tokens take flight. Fees leave a trail.",
  menu: "Main navigation",
  connect: "Connect wallet",
  skip: "Skip to content",
  search: "Search by token, pool or creator address",
  all: "All coins",
  eligible: "Fees can be sold",
  list: "All coins",
  noResults: "No coins match.",
  noResultsBody: "Try another address or clear the filter.",
  clear: "Clear filters",
  viewToken: "View token",
  source: "Source",
  stage: "Stage",
  eligibility: "Eligibility",
  estimate: "Curve estimate",
  address: "Address",
  observed: "Last observation",
  explorer: "View on explorer",
  loading: "Reading the chain",
  loadingBody: "Fetching the latest state. This view will settle in a moment.",
  empty: "Nothing here yet",
  failed: "This view couldn’t load",
  failedBody:
    "The connection didn’t complete. Try again to read the latest state.",
  missing: "Nothing at this address",
  missingBody:
    "This account may be on another cluster, or it may not have been created yet.",
  back: "Back to all tokens",
  invalid: "This address doesn’t look right.",
  portfolioKicker: "Your corner of the sky",
  portfolioBody:
    "Your coins, the fees they earn and your vaults. One clear view of what you hold.",
  connectTitle: "Connect to see what you hold.",
  connectBody:
    "Connect the wallet that owns your coins. Reading your portfolio does not request a transaction.",
  noLaunches: "You have not launched a coin yet.",
  noVaults: "No vaults in this wallet.",
  noPositions: "No locked positions found.",
  launches: "Your coins",
  vaults: "Your vaults",
  positions: "Locked positions",
  launchKicker: "Launch a coin",
  launchBody:
    "Give your token an identity. We’ll take care of its image and metadata. You’ll review the transaction in your wallet.",
  identity: "Token identity",
  name: "Token name",
  symbol: "Symbol",
  description: "Description",
  descriptionHint: "What is this coin about?",
  preview: "Live token preview",
  previewNote: "Your image and identity, as they’ll appear in the token list.",
  namePlaceholder: "Your coin’s name",
  symbolPlaceholder: "COMET",
  firstBuy: "First buy",
  optional: "Optional",
  buyInvalid: "Enter a non-negative amount within the quote token’s decimal precision.",
  quoteFees: "The purchase uses your quote-token balance. Keep SOL for network and account fees.",
  testQuote: "Devnet quote tokens are test stand-ins. Their units are not a dollar or stock valuation.",
  identityLimit:
    "Use a name up to 32 UTF-8 bytes and a symbol up to 10 bytes (including the stream prefix).",
  messageRequired:
    "Your wallet needs message signing to authorize the image upload.",
  firstBuyHint: "Buy a little of your token in the launch transaction.",
  launchAction: "Launch the token",
  creating: "Preparing your launch…",
  uploading: "Saving your token identity…",
  launchReady: "Your token is live.",
  openToken: "Open token page",
  transaction: "View transaction",
  review: "Before you launch",
  uploadProof:
    "First, sign a free message to authorize the image upload. Then review the launch transaction.",
  launchFailure:
    "Your launch hasn’t completed. Check the message below and try again.",
  connectedNeeded: "Connect a wallet when you’re ready to launch.",
  image: "Token image",
  imageHint:
    "PNG, JPEG or WebP. Up to 5 MB. Crop to a square; we store a crisp 512 × 512 image.",
  chooseImage: "Choose an image",
  replaceImage: "Replace image",
  dropImage: "A small mark. A distinct identity.",
  zoom: "Zoom",
  horizontal: "Horizontal position",
  vertical: "Vertical position",
  imageType: "Choose a PNG, JPEG or WebP image.",
  imageSize: "Choose an image smaller than 5 MB.",
  imageDimensions:
    "Use an image 128–8192 pixels on each side, up to 16 megapixels.",
  imageError: "This image couldn’t be read. Try another file.",
  crop: "Adjust your square crop",
  remove: "Remove",
  tokenPlaceholder: "YOUR TOKEN",
  symbolPreview: "$SYMBOL",
  sellKicker: "Turn future fees into SOL now",
  sellBody:
    "Pick the coin whose future fees you sell, choose how much SOL you take when the new token's curve completes, and name that token. Nothing moves until you sign.",
  selectStreams: "Pick the fees to sell",
  createIdentity: "Name the fee token",
  vaultWaiting: "You have a vault waiting",
  vaultWaitingBody: "Your fee rights are already in an open vault. Finish the fee-token launch there, or withdraw them.",
  vaultWaitingAction: "Open the vault",
  noStreams: "No sellable fees in view yet.",
  noStreamsBody:
    "Launch a coin to start earning fees, or connect a wallet that owns an eligible Meteora position.",
  yourChoice: "Your share when the curve completes",
  selected: "Selected",
  finalReview: "Review the final step",
  uploadUnavailable:
    "Image storage is not ready on this deployment. Please try again after the operator connects storage.",
  curveEstimate: "Already claimed, at most",
  curveClaimed: "Already claimed",
  curveNothingClaimed: "Nothing claimed yet",
  curveEstimateBody:
    "Claimable now is exact: it is what a claim pays today. Already claimed comes from the curve's lifetime fee counter, which Meteora's per-trade rounding can push a little high, so it is an upper bound (exact at a 100% creator share). Pool fees after graduation are not included.",
  tokenKicker: "Token",
  vaultKicker: "Fee vault",
  disconnected: "Connect to continue",
  disclosures: "How it works",
  openState: "Open · you can still withdraw",
  liveState: "Live",
  viewVault: "View vault",
  notFinancialFloor: "Finite bids. No guaranteed floor.",
  updated: "Updated from the latest available state.",
  statusSending: "Waiting for your wallet",
  statusError: "The transaction did not complete",
  statusDone: "Confirmed on Solana",
  returnHome: "Return home",
  pageError: "This part of the page broke.",
  pageErrorBody:
    "Something interrupted this view. Reload it to pick up where you left off.",
  notFound: "Page not found.",
  notFoundBody:
    "There’s no page at this address. Start again from the token list.",
} as const;

export const plainLaunch = {
  presets: {
    title: "Choose your curve",
    body: "Choose a curve and the token people use to buy.",
    standard: { name: "Standard", body: "The familiar curve, with price rising as tokens are bought." },
    long: { name: "Long curve", body: "More room for price discovery before the pool graduates." },
    flat: { name: "Flat curve", body: "Most liquidity sits in a narrower price band before the final climb." },
    exp: { name: "Exponential", body: "A gentle start, then a steeper climb as liquidity tapers toward graduation." },
    stockUsdc: { name: "Dollar-paired", body: "The standard curve, bought and sold in USDC." },
    stockXstock: { name: "Stock-paired", body: "A smaller raise in stock units, with more liquidity near graduation. Early buys move the price more." },
    quote: "Quoted in",
    unavailable: "Unavailable on this network",
    shapeNote: "Shapes illustrate the designs; they are not price forecasts. Your curve is fixed at launch.",
    selected: "Selected curve",
  },
  title: "Launch a token",
  feesLine: "1% fee on every trade: you keep 60% of it while the coin is on its curve, then 32% from the pool after. 0.01 SOL to launch.",
  feesToggle: "How fees work",
  intro:
    "One flat 1% fee on the curve. While it bonds, 75% of the fee after Meteora's cut is yours (60% of the gross fee). If it graduates, your permanently locked position earns 80% of the pool's claimable fees (32% of the gross fee while half of the LP fees compound), for as long as it trades.",
  creationFee: "0.01 SOL to launch.",
  lock: "If the curve completes, 80% of the graduated liquidity is yours, permanently locked, earning fees for as long as the pool trades.",
} as const;

export const walletAccessibility = { close: "Close wallet selection" } as const;

export const market = {
  kicker: "The launchpad", title: "Find your next comet.",
  official: "Official token", officialNote: "The protocol's own token.",
  body: "New coins on the curve. Completed coins trading on Meteora. Follow what is trading, then look at the fees.",
  trending: "Trending", newest: "New launches", all: "All stages", bonding: "Bonding", graduated: "Graduated",
  search: "Search tokens", searchHint: "Name, symbol or mint address", clear: "Clear filters",
  ranking: "Ranked by 24-hour volume in a fresh USD reference. Tokens without a rate follow in newest-first order.",
  newestNote: "Ordered by launch time, not by the last refresh.",
  price: "Price", fdv: "FDV · USD", volume: "24h volume", holders: "Holder addresses",
  unknown: "Unavailable", partial: "Partial history", stale: "Last known data", current: "Latest snapshot",
  snapshot: "Observed", reference: "Devnet · USD reference values", mainnet: "Mainnet",
  valuation: "FDV uses total token supply and the quote token’s fresh USD reference rate. It is not circulating market cap or an executable quote.",
  fxMissing: "USD reference unavailable. SOL values remain available.",
  fxStale: "USD reference is stale. USD figures are hidden until the rate refreshes; SOL values remain available.",
  empty: "No coins in this view yet.", emptyBody: "Try another name or stage, or launch the first one.",
  notIndexed: "Not indexed yet.", notIndexedBody: "This coin is on the chain. The next scan picks it up and these numbers fill in on their own.",
  failed: "Market data is out of reach.", failedBody: "The last snapshot may still be visible. Try again to reconnect.",
  loading: "Loading the market…", loadingBody: "Reading token identities, pool prices and observed trades.",
  retry: "Try again", more: "Next page", first: "Back to first page", stream: "Fee token", plain: "Launch token",
  progress: "Curve progress", migrating: "Moving to its pool", completed: "Curve complete", pool: "Pool (DAMM v2)",
  overview: "Market", trades: "Recent trades", tradesBody: "Executed swaps on the curve and its graduated pool.",
  noTrades: "No trades in this window.", noTradesBody: "New confirmed swaps will appear here when the indexer observes them.",
  buy: "Buy", sell: "Sell", side: "Side", amount: "Tokens", quote: "Quote value", when: "Time · UTC", venue: "Venue", receipt: "Transaction",
  curveShort: "Curve", poolShort: "Pool",
  curve: "Curve (DBC)", trader: "Swap authority", payer: "Fee payer only", unknownTrader: "Authority unavailable",
  tradeNote: "Trades are historical executions. Use the trading form for a current quote.",
  sourceNote: "Holder counts are addresses with a nonzero balance, not people. The pools’ own vaults are excluded; custody accounts such as vaults may be included.",
  historyPending: "History is still being indexed. Counts and volume may be incomplete.",
  dataUpdated: "A new market snapshot is available.", refresh: "Show updates", view: "Open token",
} as const;

export const addresses = { mint: "Mint", vault: "Vault", position: "Position", pool: "Pool", copy: "Copy", copied: "Copied", failed: "Copy failed", manual: "Select and copy address" } as const;

export const money = { stale: "USD stale", missing: "USD unavailable", rate: "SOL/USD", liquidity: "Liquidity", curveLiquidity: "Quote reserve on the curve", poolLiquidity: "Estimate · pool quote side × 2", unknownLiquidity: "Liquidity not indexed", fees: "Fees earned", toSeller: "Paid to seller" } as const;

export const identity = {
  token: "Token", pendingName: "Token identity pending", pendingSymbol: "Ticker not available yet", pendingTicker: "Pending",
  vaultName: "Fee vault", viewToken: "View token", viewVault: "Open vault", viewPosition: "View position", viewPool: "View pool",
  creatorFees: "Creator fees", positionFees: "Locked-liquidity fees",
  sellable: "Fees can be sold", inVault: "In a vault · not for sale",
  programHeld: "Program-held · not available to sell", unknownOwner: "Owner unconfirmed · selling unavailable",
  treasuryHeld: "Protocol treasury · locked liquidity", vaultHeld: "In a vault · locked liquidity",
  lockedShare: (pct: string) => `Locked liquidity · ${pct}% of the pool`, sourcesOf: (n: number) => `${n} fee sources`,
  migrating: "Moving to its pool · not ready to sell", notSellable: "These fees cannot be sold here",
  unchecked: "Selling eligibility not checked", heldHere: "In this vault · not available to sell",
  search: "Search by name, ticker or address", linksLabel: "Token links", newTab: "(opens a new tab)",
  socialTitle: "Find your community", optional: "Optional", socialHint: "Add full HTTPS links. They'll appear with your token.",
  social: {
    x: { label: "X", placeholder: "https://x.com/yourproject", invalid: "Use an HTTPS link on x.com or twitter.com, up to 200 characters." },
    telegram: { label: "Telegram", placeholder: "https://t.me/yourproject", invalid: "Use an HTTPS link on t.me, up to 200 characters." },
    website: { label: "Website", placeholder: "https://yourproject.com", invalid: "Use a full HTTPS website link, up to 200 characters." },
    discord: { label: "Discord", placeholder: "https://discord.gg/yourinvite", invalid: "Use an HTTPS link on discord.gg or discord.com, up to 200 characters." },
  },
} as const;

/** The simplified home: one promise, one launch button, the coin feed (2026-10-07 redesign). */
export const home = {
  title: "Launch a coin in seconds.",
  body: "Anyone can buy it on its curve. When the curve fills, it graduates to a Meteora pool. Coin creators earn a share of every trade.",
  launch: "Launch a coin",
  sell: "Sell your coin's fees",
  burned: "$COMETAIL burned",
  burnedLastKnown: "last known: the burn figures are not answering",
  feedTitle: "Coins",
  tabs: { new: "New", trending: "Trending", soon: "About to graduate", graduated: "Graduated" },
  trendingNote: "Most traded in the last 24 hours.",
  trendingOff: "Trending is not available right now.",
  search: "Search coins",
  searchHint: "Name, ticker or address",
  graduated: "Graduated",
  graduating: "Graduating",
  toGraduate: "to graduation",
  official: "Official",
  showMore: "Show more",
  empty: "No coins here yet.",
  emptyBody: "Try another search or tab, or launch the first one.",
  soonEmpty: "No coin is on its curve right now.",
  soonNote: "Every coin still on its curve, closest to graduation first.",
  soonTruncated: (n: number) => `The newest ${n} coins still on their curve, closest to graduation first.`,
  fdv: "FDV",
  fdvTitle: "Fully diluted value: current price × total supply",
  lastKnown: "last known",
  how: "How it works",
  steps: [
    { title: "Launch", body: "Pick a name, a ticker and an image. It costs 0.01 SOL. Your coin starts on a price curve." },
    { title: "Trade", body: "People buy and sell on the curve. Every trade pays a 1% fee, and the coin's creator earns a share of it." },
    { title: "Graduate", body: "When the curve fills, the coin moves to a Meteora pool and keeps trading there." },
    { title: "Sell your fees", body: "Have a coin that earns fees? Sell those future fees for SOL now, through a fee vault." },
  ],
  details: "Details",
  marketCapNote: "The number on the right of each coin is its FDV: current price × total supply, in USD while the SOL price reference is fresh (otherwise in SOL). Most launchpads call this market cap. Live numbers refresh every 20 seconds; \"last known\" marks figures from a read that is failing.",
  explore: "All tokens and fee sources",
} as const;

/** The short launch form (2026-10-07 redesign). */
export const launchSimple = {
  title: "Launch a coin",
  body: "Add an image, a name and a ticker. Your coin goes live the moment you sign.",
  ticker: "Ticker",
  socials: "Add socials",
  socialsInvalid: "One of the social links needs fixing before you can continue.",
  create: "Create coin",
  signs: "You sign twice: once to save the image, once to create the coin.",
  preview: "Preview your coin card",
  details: "Details",
  presetTitle: "Price curve",
  presetBody: "Standard suits most coins. You can't change it later.",
  lines: {
    standard: "The classic curve. Price rises as people buy.",
    long: "A longer curve, with more room to grow before it graduates.",
    flat: "A steadier price for most of the way, then a final climb.",
    exp: "Starts slow, then climbs faster near graduation.",
    stockUsdc: "The classic curve, bought and sold in USDC.",
    stockXstock: "Bought and sold in a tokenized stock instead of SOL.",
  },
} as const;

/** The simplified token page (2026-10-07 redesign). */
export const tokenSimple = {
  back: "Coins",
  fdv: "FDV",
  fdvNote: "price × total supply",
  price: "Price",
  volume: "24h volume",
  holders: "Holders",
  chart: "FDV · each trade's price × today's supply",
  chartWindow: (n: number) => `Last ${n} trades`,
  chartEmpty: "Not enough trades for a chart yet.",
  chartLoading: "Loading the chart…",
  chartFailed: "The chart could not be loaded.",
  chartNoSupply: "The chart appears once this coin's supply is indexed.",
  progress: "Progress to graduation",
  progressOf: (have: string, need: string) => `${have} of ${need} raised`,
  graduatedTitle: "Graduated",
  graduatedBody: "This coin finished its curve and now trades in its Meteora pool.",
  migrating: "Curve complete. Moving to its Meteora pool; trading resumes there in a moment.",
  trades: "Trades",
  holderTab: "Holders",
  holdersTitle: "Top holders",
  holdersNote: "The 20 largest accounts on the chain right now. The curve and pool hold the coins that are for sale.",
  holdersLoading: "Reading holders…",
  holdersFailed: "Holders could not be read right now.",
  holdersNone: "No holders yet.",
  curve: "Bonding curve",
  pool: "Meteora pool",
  creator: "Creator",
  you: "You",
  details: "Details",
  detailsStage: "Stage",
  creatorAddress: "Creator",
  curvePool: "Curve pool",
  graduatedPool: "Meteora pool",
  route: (bonding: boolean) => bonding ? "Trades go through Meteora's bonding curve." : "Trades go through the coin's Meteora pool.",
  creatorFees: "Creator fees",
  claimable: "Claimable now",
  creatorFeesBody: "The creator earns part of every trade's fee.",
  feesMore: "How this is counted",
} as const;

/** The simplified sell page (2026-10-07 redesign). */
export const sellSimple = {
  body: "Get SOL now for your coin's future trading fees. Nothing moves until you sign.",
  advanced: "Advanced: highest buyback price",
} as const;
