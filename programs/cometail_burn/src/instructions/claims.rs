//! Claims, permissionless: Meteora fees owed to the claimer PDA (the fee claimer of the launch configs
//! created for this program) are claimed into the program's inbox and split in the same instruction:
//! BURN_SHARE_BPS to the burn reserve, the rest to the protocol treasury. Nothing else can move the inbox.
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

/// Splits the whole inbox: half (rounded down) to the reserve, the rest to the treasury.
fn split(c: &mut SplitCommon, source: u8, pool: Pubkey) -> Result<()> {
    c.inbox.reload()?;
    let amount = c.inbox.amount;
    if amount == 0 { return Ok(()); }
    let to_reserve = ((amount as u128) * (BURN_SHARE_BPS as u128) / (BPS as u128)) as u64;
    let to_treasury = amount - to_reserve;
    let bump = [c.burn_state.bump];
    let signer: &[&[u8]] = &[SEED_BURN, &bump];
    for (to, value) in [(c.reserve.to_account_info(), to_reserve), (c.treasury.to_account_info(), to_treasury)] {
        if value == 0 { continue; }
        token::transfer(CpiContext::new_with_signer(c.token_program.key(), Transfer {
            from: c.inbox.to_account_info(), to, authority: c.burn_state.to_account_info(),
        }, &[signer]), value)?;
    }
    let s = &mut c.burn_state;
    s.split_total = s.split_total.checked_add(amount).ok_or(BurnError::Overflow)?;
    s.split_to_reserve = s.split_to_reserve.checked_add(to_reserve).ok_or(BurnError::Overflow)?;
    s.split_to_treasury = s.split_to_treasury.checked_add(to_treasury).ok_or(BurnError::Overflow)?;
    emit!(FeesSplit { source, pool, amount, to_reserve, to_treasury });
    Ok(())
}

fn claimer_seeds(c: &SplitCommon) -> [u8; 1] { [c.burn_state.claimer_bump] }

// ---------------------------------------------------------------------------------------
// DBC partner trading fees (quote only)
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct ClaimCurveFees<'info> {
    pub common: SplitCommon<'info>,
    /// CHECK: a DBC config whose fee claimer is our claimer (DBC enforces has_one fee_claimer)
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

pub fn claim_curve_fees(ctx: Context<ClaimCurveFees>) -> Result<()> {
    let c = &ctx.accounts.common;
    let bump = claimer_seeds(c);
    let signer: &[&[u8]] = &[SEED_CLAIMER, &bump];
    // quote only: max_base = 0 (the new configs collect fees in SOL); token A's destination is the placeholder
    dbc::cpi::claim_trading_fee(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::ClaimTradingFee {
        pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(), config: ctx.accounts.config.to_account_info(), pool: ctx.accounts.pool.to_account_info(),
        token_a_account: c.placeholder.to_account_info(), token_b_account: c.inbox.to_account_info(),
        base_vault: ctx.accounts.base_vault.to_account_info(), quote_vault: ctx.accounts.quote_vault.to_account_info(),
        base_mint: ctx.accounts.base_mint.to_account_info(), quote_mint: c.wsol_mint.to_account_info(), fee_claimer: c.claimer.to_account_info(),
        token_base_program: ctx.accounts.base_token_program.to_account_info(), token_quote_program: c.token_program.to_account_info(),
        event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
    }, &[signer]), 0, u64::MAX)?;
    let pool = ctx.accounts.pool.key();
    split(&mut ctx.accounts.common, SOURCE_CURVE_FEE, pool)
}

// ---------------------------------------------------------------------------------------
// DBC partner share of the pool creation fee (lamports, wrapped in the inbox)
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct ClaimCreationFee<'info> {
    pub common: SplitCommon<'info>,
    /// CHECK: a DBC config whose fee claimer is our claimer (checked by the callee)
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

pub fn claim_creation_fee(ctx: Context<ClaimCreationFee>) -> Result<()> {
    let c = &ctx.accounts.common;
    let bump = claimer_seeds(c);
    let signer: &[&[u8]] = &[SEED_CLAIMER, &bump];
    // the lamports land straight in the inbox (a WSOL account) and are synced into its balance
    dbc::cpi::claim_partner_pool_creation_fee(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::ClaimPartnerPoolCreationFee {
        config: ctx.accounts.config.to_account_info(), pool: ctx.accounts.pool.to_account_info(), fee_claimer: c.claimer.to_account_info(),
        fee_receiver: c.inbox.to_account_info(), event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
    }, &[signer]))?;
    token::sync_native(CpiContext::new(c.token_program.key(), SyncNative { account: c.inbox.to_account_info() }))?;
    let pool = ctx.accounts.pool.key();
    split(&mut ctx.accounts.common, SOURCE_CREATION_FEE, pool)
}

// ---------------------------------------------------------------------------------------
// DBC partner surplus after migration
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct ClaimSurplus<'info> {
    pub common: SplitCommon<'info>,
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

pub fn claim_surplus(ctx: Context<ClaimSurplus>) -> Result<()> {
    let c = &ctx.accounts.common;
    let bump = claimer_seeds(c);
    let signer: &[&[u8]] = &[SEED_CLAIMER, &bump];
    dbc::cpi::partner_withdraw_surplus(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::PartnerWithdrawSurplus {
        pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(), config: ctx.accounts.config.to_account_info(), virtual_pool: ctx.accounts.pool.to_account_info(),
        token_quote_account: c.inbox.to_account_info(), quote_vault: ctx.accounts.quote_vault.to_account_info(), quote_mint: c.wsol_mint.to_account_info(),
        fee_claimer: c.claimer.to_account_info(), token_quote_program: c.token_program.to_account_info(),
        event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
    }, &[signer]))?;
    let pool = ctx.accounts.pool.key();
    split(&mut ctx.accounts.common, SOURCE_SURPLUS, pool)
}

// ---------------------------------------------------------------------------------------
// The partner's locked DAMM v2 position after migration (compounding pools pay in SOL only)
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct ClaimPositionFees<'info> {
    pub common: SplitCommon<'info>,
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, constraint = position.load()?.pool == pool.key() @ BurnError::AccountMismatch)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    /// The position NFT's token account: Meteora's migration sets its owner to the fee claimer.
    #[account(constraint = position_nft_account.owner == common.claimer.key() @ BurnError::NotOurConfig)]
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

pub fn claim_position_fees(ctx: Context<ClaimPositionFees>) -> Result<()> {
    {
        let p = ctx.accounts.pool.load()?;
        // SOL is token B and the pool pays fees in token B only: nothing can reach the placeholder
        require_keys_eq!(p.token_b_mint, WSOL_MINT, BurnError::PoolNotEligible);
        require!(p.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, BurnError::PoolNotEligible);
    }
    let c = &ctx.accounts.common;
    let bump = claimer_seeds(c);
    let signer: &[&[u8]] = &[SEED_CLAIMER, &bump];
    cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(ctx.accounts.cp_amm_program.key(), cp_amm::cpi::accounts::ClaimPositionFee {
        pool_authority: ctx.accounts.pool_authority.to_account_info(), pool: ctx.accounts.pool.to_account_info(), position: ctx.accounts.position.to_account_info(),
        token_a_account: c.placeholder.to_account_info(), token_b_account: c.inbox.to_account_info(),
        token_a_vault: ctx.accounts.token_a_vault.to_account_info(), token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
        token_a_mint: ctx.accounts.token_a_mint.to_account_info(), token_b_mint: c.wsol_mint.to_account_info(),
        position_nft_account: ctx.accounts.position_nft_account.to_account_info(), signer: c.claimer.to_account_info(),
        token_a_program: ctx.accounts.token_a_program.to_account_info(), token_b_program: c.token_program.to_account_info(),
        event_authority: ctx.accounts.cp_amm_event_authority.to_account_info(), program: ctx.accounts.cp_amm_program.to_account_info(),
    }, &[signer]))?;
    let pool = ctx.accounts.pool.key();
    split(&mut ctx.accounts.common, SOURCE_POSITION_FEE, pool)
}

// ---------------------------------------------------------------------------------------
// Anything sent to the inbox directly: split the same way
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct SweepInbox<'info> {
    pub common: SplitCommon<'info>,
}

pub fn sweep_inbox(ctx: Context<SweepInbox>) -> Result<()> {
    token::sync_native(CpiContext::new(ctx.accounts.common.token_program.key(), SyncNative { account: ctx.accounts.common.inbox.to_account_info() }))?;
    split(&mut ctx.accounts.common, SOURCE_INBOX, Pubkey::default())
}

#[event]
pub struct FeesSplit { pub source: u8, pub pool: Pubkey, pub amount: u64, pub to_reserve: u64, pub to_treasury: u64 }
