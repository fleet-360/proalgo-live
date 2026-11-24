import { isAuthorized, unauthorized } from "@/lib/auth";
import { store } from "@/lib/store";
import { cleanTranscript, isJunk, transcribe } from "@/lib/stt";
import type { Speaker } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One audio chunk from the desktop app (multipart: file, speaker, t).
 * speaker = "sales" (microphone) or "client" (computer sound).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(req)) return unauthorized();
  const { id } = await params;
  const meta = await store.getMeta(id);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size < 1000) return Response.json({ text: "" });
  const speaker: Speaker = form.get("speaker") === "client" ? "client" : "sales";
  const t = Number(form.get("t") ?? 0) || 0;

  // Last few lines give the STT model context for names and terms (only OpenAI uses it).
  const usesContext = (process.env.STT_PROVIDER || "openai").toLowerCase() === "openai";
  const recent = usesContext ? (await store.getSegments(id)).slice(-6).map((s) => s.text).join(" ") : "";

  try {
    const text = cleanTranscript(
      await transcribe(file, file instanceof File && file.name ? file.name : "chunk.webm", recent),
    );
    if (!text || isJunk(text)) return Response.json({ text: "" });
    await store.appendSegments(id, [{ t, speaker, text }]);
    return Response.json({ text, speaker, t });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("transcribe failed", message);
    return Response.json({ error: message }, { status: 502 });
  }
}
