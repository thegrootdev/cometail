//! Claims. Every claim measures what it pays: the inbox is synced and read before the Meteora call and after
//! it, so the claim's own amount (`claimed`) is never mixed with what was already there (`carried`).
//!
//! - Program claims (permissionless): fees owed to the claimer PDA (the fee claimer of the launch configs
//!   created for this program). The whole inbox is split: BURN_SHARE_BPS to the burn reserve, the rest to
//!   the protocol treasury; the event says how much of it this claim paid and how much was carried.
//! - Owner claims (signed by the fee claimer or position holder of an older config or position): the claim
//!   lands in the inbox and only its own measured amount is split: half to the burn reserve, half to the
//!   signer's own WSOL account. Funds carried in the inbox stay for the next program split.
//! Nothing else can move the inbox.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, SyncNative, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::cp_amm;
use crate::dynamic_bonding_curve as dbc;
use crate::errors::BurnError;
use crate::state::BurnState;

/// Where a split's money came from (event field `source`).
pub const SOURCE_CURVE_FEE: u8 = 0;
pub const SOURCE_CREATION_FEE: u8 = 1;
pub const SOURCE_SURPLUS: u8 = 2;
pub const SOURCE_POSITION_FEE: u8 = 3;
pub const SOURCE_INBOX: u8 = 4;

#[derive(Accounts)]
pub struct SplitCommon<'info> {
    #[account(mut, seeds = [SEED_BURN], bump = burn_state.bump)]
    pub burn_state: Box<Account<'info, BurnState>>,
    /// CHECK: the claimer PDA; signs Meteora claims, holds nothing
    #[account(seeds = [SEED_CLAIMER], bump = burn_state.claimer_bump)]
    pub claimer: UncheckedAccount<'info>,
    #[account(mut, address = burn_state.inbox @ BurnError::AccountMismatch)]
    pub inbox: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = burn_state.placeholder @ BurnError::AccountMismatch)]
    pub placeholder: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = burn_state.reserve @ BurnError::AccountMismatch)]
    pub reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = burn_state.treasury @ BurnError::AccountMismatch)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OwnerCommon<'info> {
    #[account(mut, seeds = [SEED_BURN], bump = burn_state.bump)]
    pub burn_state: Box<Account<'info, BurnState>>,
    #[account(mut, address = burn_state.inbox @ BurnError::AccountMismatch)]
    pub inbox: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = burn_state.placeholder @ BurnError::AccountMismatch)]
    pub placeholder: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = burn_state.reserve @ BurnError::AccountMismatch)]
    pub reserve: Box<Account<'info, TokenAccount>>,
    /// The fee claimer of the config (DBC checks it) or the holder of the position NFT (checked here).
    pub owner: Signer<'info>,
    /// The signer's own WSOL account: the only place the other half can go.
    #[account(mut, constraint = owner_wsol.owner == owner.key() @ BurnError::AccountMismatch, constraint = owner_wsol.mint == WSOL_MINT @ BurnError::AccountMismatch)]
    pub owner_wsol: Box<Account<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// The inbox's balance with any lamports sent to it counted (sync_native, then read).
fn synced<'info>(inbox: &mut Box<Account<'info, TokenAccount>>, token_program: &Program<'info, Token>) -> Result<u64> {
    token::sync_native(CpiContext::new(token_program.key(), SyncNative { account: inbox.to_account_info() }))?;
    inbox.reload()?;
    Ok(inbox.amount)
}

/// Pays `amount` out of the inbox: half (rounded down) to the reserve, the rest to `other`; books it.
#[allow(clippy::too_many_arguments)]
fn pay<'info>(burn_state: &mut Box<Account<'info, BurnState>>, inbox: &Box<Account<'info, TokenAccount>>, reserve: AccountInfo<'info>, other: AccountInfo<'info>, token_program: &Program<'info, Token>, amount: u64) -> Result<(u64, u64)> {
    let to_reserve = ((amount as u128) * (BURN_SHARE_BPS as u128) / (BPS as u128)) as u64;
    let to_other = amount - to_reserve;
    let bump = [burn_state.bump];
    let signer: &[&[u8]] = &[SEED_BURN, &bump];
    for (to, value) in [(reserve, to_reserve), (other, to_other)] {
        if value == 0 { continue; }
        token::transfer(CpiContext::new_with_signer(token_program.key(), Transfer { from: inbox.to_account_info(), to, authority: burn_state.to_account_info() }, &[signer]), value)?;
    }
    burn_state.split_total = burn_state.split_total.checked_add(amount).ok_or(BurnError::Overflow)?;
    burn_state.split_to_reserve = burn_state.split_to_reserve.checked_add(to_reserve).ok_or(BurnError::Overflow)?;
    burn_state.split_to_treasury = burn_state.split_to_treasury.checked_add(to_other).ok_or(BurnError::Overflow)?;
    Ok((to_reserve, to_other))
}

/// Program split: the whole inbox (this claim's `claimed` plus whatever was `carried`) to reserve and treasury.
fn program_split(c: &mut SplitCommon, source: u8, pool: Pubkey, carried: u64) -> Result<()> {
    let after = synced(&mut c.inbox, &c.token_program)?;
    let claimed = after.checked_sub(carried).ok_or(BurnError::Overflow)?;
    if after == 0 { return Ok(()); }
    let (to_reserve, to_other) = pay(&mut c.burn_state, &c.inbox, c.reserve.to_account_info(), c.treasury.to_account_info(), &c.token_program, after)?;
    emit!(ClaimSplit { source, pool, claimant: Pubkey::default(), claimed, carried, to_reserve, to_other, other: c.treasury.key() });
    Ok(())
}

/// Owner split: only this claim's own amount, half to the reserve, half back to the signer's WSOL account.
fn owner_split(c: &mut OwnerCommon, source: u8, pool: Pubkey, carried: u64) -> Result<()> {
    let after = synced(&mut c.inbox, &c.token_program)?;
    let claimed = after.checked_sub(carried).ok_or(BurnError::Overflow)?;
    if claimed == 0 { return Ok(()); }
    let (to_reserve, to_other) = pay(&mut c.burn_state, &c.inbox, c.reserve.to_account_info(), c.owner_wsol.to_account_info(), &c.token_program, claimed)?;
    emit!(ClaimSplit { source, pool, claimant: c.owner.key(), claimed, carried, to_reserve, to_other, other: c.owner_wsol.key() });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Meteora calls, shared by both kinds of claim: `fee_claimer` signs (the claimer PDA through
// `seeds`, or the owner's own signature with no seeds)
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct CurveAccounts<'info> {
    /// CHECK: a DBC config; DBC enforces that its fee claimer signs
    pub config: UncheckedAccount<'info>,
    /// CHECK: the config's pool, checked by the callee
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DBC pool authority, by address
    #[account(address = DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: the base mint's token program, checked by the callee
    pub base_token_program: UncheckedAccount<'info>,
    /// CHECK: DBC program, by address
    #[account(address = dbc::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    pub dbc_event_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreationFeeAccounts<'info> {
    /// CHECK: a DBC config (checked by the callee)
    pub config: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DBC program, by address
    #[account(address = dbc::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    pub dbc_event_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SurplusAccounts<'info> {
    /// CHECK: checked by the callee
    pub config: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DBC pool authority, by address
    #[account(address = DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: DBC program, by address
    #[account(address = dbc::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    pub dbc_event_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PositionAccounts<'info> {
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, constraint = position.load()?.pool == pool.key() @ BurnError::AccountMismatch)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    pub position_nft_account: Box<InterfaceAccount<'info, anchor_spl::token_interface::TokenAccount>>,
    /// CHECK: DAMM v2 pool authority, by address
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    pub token_a_mint: UncheckedAccount<'info>,
    /// CHECK: token A's program, checked by the callee
    pub token_a_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 program, by address
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: checked by the callee
    pub cp_amm_event_authority: UncheckedAccount<'info>,
}

#[allow(clippy::too_many_arguments)]
fn cpi_curve<'info>(m: &CurveAccounts<'info>, fee_claimer: AccountInfo<'info>, placeholder: AccountInfo<'info>, inbox: AccountInfo<'info>, wsol: AccountInfo<'info>, token_program: AccountInfo<'info>, seeds: &[&[&[u8]]]) -> Result<()> {
    // quote only: max_base = 0; token A's destination is the placeholder (never paid)
    dbc::cpi::claim_trading_fee(CpiContext::new_with_signer(m.dbc_program.key(), dbc::cpi::accounts::ClaimTradingFee {
        pool_authority: m.dbc_pool_authority.to_account_info(), config: m.config.to_account_info(), pool: m.pool.to_account_info(),
        token_a_account: placeholder, token_b_account: inbox, base_vault: m.base_vault.to_account_info(), quote_vault: m.quote_vault.to_account_info(),
        base_mint: m.base_mint.to_account_info(), quote_mint: wsol, fee_claimer,
        token_base_program: m.base_token_program.to_account_info(), token_quote_program: token_program,
        event_authority: m.dbc_event_authority.to_account_info(), program: m.dbc_program.to_account_info(),
    }, seeds), 0, u64::MAX)
}
fn cpi_creation<'info>(m: &CreationFeeAccounts<'info>, fee_claimer: AccountInfo<'info>, inbox: AccountInfo<'info>, seeds: &[&[&[u8]]]) -> Result<()> {
    // the lamports land straight in the inbox (a WSOL account); the split syncs them into its balance
    dbc::cpi::claim_partner_pool_creation_fee(CpiContext::new_with_signer(m.dbc_program.key(), dbc::cpi::accounts::ClaimPartnerPoolCreationFee {
        config: m.config.to_account_info(), pool: m.pool.to_account_info(), fee_claimer, fee_receiver: inbox,
        event_authority: m.dbc_event_authority.to_account_info(), program: m.dbc_program.to_account_info(),
    }, seeds))
}
fn cpi_surplus<'info>(m: &SurplusAccounts<'info>, fee_claimer: AccountInfo<'info>, inbox: AccountInfo<'info>, wsol: AccountInfo<'info>, token_program: AccountInfo<'info>, seeds: &[&[&[u8]]]) -> Result<()> {
    dbc::cpi::partner_withdraw_surplus(CpiContext::new_with_signer(m.dbc_program.key(), dbc::cpi::accounts::PartnerWithdrawSurplus {
        pool_authority: m.dbc_pool_authority.to_account_info(), config: m.config.to_account_info(), virtual_pool: m.pool.to_account_info(),
        token_quote_account: inbox, quote_vault: m.quote_vault.to_account_info(), quote_mint: wsol, fee_claimer, token_quote_program: token_program,
        event_authority: m.dbc_event_authority.to_account_info(), program: m.dbc_program.to_account_info(),
    }, seeds))
}
#[allow(clippy::too_many_arguments)]
fn cpi_position<'info>(m: &PositionAccounts<'info>, signer: AccountInfo<'info>, placeholder: AccountInfo<'info>, inbox: AccountInfo<'info>, wsol: AccountInfo<'info>, token_program: AccountInfo<'info>, seeds: &[&[&[u8]]]) -> Result<()> {
    {
        let p = m.pool.load()?;
        // SOL is token B and the pool pays fees in token B only: nothing can reach the placeholder
        require_keys_eq!(p.token_b_mint, WSOL_MINT, BurnError::PoolNotEligible);
        require!(p.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, BurnError::PoolNotEligible);
    }
    require_keys_eq!(m.position_nft_account.owner, signer.key(), BurnError::NotOurConfig);
    cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(m.cp_amm_program.key(), cp_amm::cpi::accounts::ClaimPositionFee {
        pool_authority: m.pool_authority.to_account_info(), pool: m.pool.to_account_info(), position: m.position.to_account_info(),
        token_a_account: placeholder, token_b_account: inbox, token_a_vault: m.token_a_vault.to_account_info(), token_b_vault: m.token_b_vault.to_account_info(),
        token_a_mint: m.token_a_mint.to_account_info(), token_b_mint: wsol, position_nft_account: m.position_nft_account.to_account_info(), signer,
        token_a_program: m.token_a_program.to_account_info(), token_b_program: token_program,
        event_authority: m.cp_amm_event_authority.to_account_info(), program: m.cp_amm_program.to_account_info(),
    }, seeds))
}

// ---------------------------------------------------------------------------------------
// Program claims (the claimer PDA signs)
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct ClaimCurveFees<'info> { pub common: SplitCommon<'info>, pub meteora: CurveAccounts<'info> }
#[derive(Accounts)]
pub struct ClaimCreationFee<'info> { pub common: SplitCommon<'info>, pub meteora: CreationFeeAccounts<'info> }
#[derive(Accounts)]
pub struct ClaimSurplus<'info> { pub common: SplitCommon<'info>, pub meteora: SurplusAccounts<'info> }
#[derive(Accounts)]
pub struct ClaimPositionFees<'info> { pub common: SplitCommon<'info>, pub meteora: PositionAccounts<'info> }
#[derive(Accounts)]
pub struct SweepInbox<'info> { pub common: SplitCommon<'info> }

macro_rules! claimer_seeds { ($c:expr, $b:ident, $s:ident) => { let $b = [$c.burn_state.claimer_bump]; let $s: &[&[u8]] = &[SEED_CLAIMER, &$b]; } }

pub fn claim_curve_fees(ctx: Context<ClaimCurveFees>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    claimer_seeds!(c, bump, signer);
    cpi_curve(&ctx.accounts.meteora, c.claimer.to_account_info(), c.placeholder.to_account_info(), c.inbox.to_account_info(), c.wsol_mint.to_account_info(), c.token_program.to_account_info(), &[signer])?;
    program_split(c, SOURCE_CURVE_FEE, ctx.accounts.meteora.pool.key(), carried)
}
pub fn claim_creation_fee(ctx: Context<ClaimCreationFee>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    claimer_seeds!(c, bump, signer);
    cpi_creation(&ctx.accounts.meteora, c.claimer.to_account_info(), c.inbox.to_account_info(), &[signer])?;
    program_split(c, SOURCE_CREATION_FEE, ctx.accounts.meteora.pool.key(), carried)
}
pub fn claim_surplus(ctx: Context<ClaimSurplus>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    claimer_seeds!(c, bump, signer);
    cpi_surplus(&ctx.accounts.meteora, c.claimer.to_account_info(), c.inbox.to_account_info(), c.wsol_mint.to_account_info(), c.token_program.to_account_info(), &[signer])?;
    program_split(c, SOURCE_SURPLUS, ctx.accounts.meteora.pool.key(), carried)
}
pub fn claim_position_fees(ctx: Context<ClaimPositionFees>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    claimer_seeds!(c, bump, signer);
    cpi_position(&ctx.accounts.meteora, c.claimer.to_account_info(), c.placeholder.to_account_info(), c.inbox.to_account_info(), c.wsol_mint.to_account_info(), c.token_program.to_account_info(), &[signer])?;
    program_split(c, SOURCE_POSITION_FEE, ctx.accounts.meteora.pool.key(), carried)
}
/// Anything sent to the inbox directly: split the same way, reported as carried (claimed 0).
pub fn sweep_inbox(ctx: Context<SweepInbox>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    program_split(c, SOURCE_INBOX, Pubkey::default(), carried)
}

// ---------------------------------------------------------------------------------------
// Owner claims (the owner signs: the older configs' fee claimer, or a position's holder)
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct OwnerClaimCurveFees<'info> { pub common: OwnerCommon<'info>, pub meteora: CurveAccounts<'info> }
#[derive(Accounts)]
pub struct OwnerClaimCreationFee<'info> { pub common: OwnerCommon<'info>, pub meteora: CreationFeeAccounts<'info> }
#[derive(Accounts)]
pub struct OwnerClaimSurplus<'info> { pub common: OwnerCommon<'info>, pub meteora: SurplusAccounts<'info> }
#[derive(Accounts)]
pub struct OwnerClaimPositionFees<'info> { pub common: OwnerCommon<'info>, pub meteora: PositionAccounts<'info> }

pub fn owner_claim_curve_fees(ctx: Context<OwnerClaimCurveFees>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    cpi_curve(&ctx.accounts.meteora, c.owner.to_account_info(), c.placeholder.to_account_info(), c.inbox.to_account_info(), c.wsol_mint.to_account_info(), c.token_program.to_account_info(), &[])?;
    owner_split(c, SOURCE_CURVE_FEE, ctx.accounts.meteora.pool.key(), carried)
}
pub fn owner_claim_creation_fee(ctx: Context<OwnerClaimCreationFee>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    cpi_creation(&ctx.accounts.meteora, c.owner.to_account_info(), c.inbox.to_account_info(), &[])?;
    owner_split(c, SOURCE_CREATION_FEE, ctx.accounts.meteora.pool.key(), carried)
}
pub fn owner_claim_surplus(ctx: Context<OwnerClaimSurplus>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    cpi_surplus(&ctx.accounts.meteora, c.owner.to_account_info(), c.inbox.to_account_info(), c.wsol_mint.to_account_info(), c.token_program.to_account_info(), &[])?;
    owner_split(c, SOURCE_SURPLUS, ctx.accounts.meteora.pool.key(), carried)
}
pub fn owner_claim_position_fees(ctx: Context<OwnerClaimPositionFees>) -> Result<()> {
    let c = &mut ctx.accounts.common;
    let carried = synced(&mut c.inbox, &c.token_program)?;
    cpi_position(&ctx.accounts.meteora, c.owner.to_account_info(), c.placeholder.to_account_info(), c.inbox.to_account_info(), c.wsol_mint.to_account_info(), c.token_program.to_account_info(), &[])?;
    owner_split(c, SOURCE_POSITION_FEE, ctx.accounts.meteora.pool.key(), carried)
}

/// One split. `claimed` is what this claim paid (measured on the inbox); `carried` what was already in the
/// inbox; program splits pay out both, owner splits only `claimed`. `claimant` is the default key for
/// program claims and the signer for owner claims; `other` received `to_other` (treasury, or the owner's WSOL).
#[event]
pub struct ClaimSplit { pub source: u8, pub pool: Pubkey, pub claimant: Pubkey, pub claimed: u64, pub carried: u64, pub to_reserve: u64, pub to_other: u64, pub other: Pubkey }
