import PoolUsageClient from "./PoolUsageClient";

// Force dynamic so the standalone build keeps this server-side page file.
export const dynamic = "force-dynamic";

export default function PoolUsagePage() {
  return <PoolUsageClient />;
}
