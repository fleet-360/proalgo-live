import { isAuthorized, unauthorized } from "@/lib/auth";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Full session for the salesperson's app: plan, private insights, transcript and notes. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(req)) return unauthorized();
  const { id } = await params;
  const meta = await store.getMeta(id);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });
  const [segments, notes] = await Promise.all([store.getSegments(id), store.getNotes(id)]);
  return Response.json({ meta, segments, notes });
}
