import { isAuthorized, unauthorized } from "@/lib/auth";
import { analyze } from "@/lib/claude";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Re-run Claude over the transcript and update the plan.
 * Body: { final?: boolean, force?: boolean }. final=true also ends the session.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(req)) return unauthorized();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { final?: boolean; force?: boolean };
  const final = !!body.final;

  const meta = await store.getMeta(id);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  const [segments, notes] = await Promise.all([store.getSegments(id), store.getNotes(id)]);
  const nothingNew = segments.length === meta.analyzedSegments && notes.length === meta.analyzedNotes;
  if (nothingNew && !final && !body.force) {
    return Response.json({ skipped: true, version: meta.version, insights: meta.insights });
  }
  if (!segments.length && !notes.length) {
    if (final) {
      meta.status = "ended";
      meta.updatedAt = Date.now();
      await store.saveMeta(meta);
    }
    return Response.json({ skipped: true, reason: "no transcript yet", version: meta.version });
  }

  if (!(await store.tryLock(id, 290))) {
    return Response.json({ busy: true, version: meta.version }, { status: 409 });
  }
  try {
    const result = await analyze({
      segments,
      notes,
      previous: meta.plan,
      clientName: meta.clientName,
      final,
    });
    // Re-read: other fields may have changed while Claude was thinking.
    const fresh = (await store.getMeta(id)) ?? meta;
    fresh.plan = result.plan;
    fresh.insights = result.insights;
    if (!fresh.clientName && result.plan.clientName) fresh.clientName = result.plan.clientName;
    fresh.version += 1;
    fresh.analyzedSegments = segments.length;
    fresh.analyzedNotes = notes.length;
    fresh.lastError = null;
    fresh.updatedAt = Date.now();
    if (final) fresh.status = "ended";
    await store.saveMeta(fresh);
    return Response.json({ version: fresh.version, plan: fresh.plan, insights: fresh.insights });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("analyze failed", message);
    const fresh = (await store.getMeta(id)) ?? meta;
    fresh.lastError = message;
    if (final) fresh.status = "ended";
    await store.saveMeta(fresh);
    return Response.json({ error: message }, { status: 502 });
  } finally {
    await store.unlock(id);
  }
}
