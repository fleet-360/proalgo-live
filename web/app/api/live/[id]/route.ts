import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Public, read-only: only what the client may see (no transcript, no private insights). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = await store.getMeta(id);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(
    {
      status: meta.status,
      clientName: meta.clientName,
      plan: meta.plan,
      version: meta.version,
      updatedAt: meta.updatedAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
