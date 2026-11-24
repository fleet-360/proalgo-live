import { isAuthorized, unauthorized } from "@/lib/auth";
import { analyze } from "@/lib/claude";
import { hasBusinessContent, samePlan } from "@/lib/schema";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Below this much transcript (and no notes) there is nothing to build a plan from yet. */
const MIN_CHARS = 250;

/**
 * Re-run Claude over the transcript and update the plan.
 * Body: { final?: boolean, force?: boolean }. final=true also ends the session.
 * Responses: { version, plan, insights, changed } | { skipped } | { busy } (409) | { error } (502).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deadline = Date.now() + (maxDuration - 15) * 1000;
  if (!isAuthorized(req)) return unauthorized();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { final?: boolean; force?: boolean };
  const final = !!body.final;

  const meta = await store.getMeta(id);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  const [segments, notes] = await Promise.all([store.getSegments(id), store.getNotes(id)]);
  const nothingNew = segments.length === meta.analyzedSegments && notes.length === meta.analyzedNotes;
  if (nothingNew && !final && !body.force) {
    return Response.json({ skipped: true, version: meta.version, plan: meta.plan, insights: meta.insights });
  }

  const chars = segments.reduce((n, s) => n + s.text.length, 0);
  if (!meta.plan && !notes.length && chars < MIN_CHARS) {
    if (final) {
      meta.status = "ended";
      meta.updatedAt = Date.now();
      await store.saveMeta(meta);
    }
    return Response.json({ skipped: true, reason: "too little transcript", version: meta.version, plan: meta.plan });
  }

  const lock = await store.tryLock(id, maxDuration + 5);
  if (!lock) {
    // The app keeps retrying for a full final pass; the flag only matters if it never comes back (app closed).
    if (final) await store.setFinalRequested(id);
    return Response.json({ busy: true, version: meta.version }, { status: 409 });
  }
  try {
    const result = await analyze({ segments, notes, previous: meta.plan, clientName: meta.clientName, final, deadline });
    // Re-read: other fields may have changed while Claude was thinking.
    const fresh = (await store.getMeta(id)) ?? meta;
    const showPlan = hasBusinessContent(result.plan) || !!fresh.plan;
    const changed = showPlan && !samePlan(result.plan, fresh.plan);
    if (changed) {
      fresh.plan = result.plan;
      fresh.version += 1;
    }
    fresh.insights = result.insights;
    if (!fresh.clientName && result.plan.clientName) fresh.clientName = result.plan.clientName;
    fresh.analyzedSegments = segments.length;
    fresh.analyzedNotes = notes.length;
    fresh.lastError = null;
    fresh.updatedAt = Date.now();
    if (final) fresh.status = "ended";
    await store.saveMeta(fresh);
    return Response.json({ version: fresh.version, plan: fresh.plan, insights: fresh.insights, changed, final });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("analyze failed", message);
    const fresh = (await store.getMeta(id)) ?? meta;
    fresh.lastError = message;
    if (final) fresh.status = "ended";
    await store.saveMeta(fresh);
    return Response.json({ error: message }, { status: 502 });
  } finally {
    await store.unlock(id, lock);
  }
}
