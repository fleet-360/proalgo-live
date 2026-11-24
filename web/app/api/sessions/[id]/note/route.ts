import { isAuthorized, unauthorized } from "@/lib/auth";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/** A correction or focus instruction from the salesperson. Applied on the next update. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(req)) return unauthorized();
  const { id } = await params;
  const meta = await store.getMeta(id);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = (body.text ?? "").trim().slice(0, 2000);
  if (!text) return Response.json({ error: "empty note" }, { status: 400 });
  await store.appendNote(id, { t: Date.now() - meta.createdAt, text });
  return Response.json({ ok: true });
}
