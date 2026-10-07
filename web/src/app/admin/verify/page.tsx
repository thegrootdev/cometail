"use client";
// The vault program's build verification record (see VerifyRecord). The instruction bytes were produced by
// the verifier tool from the public repository and are embedded here unchanged.
import { VAULT_PROGRAM_ID } from "@cometail/client";
import { VerifyRecord } from "@/components/VerifyRecord";

/** The instruction data the verifier tool exported for this program, repository and commit (hex, unchanged):
 *  library cometail_vault, base image solanafoundation/solana-verifiable-build:3.1.10, cargo-build-sbf
 *  args --tools-version v1.57 (what Anchor 1.2.0 used for the deployed bytes). */
const VERIFY_IX_DATA = "afaf6d1f0d989bed05000000302e352e322700000068747470733a2f2f6769746875622e636f6d2f74686567726f6f746465762f636f6d657461696c2800000037343165386537353138323562303035623663656463333539613765386336643933373939376464050000000e0000002d2d6c6962726172792d6e616d650e000000636f6d657461696c5f7661756c740c0000002d2d626173652d696d6167652f000000736f6c616e61666f756e646174696f6e2f736f6c616e612d76657269666961626c652d6275696c643a332e312e31302e0000002d2d636172676f2d6275696c642d7362662d617267733d222d2d746f6f6c732d76657273696f6e2076312e353722931e041b00000000";
/** The hash of the program bytes on chain when this page was written, and the hash of the reproducible
 *  build from the same commit in the verifiable-build container. Sending needs all three equal: the
 *  chain now, this expected value, and the reproducible build. Empty until that build has run. */
const EXPECTED_ONCHAIN_HASH: string = "69490838a1bda35bec75d1484f26a06b6b49ca104aa9b7f43ad5a5c84ef9b6fa";
const REPRODUCIBLE_BUILD_HASH: string = "69490838a1bda35bec75d1484f26a06b6b49ca104aa9b7f43ad5a5c84ef9b6fa"; // solana-verify build, image 3.1.10, --cargo-build-sbf-args="--tools-version v1.57", 2026-10-06

export default function AdminVerifyPage() {
  return <VerifyRecord programId={VAULT_PROGRAM_ID} programName="vault" ixData={VERIFY_IX_DATA} expectedOnchainHash={EXPECTED_ONCHAIN_HASH} reproducibleBuildHash={REPRODUCIBLE_BUILD_HASH} />;
}
