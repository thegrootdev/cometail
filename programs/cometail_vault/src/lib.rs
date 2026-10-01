//! COMETAIL vault program.
//!
//! Custodies Meteora fee streams (DBC creator rights and DAMM v2 position NFTs) under a
//! vault PDA, launches the stream token on DBC with that PDA as pool creator, harvests
//! income through CPI, and turns it into DLMM limit-order bids that burn what they fill.
//! See docs/architecture.md for the full design.

use anchor_lang::prelude::*;

declare_id!("5xmZWYheruQjHQChg5YVtXjZUNmVKzvjJ6FYArtf4tmg");

// Meteora programs, bound to the IDLs under idls/ (versions pinned in idls/README.md).
declare_program!(dynamic_bonding_curve);
declare_program!(cp_amm);
declare_program!(lb_clmm);

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::RoutingPolicy;

#[program]
pub mod cometail_vault {
    use super::*;

    pub fn init_protocol(ctx: Context<InitProtocol>, stream_configs: [Pubkey; 3]) -> Result<()> {
        instructions::init_protocol(ctx, stream_configs)
    }

    pub fn update_protocol(ctx: Context<UpdateProtocol>, update: ProtocolUpdate) -> Result<()> {
        instructions::update_protocol(ctx, update)
    }

    pub fn create_vault(ctx: Context<CreateVault>, st_mint: Pubkey, policy: RoutingPolicy) -> Result<()> {
        instructions::create_vault(ctx, st_mint, policy)
    }
}
