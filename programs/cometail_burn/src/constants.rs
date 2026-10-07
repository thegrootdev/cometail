//! Program-wide constants. The share, the cadence and the guards are code, not state (docs/burn.md).
use anchor_lang::prelude::*;

/// Share of every fee the program claims that goes to the burn reserve: 50%. The rest goes to the
/// protocol treasury in the same instruction.
pub const BURN_SHARE_BPS: u64 = 5_000;
pub const BPS: u64 = 10_000;

/// At most one buyback every ten minutes: chunks cannot be stacked inside one transaction.
pub const COOLDOWN_SECONDS: i64 = 600;
/// A buyback spends at least this much (0.001 SOL), or it does not run: no dust buys taking the slot.
pub const MIN_BUY_LAMPORTS: u64 = 1_000_000;
/// The chunk is at most the pool's SOL reserve x its fee / 5: the price moves well under the
/// round-trip fee, so a sandwich around one buyback loses money in the constant-product model.
pub const CAP_DIVISOR: u64 = 5;
/// The pinned pool's fee must be at least 1% (DAMM v2 fee precision 1e9) at setup, constant
/// (no scheduler periods), and unchanged at every buyback.
pub const MIN_FEE_NUMERATOR: u64 = 10_000_000;
pub const FEE_DENOMINATOR: u64 = 1_000_000_000;
/// The program's own minimum out: its quote from the pool state it just read, less 0.5%.
pub const MIN_OUT_TOLERANCE_BPS: u64 = 50;

/// DAMM v2 constants (cp-amm `state/pool.rs`).
pub const DAMM_COLLECT_COMPOUNDING: u8 = 2;
pub const DAMM_POOL_ENABLED: u8 = 0;
/// DBC constants (dynamic-bonding-curve `state/config.rs`).
pub const DBC_COLLECT_QUOTE: u8 = 0;

pub const SEED_BURN: &[u8] = b"burn";
pub const SEED_CLAIMER: &[u8] = b"claimer";
pub const SEED_RESERVE: &[u8] = b"reserve";
pub const SEED_INBOX: &[u8] = b"inbox";
pub const SEED_PLACEHOLDER: &[u8] = b"placeholder";
pub const SEED_BOUGHT: &[u8] = b"bought";

pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Meteora DBC's pool authority PDA.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// Meteora DAMM v2's pool authority PDA.
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
