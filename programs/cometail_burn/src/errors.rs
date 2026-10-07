use anchor_lang::prelude::*;

#[error_code]
pub enum BurnError {
    #[msg("Signer is not this program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Account does not match the pinned setup")]
    AccountMismatch,
    #[msg("Pool is not a constant-fee compounding $COMETAIL/SOL pool")]
    PoolNotEligible,
    #[msg("Pool fee settings changed since setup")]
    PoolChanged,
    #[msg("Next buyback is not due yet")]
    Cooldown,
    #[msg("Nothing to buy: below the minimum buy")]
    BelowMinimum,
    #[msg("Swap returned less than the program's minimum")]
    SlippageExceeded,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Config does not name this program's claimer")]
    NotOurConfig,
}
