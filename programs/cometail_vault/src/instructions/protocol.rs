use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::constants::*;
use crate::errors::VaultError;
use crate::state::*;

#[derive(Accounts)]
pub struct InitProtocol<'info> {
    #[account(init, payer = payer, space = 8 + Protocol::INIT_SPACE, seeds = [SEED_PROTOCOL], bump)]
    pub protocol: Account<'info, Protocol>,
    /// The protocol owner's wallet. Signs once, here, from the owner's own machine.
    pub admin: Signer<'info>,
    /// CHECK: hot key; only ever compared by key.
    pub keeper: UncheckedAccount<'info>,
    /// The owner's WSOL token account: receives the protocol share of external stream income.
    #[account(constraint = treasury.mint == WSOL_MINT @ VaultError::AccountMismatch, constraint = treasury.owner == admin.key() @ VaultError::AccountMismatch)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_protocol(ctx: Context<InitProtocol>, stream_configs: [Pubkey; 3]) -> Result<()> {
    let p = &mut ctx.accounts.protocol;
    p.admin = ctx.accounts.admin.key();
    p.keeper = ctx.accounts.keeper.key();
    p.treasury = ctx.accounts.treasury.key();
    p.stream_configs = stream_configs;
    p.paused_routing = false;
    p.bump = ctx.bumps.protocol;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProtocolUpdate {
    pub keeper: Option<Pubkey>,
    pub treasury: Option<Pubkey>,
    pub stream_configs: Option<[Pubkey; 3]>,
    pub paused_routing: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateProtocol<'info> {
    #[account(mut, seeds = [SEED_PROTOCOL], bump = protocol.bump, has_one = admin @ VaultError::NotAdmin)]
    pub protocol: Account<'info, Protocol>,
    pub admin: Signer<'info>,
}

pub fn update_protocol(ctx: Context<UpdateProtocol>, update: ProtocolUpdate) -> Result<()> {
    let p = &mut ctx.accounts.protocol;
    if let Some(k) = update.keeper { p.keeper = k; }
    if let Some(t) = update.treasury { p.treasury = t; }
    if let Some(c) = update.stream_configs { p.stream_configs = c; }
    if let Some(x) = update.paused_routing { p.paused_routing = x; }
    Ok(())
}
