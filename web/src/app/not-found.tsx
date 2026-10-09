import Link from "next/link";
import { Shell } from "@/components/Shell";
import { DataState } from "@/components/Experience";
import { experience as copy } from "@/content/cometail";
export default function NotFound() {
  return (
    <Shell>
      <DataState title={copy.notFound} body={copy.notFoundBody}>
        <Link className="button button-primary" href="/">
          ← {copy.back}
        </Link>
      </DataState>
    </Shell>
  );
}
