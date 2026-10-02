# Devnet browser pass

The automated devnet runs drive the program, the worker processes and the app's own
transaction helpers with keypairs. What they cannot do is click: this is the pass a person
runs with a wallet extension on devnet before anything goes live. Each line is a check.

Setup: `pnpm dev:web` with `web/.env.local` pointing at devnet and the worker's API; the
worker running in keeper and indexer mode against devnet (README, "Running the worker");
a wallet with a few devnet SOL; a second wallet to act as the buyer.

Launch
- [ ] `/launch`: name, symbol, metadata URL, optional first buy; the wallet shows one
      transaction; the token page link appears with the signature.
- [ ] Rejecting the wallet prompt shows an error and leaves nothing behind.

Token page, bonding
- [ ] Progress bar and threshold match the explorer; the tail meter shows claimable 0.
- [ ] Quote a buy and a sell; the amounts are numbers, not NaN, in the token's decimals.
- [ ] Buy with the second wallet; the page refreshes within 20 s; the creator's claimable
      amount rises; "Claim creator fees" appears for the creator and pays the wallet.
- [ ] A buy large enough to complete the curve completes it (partial fill) and the page
      switches to "Graduated" after the keeper migrates.

Token page, graduated
- [ ] Buy and sell on the DAMM v2 pool; quotes and confirmations are numbers; the pool link
      is the derived pool for the config's migration fee option.

Sell your tail
- [ ] `/sell` lists the creator rights (bonding and graduated) and locked positions of the
      wallet, with reasons for anything ineligible.
- [ ] A cap of 0.0006 shows "Encoded cap: 0.0006"; 0, negative and text are refused.
- [ ] The vault link appears right after the first transaction; cancelling a later wallet
      prompt stops the wizard with the vault link still shown.
- [ ] The vault page of that Open vault (same browser session) offers Withdraw per stream
      and Launch; Withdraw returns the stream; Launch finishes the vault.
- [ ] In a fresh session the same Open vault offers Withdraw but explains that Launch needs
      the key kept by the wizard.

Vault page, Live
- [ ] After the keeper's passes: status Live, cash-out equal to the preset's share, pair
      bound, harvested totals, a ladder placed, the burn log after a sell into the ladder.
- [ ] The displayed cap equals what was entered.

Sky and portfolio
- [ ] `/sky` shows the launches with stage, custody, claimable, harvested 30 days (for
      streams in a vault) and the curve estimate; the comet tails update within a minute.
- [ ] `/portfolio` lists the wallet's launches, vaults and locked positions.

Record the signatures of each step in THREAD with the wallet addresses used.
