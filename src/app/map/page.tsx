import MapView from "@/components/MapView";
import { listProperties } from "@/db/queries/properties";

export const dynamic = "force-dynamic";

export default function MapPage() {
  return <MapView properties={listProperties()} />;
}
