import { LiveView } from "@/components/LiveView";
import { SAMPLE_PLAN } from "@/lib/sample";

export const metadata = { title: "דוגמה | Pro Algorithm Live" };

/** Static preview of the deck with sample content (no server state, no polling). */
export default async function Demo({ searchParams }: { searchParams: Promise<{ empty?: string }> }) {
  const { empty } = await searchParams;
  return (
    <LiveView
      id="demo"
      initial={{
        status: "ended",
        clientName: empty ? "" : SAMPLE_PLAN.clientName,
        plan: empty ? null : SAMPLE_PLAN,
        version: 1,
        updatedAt: Date.now(),
      }}
    />
  );
}
