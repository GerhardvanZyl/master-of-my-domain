import PropertyGrid from "@/components/PropertyGrid";
import { listProperties } from "@/db/queries/properties";

export const dynamic = "force-dynamic";

export default function Home() {
  // ponytail: root = Melbourne (VIC), /sydney = NSW. Split by state, not a
  // suburb allowlist — add a region param if a third city ever shows up.
  const properties = listProperties().filter((p) => p.state !== "NSW");
  // Header lives inside PropertyGrid — it owns the filtered "shown" count.
  return (
    <section className="rise">
      <PropertyGrid properties={properties} region="vic" />
    </section>
  );
}
