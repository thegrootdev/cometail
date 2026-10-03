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
  actionFailed: "That didn’t work. Try again in a moment.",
} as const;

export const nav = {
  launch: "Launch a token",
  sell: "Sell your tail",
  sky: "The Sky",
  portfolio: "Portfolio",
} as const;

export const hero = {
  title: "Launch a comet. Sell the tail.",
  body: "Every token launched here bonds on Meteora's Dynamic Bonding Curve and graduates into a compounding pool. The fees it earns, for as long as it trades, are its tail. Keep the tail, or sell it.",
  launch: "Launch a token",
  sell: "Sell your tail",
} as const;

export const sky = {
  title: "The Sky",
  body: "Every fee stream on Meteora, drawn as a comet. The longer the tail, the more it earns.",
  legend: {
    claimable: "claimable now",
    realized: "harvested, 30 days",
    locked: "locked liquidity",
  },
  position: "Locked position",
  ofLocked: "of the locked liquidity",
} as const;

export const tokenPage = {
  curve: "Bonding curve",
  progress: "to graduation",
  trades: "Trades",
  tail: "The tail",
  tailBody: "Creator fees this token has earned, before and after graduation.",
  claim: "Claim creator fees",
  sellTail: "Sell this tail",
  buy: "Buy",
  sellToken: "Sell",
  enterAmount: "Enter an amount to get a quote.",
  solIn: "SOL in",
  tokensIn: "Tokens in",
  quoting: "Getting a quote…",
  youPay: "You pay",
  youSell: "You sell",
  youReceive: "You receive about",
  minimum: "Minimum after 1% slippage",
  quoteNote: "Quotes follow the pool as you type; the trade sends with the minimum shown, or fails rather than take less.",
  quoteStale: "The quote changed while you were trading. Review the new minimum and try again.",
  confirmed: "Confirmed",
  refreshing: "Updating balances…",
  streamUnwindNote: "This is a stream token. If its curve is still below its threshold thirty days after launch, the seller can close the vault behind it and take the fee streams back. The token keeps trading on this curve either way; holders can sell back here.",
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
  streams: "Streams in this vault",
  income: "Income in",
  cashout: "Cash-out",
  ladder: "Buyback ladder",
  depth: "Standing bids, by price",
  resting: "resting",
  crossed: "crossed, settling",
  filled: "filled",
  partial: "partly filled",
  unknownFill: "fill state unread",
  ladderUnavailable: "The standing bids could not be read just now.",
  poolPrice: "Pool price now",
  noBins: "No bins resting right now.",
  lockedShare: "of the locked liquidity",
  ladderBody:
    "Standing bids below price, funded by harvested fees. Whatever they fill is burned.",
  burned: "Burned so far",
  bids: "Bids resting",
  cap: "Price cap",
  disclosure:
    "Realized fees fund finite standing buy orders at public limit prices. Holders of this token have no redemption claim and no guaranteed price floor. Orders can exhaust; fee income and market prices can fall. Burning reduces supply but does not guarantee appreciation. Bid placement remains exposed to manipulation and adverse selection. This vault is a disclosed, rule-bound buyback mechanism, not a redeemable claim on income.",
  authority:
    "The vault program is upgradeable by the protocol owner and that is not planned to change. Meteora's DBC and DAMM v2 programs are upgradeable by Meteora, and a Meteora operator can change how much of a compounding pool's fees are claimable. Every number on this page depends on those facts.",
  noGraduation:
    "If this stream token's curve never reaches its threshold, the seller is not stuck. Thirty days after launch, while the curve is still below its threshold, the seller can unwind: the streams go back to the seller's wallet with any income the vault collected from them, and the vault closes for good. The stream token keeps trading on its curve, so holders can sell back; a later graduation changes nothing for a closed vault.",
  unwind: {
    title: "Unwind this vault",
    bodyWaiting: "If the curve is still below its threshold by then, you can unwind from",
    bodyReady: "Thirty days have passed and the curve is still below its threshold. You can close this vault for good and take your streams back.",
    whatHappens: "Your streams return to your wallet, with the income the vault collected from them. The stream token keeps trading on its curve; holders can sell back. This cannot be undone.",
    action: "Unwind and take my streams back",
    done: "Unwound. Withdraw each stream below to move it back to your wallet.",
    unwound: "This vault was unwound by its seller. Its streams have gone or are going back to the seller; nothing runs here any more.",
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
  title: "Sell your tail",
  intro:
    "Pick the streams you own, choose how much of the raise you take at graduation, and launch the tail as its own token.",
  presets: [
    {
      key: "stream-25",
      label: "Take 25%",
      body: "At graduation, 25% of the raise is yours and 75% becomes permanently locked liquidity.",
    },
    {
      key: "stream-50",
      label: "Take 50%",
      body: "At graduation, half of the raise is yours and half becomes permanently locked liquidity.",
    },
    {
      key: "stream-75",
      label: "Take 75%",
      body: "At graduation, 75% of the raise is yours and 25% becomes permanently locked liquidity.",
    },
  ],
  withdrawLock:
    "Streams can be withdrawn until you launch. A bonding-curve stream that has completed its curve but not migrated yet cannot be moved until it migrates.",
  irreversible: "Launching is final while the curve is live. If the curve is still below its threshold thirty days after launch, you can unwind: your streams come back with the income the vault collected, and the vault closes for good.",
  connect: "Connect the wallet that owns the streams.",
  step1: "1. Your streams",
  step2: "2. Your share at graduation",
  step3: "3. The stream token",
  scanning: "Scanning the wallet…",
  nothingFound: "No DBC launches or locked positions found for this wallet.",
  rights: "Creator rights",
  position: "Locked position",
  claimable: "claimable",
  stages: ["bonding", "curve complete", "locked vesting", "graduated"],
  name: "Name",
  symbol: (prefix: string) => `Symbol (shown as ${prefix}SYMBOL)`,
  cap: "Highest price the buyback pays, SOL per token",
  capEncoded: "Encoded cap:",
  capInvalid: "Enter a positive price.",
  signing: "Signing…",
  stopped: "Stopped:",
  resumeHint:
    "The vault exists. Withdraw its streams or finish the launch from the vault page:",
  launched: "Launched.",
  openVault: "Open the vault",
  moneyTitle: "How the money moves",
} as const;

export const openVault = {
  title: "Finish or undo this vault",
  intro:
    "Nothing has launched yet. Every stream can go back to your wallet, or the stream token can launch now.",
  withdraw: "Withdraw",
  launch: "Launch the stream token",
  mintKeyNote:
    "Launching needs the stream token key the wizard generated; a vault created in another session can still withdraw its streams here.",
  needsMintKey:
    "This browser does not hold the stream token key for this vault. Withdraw the streams and start again from Sell your tail.",
} as const;

export const splits = {
  curve:
    "Curve fees after Meteora's cut: 40% to you, 25% to the protocol, 35% to buybacks.",
  pool: "Graduated pool: half of the fees after Meteora's cut compound into the pool (40% of the gross fee); the protocol holds 20% of the locked liquidity; your vault's claimable fees go half to you, half to buybacks.",
  external:
    "Income from deposited streams: 20% to the protocol, 80% to buybacks.",
  cashout: "Cash-out: your preset's share of the raise, in full.",
  orderFees: "Fees earned by the buyback bids themselves go back to buybacks.",
} as const;

export const experience = {
  eyebrow: "A longer horizon for every launch",
  homeBody:
    "A token is the beginning. Its trading fees are the tail. Launch on Meteora, watch your income take shape, and decide what comes next.",
  explore: "Explore the atlas",
  observatory: "The fee-stream observatory",
  live: "Index connected",
  syncing: "Contacting the observatory",
  offline: "Connection interrupted",
  reconnect: "Try again",
  atlas: "Atlas",
  atlasNote:
    "Tail length reflects claimable fees plus 30-day harvests, or a curve estimate when harvests are unavailable. Gold sparks mark newly observed fees.",
  atlasEmpty: "An open sky. Room for your comet.",
  atlasEmptyBody:
    "No streams have been indexed in this view yet. A real fee stream will appear here as the data arrives.",
  atlasError: "The sky is temporarily out of reach.",
  atlasErrorBody:
    "We couldn’t reach the stream index. Your wallet and positions are unchanged. Try reconnecting to the data.",
  known: "Indexed streams",
  accrued: "Claimable now",
  harvested: "Harvested · 30 days",
  tailScale:
    "Tail = claimable + 30-day harvested (curve estimate if unavailable)",
  chartLimit:
    "Up to 60 streams on desktop, 12 on mobile; the catalogue includes the full result.",
  activity: "Activity is observed, never simulated.",
  anatomy: "Anatomy of a comet",
  tokenHead: "The token",
  tokenHeadBody: "A launch on Meteora’s bonding curve.",
  feeTail: "The tail",
  feeTailBody: "Trading fees, for as long as it trades.",
  illustration: "Illustration · not live trading data",
  chapters: [
    {
      number: "01",
      title: "Give it a beginning.",
      body: "Create a token with its own identity. One curve, transparent fees, and a path to permanently locked liquidity.",
    },
    {
      number: "02",
      title: "Watch the tail grow.",
      body: "As the market trades, fees accrue. See what is claimable and what a vault has actually harvested.",
    },
    {
      number: "03",
      title: "Choose your horizon.",
      body: "Keep the income, or deposit eligible streams into a vault and launch a stream token. The choice stays yours until launch.",
    },
  ],
  mechanics: "Built on Meteora. Visible on Solana.",
  mechanicsBody:
    "DBC for the launch. DAMM v2 for the graduated market. DLMM for the vault’s standing buybacks. Inspect the addresses and understand the mechanics before you sign.",
  footer: "Tokens take flight. Fees leave a trail.",
  menu: "Main navigation",
  connect: "Connect wallet",
  skip: "Skip to content",
  search: "Search by token, pool or creator address",
  all: "All streams",
  eligible: "Vault eligible",
  list: "Stream catalogue",
  noResults: "No coordinates match.",
  noResultsBody: "Try another address or clear the eligibility filter.",
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
  missing: "No signal at this address",
  missingBody:
    "This account may be on another cluster, or it may not have been created yet.",
  back: "Return to the atlas",
  invalid: "This address doesn’t look right.",
  portfolioKicker: "Your corner of the sky",
  portfolioBody:
    "Your launches, fee streams and vaults. One clear view of what you hold.",
  connectTitle: "Bring your constellation into view.",
  connectBody:
    "Connect the wallet that owns your tokens and fee streams. Reading your portfolio does not request a transaction.",
  noLaunches: "Your first comet is still ahead.",
  noVaults: "No vaults in this wallet.",
  noPositions: "No locked positions found.",
  launches: "Your launches",
  vaults: "Your vaults",
  positions: "Locked positions",
  launchKicker: "New coordinates",
  launchBody:
    "Give your token an identity. We’ll take care of its image and metadata. You’ll review the transaction in your wallet.",
  identity: "Token identity",
  name: "Token name",
  symbol: "Symbol",
  description: "Description",
  descriptionHint: "What are you sending into the sky?",
  preview: "Live token preview",
  previewNote: "Your image and identity, as they’ll appear in the atlas.",
  namePlaceholder: "Your comet’s name",
  symbolPlaceholder: "COMET",
  firstBuy: "First buy",
  optional: "Optional",
  buyInvalid: "Use a non-negative SOL amount with up to 9 decimal places.",
  identityLimit:
    "Use a name up to 32 UTF-8 bytes and a symbol up to 10 bytes (including the stream prefix).",
  messageRequired:
    "Your wallet needs message signing to authorize the image upload.",
  firstBuyHint: "Buy a little of your token in the launch transaction.",
  launchAction: "Launch your comet",
  creating: "Preparing your launch…",
  uploading: "Saving your token identity…",
  launchReady: "Your comet is in the sky.",
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
  tokenPlaceholder: "YOUR COMET",
  symbolPreview: "$SYMBOL",
  sellKicker: "Turn income into a new beginning",
  sellBody:
    "Choose the fee streams, shape your cash-out, and give the stream token an identity. Nothing moves until you sign.",
  selectStreams: "Select your streams",
  createIdentity: "Name the next comet",
  noStreams: "No eligible streams in view yet.",
  noStreamsBody:
    "Launch a token to begin building a tail, or connect a wallet with an eligible Meteora position.",
  yourChoice: "Your graduation share",
  selected: "Selected",
  finalReview: "Review the final step",
  uploadUnavailable:
    "Image storage is not ready on this deployment. Please try again after the operator connects storage.",
  curveEstimate: "Curve realized · estimate",
  curveEstimateBody:
    "Derived from aggregate curve fees; rounding may differ from actual claims. Graduated-pool fees are not included.",
  tokenKicker: "Token observatory",
  vaultKicker: "Income observatory",
  disconnected: "Connect to continue",
  disclosures: "Understand the mechanism",
  openState: "Open · you can still withdraw",
  liveState: "Live",
  viewVault: "View vault",
  notFinancialFloor: "Finite bids. No guaranteed floor.",
  updated: "Updated from the latest available state.",
  statusSending: "Waiting for your wallet",
  statusError: "The transaction did not complete",
  statusDone: "Confirmed on Solana",
  returnHome: "Return home",
  pageError: "We lost this part of the sky.",
  pageErrorBody:
    "Something interrupted this view. Reload it to pick up where you left off.",
  notFound: "Uncharted coordinates.",
  notFoundBody:
    "There’s no page at this address. The atlas is a good place to begin again.",
} as const;

export const plainLaunch = {
  title: "Launch a token",
  intro:
    "One flat 1% fee on the curve. While it bonds, 75% of the fee after Meteora's cut is yours (60% of the gross fee). If it graduates, your permanently locked position earns 80% of the pool's claimable fees (32% of the gross fee while half of the LP fees compound), for as long as it trades.",
  creationFee: "0.01 SOL to launch.",
  lock: "If the curve completes, 80% of the graduated liquidity is yours, permanently locked, earning fees for as long as the pool trades.",
} as const;

export const walletAccessibility = { close: "Close wallet selection" } as const;

export const market = {
  kicker: "The launchpad", title: "Find your next comet.",
  body: "New ideas on the curve. Graduated comets on Meteora. Follow what is trading, then explore the tail.",
  trending: "Trending", newest: "New launches", all: "All stages", bonding: "Bonding", graduated: "Graduated",
  search: "Search tokens", searchHint: "Name, symbol or mint address", clear: "Clear filters",
  ranking: "Ranked by observed 24h SOL swap volume. Partial windows are labelled.",
  newestNote: "Ordered by launch time, not by the last refresh.",
  price: "Price · USD", fdv: "FDV · USD", volume: "24h volume · USD", holders: "Holder addresses",
  unknown: "Unavailable", partial: "Partial history", stale: "Last known data", current: "Latest snapshot",
  snapshot: "Observed", reference: "Devnet · USD reference values", mainnet: "Mainnet",
  valuation: "FDV uses total token supply and the displayed SOL/USD reference rate. It is not circulating market cap or an executable quote.",
  fxMissing: "USD reference unavailable. SOL values remain available.",
  fxStale: "USD reference is stale. USD figures are hidden until the rate refreshes; SOL values remain available.",
  empty: "No comets in this view yet.", emptyBody: "Try another name or stage, or launch the first one.",
  notIndexed: "Not indexed yet.", notIndexedBody: "This comet is on the chain. The next scan picks it up and these numbers fill in on their own.",
  failed: "Market data is out of reach.", failedBody: "The last snapshot may still be visible. Try again to reconnect.",
  loading: "Mapping the market…", loadingBody: "Reading token identities, pool prices and observed trades.",
  retry: "Try again", more: "Next page", first: "Back to first page", stream: "Fee-stream token", plain: "Launch token",
  progress: "Curve progress", migrating: "Migrating to DAMM v2", completed: "Curve complete", pool: "DAMM v2",
  overview: "Market observatory", trades: "Recent trades", tradesBody: "Executed swaps on the curve and its graduated pool.",
  noTrades: "No trades in this window.", noTradesBody: "New confirmed swaps will appear here when the indexer observes them.",
  buy: "Buy", sell: "Sell", side: "Side", amount: "Tokens", quote: "Value · USD", when: "Time · UTC", venue: "Venue", receipt: "Transaction",
  curve: "DBC", trader: "Swap authority", payer: "Fee payer only", unknownTrader: "Authority unavailable",
  tradeNote: "Trades are historical executions. Use the trading form for a current quote.",
  sourceNote: "Holder counts are addresses with a nonzero balance, not people. The pools’ own vaults are excluded; custody accounts such as vaults may be included.",
  historyPending: "History is still being indexed. Counts and volume may be incomplete.",
  dataUpdated: "A new market snapshot is available.", refresh: "Show updates", view: "Explore token",
} as const;

export const addresses = { mint: "Mint", vault: "Vault", position: "Position", pool: "Pool", copy: "Copy", copied: "Copied", failed: "Copy failed", manual: "Select and copy address" } as const;

export const money = { stale: "USD stale", missing: "USD unavailable", rate: "SOL/USD", liquidity: "Liquidity · USD", curveLiquidity: "Quote reserve on the curve", poolLiquidity: "Estimate · pool quote side × 2", unknownLiquidity: "Liquidity not indexed", fees: "Fees earned", toSeller: "Paid to seller" } as const;

export const identity = {
  token: "Token", pendingName: "Token identity pending", pendingSymbol: "Ticker not available yet", pendingTicker: "Pending",
  vaultName: "Fee-stream vault", viewToken: "View token", viewVault: "Open vault", viewPosition: "View position", viewPool: "View pool",
  creatorFees: "Creator fee stream", positionFees: "Locked liquidity fee stream",
  sellable: "Fee stream can be sold", inVault: "In a vault · not available to sell",
  programHeld: "Program-held · not available to sell", unknownOwner: "Owner unconfirmed · selling unavailable",
  migrating: "Migrating · not ready to sell", notSellable: "Fee stream cannot be sold here",
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
