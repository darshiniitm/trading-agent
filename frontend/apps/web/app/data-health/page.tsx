import { DataHealthView } from "@/components/DataHealth";
import { getDataHealth } from "@/server/engine/client";

export const dynamic = "force-dynamic";

export default async function DataHealthPage() {
  try {
    return <main><DataHealthView health={await getDataHealth()} /></main>;
  } catch (err) {
    return <main><p role="alert">The data-health report is unavailable because the engine could not be reached: {(err as Error).message}</p></main>;
  }
}
