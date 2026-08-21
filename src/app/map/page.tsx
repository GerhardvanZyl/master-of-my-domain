import MapView from "@/components/MapView";
import { listProperties } from "@/db/queries/properties";

export const dynamic = "force-dynamic";

export default function MapPage() {
  // ponytail: mirrors src/app/page.tsx — root map = Melbourne (VIC), NSW gets
  // its own route at /sydney/map. Split by state, not a suburb allowlist.
  const properties = listProperties().filter((p) => p.state !== "NSW");
  return <MapView properties={properties} region="vic" />;
}
