//! Program-wide constants. The split ratios are code, not state (docs/economics.md).
use anchor_lang::prelude::*;

/// Depositor share of the vault's own curve fees: 8/15 (40% of the after-Meteora fee out
/// of the vault's 75%). The rest funds bids.
pub const OWN_CURVE_DEPOSITOR_NUM: u64 = 8;
pub const OWN_CURVE_DEPOSITOR_DEN: u64 = 15;
/// Depositor share of the vault's own graduated-pool position fees: 1/2.
pub const OWN_POSITION_DEPOSITOR_NUM: u64 = 1;
pub const OWN_POSITION_DEPOSITOR_DEN: u64 = 2;
/// Protocol share of deposited external stream income: 1/5.
pub const EXTERNAL_PROTOCOL_NUM: u64 = 1;
pub const EXTERNAL_PROTOCOL_DEN: u64 = 5;
/// Absolute dust bound on unlocked liquidity in an eligible position (raw liquidity units).
pub const MAX_UNLOCKED_DUST: u128 = 3;
/// DLMM limit orders carry at most this many bins.
pub const MAX_BINS_PER_ORDER: u8 = 50;

pub const SEED_PROTOCOL: &[u8] = b"protocol";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_STREAM: &[u8] = b"stream";
pub const SEED_STREAM_INDEX: &[u8] = b"stream-index";
pub const SEED_ORDER: &[u8] = b"order";

/// Wrapped SOL: the only income currency.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Meteora DBC's pool authority PDA (the DAMM v2 pool creator after migration).
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
