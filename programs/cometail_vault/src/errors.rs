use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Vault is not in the required status")]
    WrongStatus,
    #[msg("Only the recorded depositor may do this")]
    NotDepositor,
    #[msg("Only the keeper may do this")]
    NotKeeper,
    #[msg("Only the admin may do this")]
    NotAdmin,
    #[msg("Stream is not eligible")]
    Ineligible,
    #[msg("Account does not match the recorded one")]
    AccountMismatch,
    #[msg("Account is owned by the wrong program or has the wrong discriminator")]
    ForeignAccount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Routing is paused")]
    Paused,
    #[msg("Routing policy violated")]
    PolicyViolation,
    #[msg("Invalid policy parameters")]
    InvalidPolicy,
    #[msg("Preset out of range")]
    InvalidPreset,
    #[msg("Source already deposited")]
    Duplicate,
    #[msg("Token account has a delegate")]
    HasDelegate,
    #[msg("Position carries withdrawable principal")]
    Principal,
    #[msg("Stream token mint does not match the vault")]
    WrongMint,
    #[msg("The unwind window since launch has not passed")]
    TooEarly,
    #[msg("The curve reached its threshold: the vault graduates instead of unwinding")]
    NotUnwindable,
    #[msg("The pool migrated: register its creator position on this stream before withdrawing")]
    RegisterPositionFirst,
}
