"use client";
// The burn program's build verification record (see VerifyRecord). The instruction bytes were produced by
// the verifier tool from the public repository and are embedded here unchanged.
import { BURN_PROGRAM_ID } from "@cometail/client";
import { VerifyRecord } from "@/components/VerifyRecord";

/** The instruction data the verifier tool exported for this program, repository and commit (hex, unchanged):
 *  library cometail_burn, commit 5895634, base image solanafoundation/solana-verifiable-build:3.1.10,
 *  cargo-build-sbf args --tools-version v1.57, deploy slot 454166757. */
const VERIFY_IX_DATA = "afaf6d1f0d989bed05000000302e352e322700000068747470733a2f2f6769746875622e636f6d2f74686567726f6f746465762f636f6d657461696c2800000035383935363334326138633965363538393265613466636164323730346235373939353938353462050000000e0000002d2d6c6962726172792d6e616d650d000000636f6d657461696c5f6275726e0c0000002d2d626173652d696d6167652f000000736f6c616e61666f756e646174696f6e2f736f6c616e612d76657269666961626c652d6275696c643a332e312e31302e0000002d2d636172676f2d6275696c642d7362662d617267733d222d2d746f6f6c732d76657273696f6e2076312e353722e508121b00000000";
/** The hash of the program bytes on chain when this page was written (trailing zeros stripped), and the hash
 *  of the reproducible build from the same commit in the verifiable-build container. */
const EXPECTED_ONCHAIN_HASH: string = "8ead5d24c5f29374a34a50dfd22948013754bd2c7fcf2db56616294e5321f7d1";
const REPRODUCIBLE_BUILD_HASH: string = "8ead5d24c5f29374a34a50dfd22948013754bd2c7fcf2db56616294e5321f7d1"; // solana-verify build, image 3.1.10, --cargo-build-sbf-args="--tools-version v1.57", clean clone at 5895634, 2026-10-07

export default function AdminVerifyBurnPage() {
  return <VerifyRecord programId={BURN_PROGRAM_ID} programName="burn" ixData={VERIFY_IX_DATA} expectedOnchainHash={EXPECTED_ONCHAIN_HASH} reproducibleBuildHash={REPRODUCIBLE_BUILD_HASH} />;
}
