import type { SkyStream } from "@/lib/api";
import { identity as copy } from "@/content/cometail";
export function SourceStatus({
  stream,
}: {
  stream?: Pick<
    SkyStream,
    "custody" | "eligible" | "vault" | "progress"
  > & Partial<Pick<SkyStream, "kind" | "ownerRole">> | null;
}) {
  const label = !stream
    ? copy.unchecked
    : stream.kind === "position" && stream.ownerRole === "treasury"
      ? copy.treasuryHeld
      : stream.kind === "position" && (stream.ownerRole === "vault" || stream.vault)
        ? copy.vaultHeld
      : stream.vault
      ? copy.inVault
      : stream.custody === "program"
        ? copy.programHeld
        : stream.custody !== "wallet"
          ? copy.unknownOwner
          : stream.eligible
            ? copy.sellable
            : stream.progress === 1 || stream.progress === 2
              ? copy.migrating
              : copy.notSellable;
  return (
    <span
      className={`source-availability ${stream?.eligible && stream.custody === "wallet" && !stream.vault ? "source-sellable" : ""}`}
    >
      {label}
    </span>
  );
}
