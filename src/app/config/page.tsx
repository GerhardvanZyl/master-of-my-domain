import VibesConfig from "@/components/VibesConfig";
import { listProperties } from "@/db/queries/properties";

export const dynamic = "force-dynamic";

export default function ConfigPage() {
  return <VibesConfig properties={listProperties()} />;
}
