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

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class GeminiError extends Error {
  constructor(public status: number, body: string) {
    super(`Gemini STT ${status}: ${body.slice(0, 300)}`);
  }
}

type InteractionResponse = {
  output_text?: string;
  steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
};

async function geminiCall(key: string, body: object): Promise<string> {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => {
    // Timeouts and network errors count as retryable server errors.
    throw new GeminiError(599, e instanceof Error ? e.message : String(e));
  });
  if (!res.ok) throw new GeminiError(res.status, await res.text());
  const json = (await res.json()) as InteractionResponse;
  if (typeof json.output_text === "string") return json.output_text.trim();
  return (json.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join(" ")
    .trim();
}

const FALLBACK_PROMPT =
  "תמלל את ההקלטה בעברית, מילה במילה, בדיוק כפי שנאמר. החזר רק את התמלול עצמו, בלי הקדמה, בלי סיכום ובלי הסברים. אם אין דיבור בהקלטה, החזר תשובה ריקה.";

/**
 * Gemini's dedicated transcription model (verbatim, Hebrew hint). Its per-minute quota is small,
 * so on 429/5xx we wait once and retry, then fall back to a general Flash-Lite model with a strict prompt.
 */
async function transcribeGemini(audio: Blob, filename: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ext = filename.split(".").pop()?.toLowerCase() || "webm";
  const mime = (audio.type || `audio/${ext}`).split(";")[0].trim();
  const data = Buffer.from(await audio.arrayBuffer()).toString("base64");

  const primary = {
    model: process.env.GEMINI_STT_MODEL || "gemini-3.5-transcribe",
    input: [{ type: "audio", data, mime_type: mime }],
    generation_config: { transcription_config: { language_codes: ["he-IL"] } },
  };
  const fallback = {
    model: process.env.GEMINI_STT_FALLBACK_MODEL || "gemini-3.5-flash-lite",
    input: [
      { type: "text", text: FALLBACK_PROMPT },
      { type: "audio", data, mime_type: mime },
    ],
    generation_config: { thinking_level: "minimal", temperature: 0 },
  };

  const started = Date.now();
  const retryable = (e: unknown) => e instanceof GeminiError && (e.status === 429 || e.status >= 500);
  try {
    return await geminiCall(key, primary);
  } catch (e) {
    if (!retryable(e)) throw e;
  }
  try {
    return await geminiCall(key, fallback);
  } catch (e) {
    if (!retryable(e)) throw e;
  }
  if (Date.now() - started > 30_000) throw new Error("Gemini STT: out of time after retries");
  await sleep(3000);
  return geminiCall(key, primary);
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
const JUNK = [/^תודה( רבה)?[.!]?$/, /^תודה שצפיתם/, /^כתוביות/, /^\.+$/, /^שלום[.!]?$/, /^(אין דיבור|אין תמלול|no speech)/i];

/** Drop sound tags like [מוזיקה] / (צחוק) and collapse a phrase the model repeated in a loop. */
export function cleanTranscript(text: string): string {
  const t = text.replace(/[[(][^\])]{0,30}[\])]/g, " ").replace(/\s+/g, " ").trim();
  // A run of 1-6 words repeated 3+ times in a row becomes a single copy.
  return (t + " ").replace(/((?:\S+ ){1,6}?)\1{2,}/g, "$1").trim();
}

export function isJunk(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  return JUNK.some((re) => re.test(t));
}
