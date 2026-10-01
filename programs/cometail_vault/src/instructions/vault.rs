use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::VaultError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(st_mint: Pubkey)]
pub struct CreateVault<'info> {
    #[account(init, payer = depositor, space = 8 + Vault::INIT_SPACE, seeds = [SEED_VAULT, st_mint.as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Account<'info, Mint>,
    /// The depositor's WSOL ATA: created if missing, pinned as the only payout destination.
    #[account(init_if_needed, payer = depositor, associated_token::mint = wsol_mint, associated_token::authority = depositor)]
    pub depositor_wsol: Account<'info, TokenAccount>,
    /// Vault-owned WSOL ATA: income.
    #[account(init, payer = depositor, associated_token::mint = wsol_mint, associated_token::authority = vault)]
    pub income_wsol: Account<'info, TokenAccount>,
    /// Vault-owned WSOL account that is not the ATA: the token A destination for claims.
    #[account(init, payer = depositor, token::mint = wsol_mint, token::authority = vault)]
    pub placeholder_wsol: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_vault(ctx: Context<CreateVault>, st_mint: Pubkey, policy: RoutingPolicy) -> Result<()> {
    require!(policy.period_seconds > 0, VaultError::InvalidPolicy);
    require!(policy.max_bins_per_order >= 1 && policy.max_bins_per_order <= MAX_BINS_PER_ORDER, VaultError::InvalidPolicy);
    require!(policy.max_outstanding_orders >= 1, VaultError::InvalidPolicy);
    require!(policy.max_price_q64 > 0, VaultError::InvalidPolicy);
    require!(policy.max_spend_per_period > 0, VaultError::InvalidPolicy);
    let v = &mut ctx.accounts.vault;
    v.depositor = ctx.accounts.depositor.key();
    v.depositor_wsol = ctx.accounts.depositor_wsol.key();
    v.status = VaultStatus::Open;
    v.st_mint = st_mint;
    v.st_ata = anchor_spl::associated_token::get_associated_token_address(&v.key(), &st_mint);
    v.income_wsol = ctx.accounts.income_wsol.key();
    v.placeholder_wsol = ctx.accounts.placeholder_wsol.key();
    v.policy = policy;
    v.bump = ctx.bumps.vault;
    Ok(())
}
