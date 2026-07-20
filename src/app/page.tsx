import PropertyGrid from "@/components/PropertyGrid";
import { listProperties } from "@/db/queries/properties";

export const dynamic = "force-dynamic";

export default function Home() {
  const properties = listProperties();
  // Header lives inside PropertyGrid — it owns the filtered "shown" count.
  return (
    <section className="rise">
      <PropertyGrid properties={properties} />
    </section>
  );
}
