import MapView from "@/components/MapView";
import { listProperties } from "@/db/queries/properties";

export const dynamic = "force-dynamic";

export default function SydneyMapPage() {
  const properties = listProperties().filter((p) => p.state === "NSW");
  return <MapView properties={properties} region="nsw" />;
}
