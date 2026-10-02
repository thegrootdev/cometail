//! The one eligibility routine every stream entry path runs (docs/architecture.md,
//! "Eligibility"). Everything is read from the actual accounts; nothing is taken from
//! client input.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::Discriminator;
use anchor_spl::token_2022::spl_token_2022::state::Account as TokenAccountState;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint as MintState,
};
use anchor_spl::token_interface::TokenAccount;

use crate::constants::*;
use crate::cp_amm;
use crate::dynamic_bonding_curve as dbc;
use crate::errors::VaultError;

/// DAMM v2 collect-fee modes that pay in token B only (`cpamm/state/pool.rs`).
pub const DAMM_COLLECT_ONLY_B: u8 = 1;
pub const DAMM_COLLECT_COMPOUNDING: u8 = 2;
/// DBC collect-fee mode QuoteToken and migrated modes that map to B-only fees.
pub const DBC_COLLECT_QUOTE: u8 = 0;
pub const DBC_MIGRATED_QUOTE: u8 = 0;
pub const DBC_MIGRATED_COMPOUNDING: u8 = 2;
pub const DBC_MIGRATION_DAMM_V2: u8 = 1;
pub const DBC_PROGRESS_PRE_BONDING: u8 = 0;
pub const DBC_PROGRESS_CREATED_POOL: u8 = 3;
/// Bits of `PoolState.migration_fee_withdraw_status` (`dbc/state/virtual_pool.rs`).
pub const DBC_CREATOR_MIGRATION_FEE_MASK: u8 = 0b010;

/// Meteora's DAMM v2 configs for DBC migrations, indexed by `migration_fee_option`
/// (dynamic-bonding-curve-sdk `DAMM_V2_MIGRATION_FEE_ADDRESS`).
pub const DAMM_V2_MIGRATION_CONFIGS: [Pubkey; 7] = [
    pubkey!("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd"),
    pubkey!("2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k"),
    pubkey!("Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp"),
    pubkey!("2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq"),
    pubkey!("AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD"),
    pubkey!("DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u"),
    pubkey!("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck"),
];

fn min_max(a: &Pubkey, b: &Pubkey) -> ([u8; 32], [u8; 32]) {
    if a.to_bytes() < b.to_bytes() { (a.to_bytes(), b.to_bytes()) } else { (b.to_bytes(), a.to_bytes()) }
}

/// DAMM v2 pool address: `["pool", config, max(mintA, mintB), min(mintA, mintB)]`.
pub fn derive_damm_pool(config: &Pubkey, mint_a: &Pubkey, mint_b: &Pubkey) -> Pubkey {
    let (lo, hi) = min_max(mint_a, mint_b);
    Pubkey::find_program_address(&[b"pool", config.as_ref(), &hi, &lo], &cp_amm::ID).0
}

/// A base mint is eligible when it is SPL Token, or Token-2022 with only metadata-related
/// extensions, and has no freeze authority.
pub fn check_base_mint(mint: &AccountInfo) -> Result<()> {
    let data = mint.try_borrow_data()?;
    if *mint.owner == anchor_spl::token::ID {
        let state = anchor_spl::token::spl_token::state::Mint::unpack(&data).map_err(|_| VaultError::ForeignAccount)?;
        require!(state.freeze_authority.is_none(), VaultError::Ineligible);
        return Ok(());
    }
    require_keys_eq!(*mint.owner, anchor_spl::token_2022::ID, VaultError::ForeignAccount);
    let state = StateWithExtensions::<MintState>::unpack(&data).map_err(|_| VaultError::ForeignAccount)?;
    require!(state.base.freeze_authority.is_none(), VaultError::Ineligible);
    for ext in state.get_extension_types().map_err(|_| VaultError::ForeignAccount)? {
        match ext {
            ExtensionType::MetadataPointer | ExtensionType::TokenMetadata => {}
            _ => return err!(VaultError::Ineligible),
        }
    }
    Ok(())
}

/// Position NFT token account: vault-owned, exactly one token of the position's mint, no delegate.
pub fn check_nft_account(acc: &InterfaceAccount<TokenAccount>, vault: &Pubkey, nft_mint: &Pubkey) -> Result<()> {
    require_keys_eq!(acc.owner, *vault, VaultError::AccountMismatch);
    require_keys_eq!(acc.mint, *nft_mint, VaultError::AccountMismatch);
    require!(acc.amount == 1, VaultError::AccountMismatch);
    require!(acc.delegate.is_none(), VaultError::HasDelegate);
    Ok(())
}

/// Read a DAMM v2 position straight from an account created earlier in this instruction.
pub fn read_position(info: &AccountInfo) -> Result<cp_amm::accounts::Position> {
    require_keys_eq!(*info.owner, cp_amm::ID, VaultError::ForeignAccount);
    let data = info.try_borrow_data()?;
    let disc = cp_amm::accounts::Position::DISCRIMINATOR;
    require!(data.len() >= 8 + core::mem::size_of::<cp_amm::accounts::Position>() && data[..8] == *disc, VaultError::ForeignAccount);
    Ok(*bytemuck::from_bytes::<cp_amm::accounts::Position>(&data[8..8 + core::mem::size_of::<cp_amm::accounts::Position>()]))
}

/// Same checks as `check_nft_account` on a raw Token-2022 account created earlier in this instruction.
pub fn check_nft_account_raw(info: &AccountInfo, vault: &Pubkey, nft_mint: &Pubkey) -> Result<()> {
    require_keys_eq!(*info.owner, anchor_spl::token_2022::ID, VaultError::ForeignAccount);
    let data = info.try_borrow_data()?;
    let acc = StateWithExtensions::<TokenAccountState>::unpack(&data).map_err(|_| VaultError::ForeignAccount)?;
    require_keys_eq!(acc.base.owner, *vault, VaultError::AccountMismatch);
    require_keys_eq!(acc.base.mint, *nft_mint, VaultError::AccountMismatch);
    require!(acc.base.amount == 1, VaultError::AccountMismatch);
    require!(acc.base.delegate.is_none(), VaultError::HasDelegate);
    Ok(())
}

/// A DAMM v2 pool whose fees arrive as WSOL only, with an eligible base mint.
pub fn check_damm_pool(pool: &cp_amm::accounts::Pool, base_mint: &AccountInfo) -> Result<()> {
    require_keys_eq!(pool.token_b_mint, WSOL_MINT, VaultError::Ineligible);
    require!(pool.collect_fee_mode == DAMM_COLLECT_ONLY_B || pool.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, VaultError::Ineligible);
    require_keys_eq!(pool.token_a_mint, base_mint.key(), VaultError::AccountMismatch);
    check_base_mint(base_mint)
}

/// A position that carries only permanently locked liquidity (plus rounding dust).
pub fn check_position_principal(pos: &cp_amm::accounts::Position) -> Result<()> {
    require!(pos.permanent_locked_liquidity > 0, VaultError::Principal);
    require!(pos.vested_liquidity == 0, VaultError::Principal);
    require!(pos.unlocked_liquidity <= MAX_UNLOCKED_DUST, VaultError::Principal);
    Ok(())
}

pub struct DbcEligibility {
    pub derived_damm_pool: Pubkey,
    pub migration_progress: u8,
    pub one_time_claims: u8,
}

/// DBC creator rights: WSOL quote, quote-only fees, DAMM v2 migration, and a migration
/// outcome the vault can hold (B-only fees, creator liquidity permanently locked only).
pub fn check_dbc_rights(pool: &dbc::types::PoolState, config_key: &Pubkey, config: &dbc::accounts::PoolConfig, base_mint: &AccountInfo, vault: &Pubkey) -> Result<DbcEligibility> {
    require_keys_eq!(pool.config, *config_key, VaultError::AccountMismatch);
    require_keys_eq!(pool.creator, *vault, VaultError::AccountMismatch);
    require_keys_eq!(pool.base_mint, base_mint.key(), VaultError::AccountMismatch);
    require_keys_eq!(config.quote_mint, WSOL_MINT, VaultError::Ineligible);
    require!(config.collect_fee_mode == DBC_COLLECT_QUOTE, VaultError::Ineligible);
    require!(config.migration_option == DBC_MIGRATION_DAMM_V2, VaultError::Ineligible);
    require!(config.migrated_collect_fee_mode == DBC_MIGRATED_QUOTE || config.migrated_collect_fee_mode == DBC_MIGRATED_COMPOUNDING, VaultError::Ineligible);
    require!(config.creator_permanent_locked_liquidity_percentage > 0, VaultError::Ineligible);
    require!(config.creator_liquidity_percentage == 0, VaultError::Ineligible);
    require!(config.creator_liquidity_vesting_info.vesting_percentage == 0, VaultError::Ineligible);
    require!(pool.migration_progress == DBC_PROGRESS_PRE_BONDING || pool.migration_progress == DBC_PROGRESS_CREATED_POOL, VaultError::Ineligible);
    check_base_mint(base_mint)?;
    let option = config.migration_fee_option as usize;
    require!(option < DAMM_V2_MIGRATION_CONFIGS.len(), VaultError::Ineligible);
    let derived_damm_pool = derive_damm_pool(&DAMM_V2_MIGRATION_CONFIGS[option], &pool.base_mint, &WSOL_MINT);
    let mut one_time_claims = 0u8;
    if pool.migration_fee_withdraw_status & DBC_CREATOR_MIGRATION_FEE_MASK != 0 { one_time_claims |= 1; }
    if pool.is_creator_withdraw_surplus != 0 { one_time_claims |= 2; }
    Ok(DbcEligibility { derived_damm_pool, migration_progress: pool.migration_progress, one_time_claims })
}

/// cp-amm's own token account for a position NFT: `["position_nft_account", nft_mint]`
/// (`cpamm/instructions/ix_create_position.rs:38-46`; no immutable-owner extension). The DBC
/// migration creates both positions there and re-authorizes them to the creator and the
/// partner with SetAuthority (`migrate_damm_v2_initialize_pool.rs:326-346, 657-662`).
pub fn position_nft_account_pda(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position_nft_account", nft_mint.as_ref()], &cp_amm::ID).0
}

/// a * b as a 256-bit (high, low) pair: exact for any u128 operands.
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a_hi, a_lo) = (a >> 64, a & 0xFFFF_FFFF_FFFF_FFFF);
    let (b_hi, b_lo) = (b >> 64, b & 0xFFFF_FFFF_FFFF_FFFF);
    let ll = a_lo * b_lo;
    let lh = a_lo * b_hi;
    let hl = a_hi * b_lo;
    let hh = a_hi * b_hi;
    let (mid, c1) = (lh & 0xFFFF_FFFF_FFFF_FFFF).overflowing_add(hl & 0xFFFF_FFFF_FFFF_FFFF);
    let (lo, c2) = ll.overflowing_add(mid << 64);
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64) + (c1 as u128) + (c2 as u128);
    (hi, lo)
}

/// a * b >= c * d, exact (no truncation, no overflow).
fn mul_ge(a: u128, b: u128, c: u128, d: u128) -> bool {
    mul_wide(a, b) >= mul_wide(c, d)
}

/// The creator-side position of a migrated DBC pool, proven structurally instead of by a
/// share of a moving total:
/// 1. the NFT sits in cp-amm's PDA account for its mint, owned by the vault with no
///    delegate. Only the migration or the previous holder (SetAuthority) can put it there,
///    and a vault-owned position cannot gain locked liquidity without the vault's signature
///    (`cpamm/state/position.rs:546-564`, `ix_permanent_lock_position.rs:48-51`,
///    `ix_add_liquidity.rs:97`).
/// 2. it carries only permanently locked liquidity (no withdrawable principal).
/// 3. its size, measured against the pool's permanently locked total T
///    (`pool.permanent_lock_liquidity`, `cpamm/state/pool.rs:166`; `add_liquidity` leaves it
///    unchanged, `pool.rs:888-904`; only permanent locks raise it, `pool.rs:1070-1076`). The
///    chain records no role for a migrated position (both are plain cp-amm positions,
///    `ix_create_position.rs:18-46`), so this is a size policy, stated exactly:
///    - external streams, creator share C above the partner's P: the position must hold a
///      majority of T (`2A >= T`). The partner position (P/(C+P) < 1/2) never qualifies; the
///      creator position (A = T0*C/(C+P)) qualifies until newly locked liquidity exceeds
///      T0*(C-P)/(C+P), 60% of the migration at 80/20.
///    - external streams, C <= P: at least half the creator's share (`2A(C+P) >= TC`,
///      liveness until newly locked liquidity exceeds T0) and at most nine eighths of it
///      (`8A(C+P) <= 9TC`): the partner position, bigger by P/C, is refused unless P/C <= 9/8,
///      in which case it is at most an eighth larger than the creator's and never smaller.
///    - the vault's own position (`register_own_position`): the lower bound only. The
///      partner there is the protocol itself, and the own registration is on the path to
///      Live, so it keeps the widest liveness margin.
///    Rounding: the migration floors each distribution (`dbc/state/config.rs:951-992`) and the
///    second position's liquidity is recomputed from the leftover amounts, so the shares are
///    exact to within a few units; the bounds above sit far from those margins.
pub fn check_creator_position(
    pool: &cp_amm::accounts::Pool,
    pos: &cp_amm::accounts::Position,
    nft_account: &InterfaceAccount<TokenAccount>,
    vault: &Pubkey,
    creator_pct: u8,
    partner_pct: u8,
    external: bool,
) -> Result<()> {
    require_keys_eq!(nft_account.key(), position_nft_account_pda(&pos.nft_mint), VaultError::AccountMismatch);
    check_nft_account(nft_account, vault, &pos.nft_mint)?;
    check_position_principal(pos)?;
    let (c, p) = (creator_pct as u128, partner_pct as u128);
    let total_pct = c.checked_add(p).ok_or(VaultError::Overflow)?;
    require!(creator_pct > 0 && total_pct <= 100, VaultError::Ineligible);
    let (a, t) = (pos.permanent_locked_liquidity, pool.permanent_lock_liquidity);
    if external && c > p {
        // a majority of everything permanently locked
        require!(mul_ge(a, 2, t, 1), VaultError::AccountMismatch);
    } else {
        // at least half the creator's share: 2A(C+P) >= TC
        require!(mul_ge(a, total_pct * 2, t, c), VaultError::AccountMismatch);
    }
    if external {
        // at most nine eighths of the creator's share: 8A(C+P) <= 9TC
        require!(mul_ge(t, 9 * c, a, 8 * total_pct), VaultError::AccountMismatch);
    }
    Ok(())
}
