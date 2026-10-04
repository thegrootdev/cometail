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
  sell: "Sell your fees",
  sky: "Explore tokens",
  portfolio: "Portfolio",
} as const;

export const hero = {
  title: "Got a coin that still earns fees? Sell those future fees for SOL today.",
  titleLine1: "Got a coin that still earns fees?",
  titleLine2: "Sell those future fees for SOL today.",
  body: "Or launch a new coin here: 0.01 SOL, a fair price curve on Meteora, and you keep most of the trading fees it earns.",
  launch: "Launch a token",
  sell: "Sell my coin's fees",
} as const;

export const sky = {
  title: "Explore tokens",
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
  streamUnwindNote: "This is a fee token: it pays out another coin's future fees. If its curve is still below its target thirty days after launch, the seller can close the vault behind it and take those fees back. The token keeps trading on this curve either way.",
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
  connect: "Connect the wallet that owns the coin.",
  step1: "1. The fees you sell",
  step2: "2. Your share when the curve completes",
  step3: "3. The fee token",
  scanning: "Scanning the wallet…",
  nothingFound: "No coins or locked positions found for this wallet.",
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
    "This browser does not hold the fee token key for this vault. Withdraw the fee rights and start again from Sell your fees.",
} as const;

export const splits = {
  summary:
    "You get your chosen share of the raise in SOL when the fee token's curve completes, plus 40% of that token's own trading fees. The fees you sold fund buybacks of the fee token (80%) and the protocol (20%).",
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
    "When the curve completes you receive 20.343 SOL. The other 20.343 SOL becomes locked liquidity for the fee token.",
    "From then on your coin's fees buy the fee token back: of that 1 SOL a month, 0.8 SOL goes to buybacks and 0.2 SOL to the protocol. You also keep 40% of the fee token's own trading fees while it is on its curve.",
    "If the curve has not completed thirty days after launch, you can unwind: your fee rights come back, with whatever was collected.",
  ],
  note: "Figures from the Take 50% setting at full size; fees and prices are never guaranteed.",
} as const;

export const experience = {
  eyebrow: "Launch a comet. Sell the tail.",
  homeBody:
    "Or launch a new coin here: 0.01 SOL, a fair price curve on Meteora, and you keep most of the trading fees it earns.",
  explore: "Explore all tokens",
  observatory: "Every coin and the fees it earns",
  live: "Index connected",
  syncing: "Contacting the index",
  offline: "Connection interrupted",
  reconnect: "Try again",
  atlas: "Token map",
  atlasNote:
    "The longer a tail, the more fees that coin has earned: fees ready to claim plus fees collected in the last 30 days, compared within each paying token. Gold sparks mark newly seen fees.",
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
  noStreams: "No sellable fees in view yet.",
  noStreamsBody:
    "Launch a coin to start earning fees, or connect a wallet that owns an eligible Meteora position.",
  yourChoice: "Your share when the curve completes",
  selected: "Selected",
  finalReview: "Review the final step",
  uploadUnavailable:
    "Image storage is not ready on this deployment. Please try again after the operator connects storage.",
  curveEstimate: "Estimated from the curve",
  curveEstimateBody:
    "Derived from the curve's total fees; rounding may differ from actual claims. Pool fees are not included.",
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
