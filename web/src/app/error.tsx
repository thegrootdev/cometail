"use client";
import { Shell } from "@/components/Shell";
import { DataState } from "@/components/Experience";
import { experience as copy } from "@/content/cometail";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <Shell>
      <div className="route-error">
        <DataState
          kind="error"
          title={copy.pageError}
          body={copy.pageErrorBody}
          onRetry={reset}
        />
      </div>
    </Shell>
  );
}
