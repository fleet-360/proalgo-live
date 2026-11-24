import type { Metadata } from "next";
import { LiveView } from "@/components/LiveView";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const meta = await store.getMeta(id);
  const name = meta?.clientName || meta?.plan?.clientName;
  return { title: name ? `תוכנית עבודה – ${name} | Pro Algorithm` : "תוכנית עבודה | Pro Algorithm" };
}

export default async function LivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = await store.getMeta(id);
  if (!meta) {
    return <div className="center-msg">הקישור לא נמצא או שפג תוקפו.</div>;
  }
  return (
    <LiveView
      id={id}
      initial={{
        status: meta.status,
        clientName: meta.clientName,
        plan: meta.plan,
        version: meta.version,
        updatedAt: meta.updatedAt,
      }}
    />
  );
}
