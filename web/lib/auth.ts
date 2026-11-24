import { timingSafeEqual } from "node:crypto";

/** Desktop app requests carry the shared APP_TOKEN in the x-app-token header. */
export function isAuthorized(req: Request): boolean {
  const expected = process.env.APP_TOKEN;
  if (!expected) {
    // Allow unauthenticated use only for local development.
    return process.env.NODE_ENV !== "production";
  }
  const got = req.headers.get("x-app-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
