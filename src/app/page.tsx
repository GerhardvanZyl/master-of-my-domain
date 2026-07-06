import PropertyGrid from "@/components/PropertyGrid";
import SearchHistory from "@/components/SearchHistory";
import { listProperties } from "@/db/queries/properties";
import { listSearchHistory } from "@/db/queries/jobs";

export const dynamic = "force-dynamic";

export default function Home() {
  const properties = listProperties();
  const history = listSearchHistory();
  return (
    <div className="space-y-6">
      <SearchHistory jobs={history} />
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">
          Tracked properties ({properties.length})
        </h1>
      </div>
      <PropertyGrid properties={properties} />
    </div>
  );
}
