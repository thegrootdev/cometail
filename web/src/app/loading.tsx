import { Shell } from "@/components/Shell";
import { DataState } from "@/components/Experience";
export default function Loading() {
  return (
    <Shell>
      <DataState kind="loading" />
    </Shell>
  );
}
