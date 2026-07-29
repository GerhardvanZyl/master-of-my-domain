import PropertyGrid from "@/components/PropertyGrid";
import { listProperties } from "@/db/queries/properties";

export const dynamic = "force-dynamic";

export default function Sydney() {
  const properties = listProperties().filter((p) => p.state === "NSW");
  return (
    <section className="rise">
      <PropertyGrid properties={properties} region="nsw" />
    </section>
  );
}
