import AddLinksForm from "@/components/AddLinksForm";
import JobStatus from "@/components/JobStatus";
import PropertyGrid from "@/components/PropertyGrid";
import { listProperties } from "@/db/queries/properties";

export const dynamic = "force-dynamic";

export default function Home() {
  const properties = listProperties();
  return (
    <div className="space-y-6">
      <AddLinksForm />
      <JobStatus />
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">
          Tracked properties ({properties.length})
        </h1>
      </div>
      <PropertyGrid properties={properties} />
    </div>
  );
}
