//! COMETAIL burn program.
//!
//! Half of the protocol fees this program claims (the fee claimer of the launch configs created for it)
//! goes to a burn reserve; the other half to the protocol treasury. Owners of older configs and positions
//! can claim through it too: half of what their claim pays goes to the reserve, half to their own account. The reserve has one exit: a
//! permissionless buyback that swaps a bounded chunk on the pinned $COMETAIL/SOL DAMM v2 pool and burns
//! everything received, in the same instruction. There is no admin and no withdrawal instruction.
//! See docs/burn.md for the design, the bounds and their limits.

use anchor_lang::prelude::*;

declare_id!("BuN6MuTRCD7VuzwRpvJKPFwh86bsU81L23tKtRBofhX1");

// Meteora programs, bound to the IDLs under idls/ (versions pinned in idls/README.md).
declare_program!(dynamic_bonding_curve);
declare_program!(cp_amm);

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

#[program]
pub mod cometail_burn {
    use super::*;

    pub fn setup(ctx: Context<Setup>) -> Result<()> { instructions::setup::setup(ctx) }
    pub fn buyback(ctx: Context<Buyback>) -> Result<()> { instructions::buyback::buyback(ctx) }
    pub fn claim_curve_fees(ctx: Context<ClaimCurveFees>) -> Result<()> { instructions::claims::claim_curve_fees(ctx) }
    pub fn claim_creation_fee(ctx: Context<ClaimCreationFee>) -> Result<()> { instructions::claims::claim_creation_fee(ctx) }
    pub fn claim_surplus(ctx: Context<ClaimSurplus>) -> Result<()> { instructions::claims::claim_surplus(ctx) }
    pub fn claim_position_fees(ctx: Context<ClaimPositionFees>) -> Result<()> { instructions::claims::claim_position_fees(ctx) }
    pub fn sweep_inbox(ctx: Context<SweepInbox>) -> Result<()> { instructions::claims::sweep_inbox(ctx) }
    pub fn owner_claim_curve_fees(ctx: Context<OwnerClaimCurveFees>) -> Result<()> { instructions::claims::owner_claim_curve_fees(ctx) }
    pub fn owner_claim_creation_fee(ctx: Context<OwnerClaimCreationFee>) -> Result<()> { instructions::claims::owner_claim_creation_fee(ctx) }
    pub fn owner_claim_surplus(ctx: Context<OwnerClaimSurplus>) -> Result<()> { instructions::claims::owner_claim_surplus(ctx) }
    pub fn owner_claim_position_fees(ctx: Context<OwnerClaimPositionFees>) -> Result<()> { instructions::claims::owner_claim_position_fees(ctx) }
}
