/**
 * Hebrew speech-to-text for short audio chunks (~15s webm/opus).
 * Provider is chosen by STT_PROVIDER: "openai" (default), "elevenlabs" or "gemini".
 */
export async function transcribe(audio: Blob, filename: string, contextHint: string): Promise<string> {
  const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  if (provider === "elevenlabs") return transcribeElevenLabs(audio, filename);
  if (provider === "gemini") return transcribeGemini(audio, filename);
  return transcribeOpenAI(audio, filename, contextHint);
}

/** Gemini's dedicated transcription model via the Interactions API (verbatim mode, Hebrew hint). */
async function transcribeGemini(audio: Blob, filename: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ext = filename.split(".").pop()?.toLowerCase() || "webm";
  const mime = (audio.type || `audio/${ext}`).split(";")[0].trim();
  const data = Buffer.from(await audio.arrayBuffer()).toString("base64");
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.GEMINI_STT_MODEL || "gemini-3.5-transcribe",
      input: [{ type: "audio", data, mime_type: mime }],
      generation_config: { transcription_config: { language_codes: ["he-IL"] } },
    }),
  });
  if (!res.ok) throw new Error(`Gemini STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    output_text?: string;
    steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
  };
  if (typeof json.output_text === "string") return json.output_text.trim();
  const text = (json.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join(" ");
  return text.trim();
}

async function transcribeOpenAI(audio: Blob, filename: string, contextHint: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", process.env.OPENAI_STT_MODEL || "gpt-4o-transcribe");
  form.append("language", "he");
  form.append("response_format", "json");
  // The tail of the transcript so far helps the model keep names and terms consistent.
  if (contextHint) form.append("prompt", contextHint.slice(-600));
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

async function transcribeElevenLabs(audio: Blob, filename: string): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v1");
  form.append("language_code", "heb");
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

/** Typical STT hallucinations on near-silent audio. */
const JUNK = [/^תודה( רבה)?[.!]?$/, /^תודה שצפיתם/, /^כתוביות/, /^\.+$/, /^שלום[.!]?$/];

export function isJunk(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  return JUNK.some((re) => re.test(t));
}
