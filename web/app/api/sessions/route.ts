import { randomBytes } from "node:crypto";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { store } from "@/lib/store";
import type { SessionMeta } from "@/lib/schema";

export const dynamic = "force-dynamic";

function publicOrigin(req: Request) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

/** Start a new live session. Returns the public link to share with the client. */
export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as { clientName?: string };
  const id = randomBytes(9).toString("base64url"); // unguessable public id
  const now = Date.now();
  const meta: SessionMeta = {
    id,
    createdAt: now,
    updatedAt: now,
    status: "live",
    clientName: (body.clientName ?? "").trim().slice(0, 120),
    plan: null,
    insights: null,
    version: 0,
    analyzedSegments: 0,
    analyzedNotes: 0,
    lastError: null,
  };
  await store.saveMeta(meta);
  return Response.json({ id, publicUrl: `${publicOrigin(req)}/live/${id}` });
}
