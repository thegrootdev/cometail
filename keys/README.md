# Keys

Nothing in this directory is committed. Local and devnet keys are throwaway:

```
solana-keygen new --no-bip39-passphrase -o keys/local/payer.json
solana-keygen new --no-bip39-passphrase -o keys/local/cometail_vault-keypair.json
cp keys/local/cometail_vault-keypair.json target/deploy/   # anchor deploys with this keypair
```

The program id in `Anchor.toml` and `declare_id!` must match the keypair you deploy with
(`anchor keys sync` after generating a new one). The harness never reads a key: it takes
the program id from the built IDL.
