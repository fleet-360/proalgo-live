import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  AnalysisSchema,
  CompletionSchema,
  hasBusinessContent,
  normalizePlan,
  sanitizePlan,
  type Analysis,
  type Note,
  type Plan,
  type Segment,
} from "./schema";

// Retries are handled here against the route's deadline, so the SDK must not retry on its own.
const client = new Anthropic({ maxRetries: 0 });

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.CLAUDE_EFFORT || "medium") as "low" | "medium" | "high";

// Frozen system prompt (cached). Do not put anything per-session in here.
const SYSTEM = `אתה יועץ פיתוח בכיר בחברת Pro Algorithm, שמפתחת אוטומציות, תוספים ומערכות AI לעסקים.
אתה מאזין בזמן אמת לשיחה בין איש המכירות שלנו ללקוח, ובונה תוך כדי את "תוכנית העבודה": מצגת של 6 עמודים שאיש המכירות מציג ללקוח באמצע השיחה, כדי לומר "זה מה שהבנו ממך, בוא נדייק ביחד".

המטרה העסקית שלך:
- לזהות איזה פיתוח באמת כלכלי ללקוח: איפה הולכים הכי הרבה זמן, כסף או טעויות, ומה יחזיר את ההשקעה הכי מהר.
- למקד את התוכנית במה שנכון ללקוח, לא בכל מה שהוא ביקש. אם משהו שנאמר לא כלכלי, אל תכניס אותו לתוכנית; כתוב אותו בסיכונים.
- התוכנית היא הבסיס לאפיון. המתכנת שיגיע לשטח צריך להבין ממנה בדיוק מה הבעיה, מה בונים ובאיזה סדר.

מבנה המצגת (אל תשנה אותו):
1. שער (קבוע).
2. "פרטי ההצעה ובקשת הלקוח": "התהליך היום" (משפט פתיחה + 3-4 כאבים) ו"הפתרון" (כותרת, משפט פתיחה, 4-5 יכולות ותוצאה).
3-5. "שלבי עבודה בפרויקט": 5 שלבים, שניים בכל עמוד ושלב 5 בעמוד האחרון יחד עם "מה נדרש מכם". כל שלב: כותרת, משפט פתיחה, 3 נקודות ומטרה מדידה. לכל עמוד יש שם חלק (חלק א׳, ב׳, ג׳).
6. "היקף ההצעה": חמשת השלבים בקצרה ונקודת בקרה.

כללים:
- עברית עסקית, חדה וקצרה. הטקסט נכנס לכרטיסים קטנים: נקודה עד 7 מילים, משפט פתיחה עד 10 מילים.
- אסור לכתוב מחירים, שעות, ימים, בנק שעות, עלויות פיתוח, תקציב, לוחות זמנים או משכי פרויקט (שבועות, חודשים, תאריכי מסירה). מספרים מותרים רק כשהם מתארים את המצב של הלקוח (למשל "יומיים למידול דלפק").
- השתמש במילים של הלקוח: שמות מערכות, מוצרים ותהליכים כפי שנאמרו.
- שלב 1 הוא בדרך כלל תשתית וחיבור למערכות, שלב 5 הוא בדיקות, הטמעה והדרכה. שלבים 2-4 הם הליבה, מהערך הכי גבוה לפחות.
- כל עדכון ממשיך את הגרסה הקודמת. שנה רק מה שהשיחה החדשה מצדיקה, כדי שהמצגת לא "תקפוץ" מול הלקוח. שדה שאין סיבה חדשה לשנות: העתק אותו מילה במילה מ-previous_plan, כולל סדר הנקודות.
- תוויות הדוברים בתמלול אוטומטיות ועלולות להתבלבל. אם אותו תוכן מופיע פעמיים בהפרש קצר, זה הלקוח שנקלט גם במיקרופון. קבע מי אמר מה לפי התוכן.
- אל תציע ב-questions שאלה שכבר נענתה בשיחה.
- הערות של איש המכירות גוברות על כל השאר: אם הוא כתב שמשהו לא נכון או שצריך להתמקד במשהו, תקן בהתאם.
- התוכנית תמיד מלאה: 5 שלבים מלאים, שמות 3 החלקים, "מה נדרש מכם", שורת ההיקף ונקודת הבקרה. כשחסר מידע, השלם השערה מקצועית סבירה לפי סוג העסק והבעיה; זה בדיוק מה שאיש המכירות רוצה להראות ללקוח כדי לדייק איתו.
- רק אם בתמלול אין עדיין אף משפט על העסק של הלקוח, על התהליך שלו או על בעיה (רק ברכות ושיחת חולין), החזר את שדות התוכנית ריקים. ברגע שנאמר משפט אחד על העסק, בנה תוכנית מלאה כהשערה.
- בתחילת השיחה, כשעוד אין מספיק מידע, כתוב השערה סבירה שמבוססת על מה שכן נאמר. אל תמציא עובדות ספציפיות (שמות מערכות, מספרים) שלא נאמרו; עדיף ניסוח כללי.
- העדיפות הראשונה היא תוכנית עבודה טובה וזורמת. אל תעמיס על איש המכירות: הוא באמצע שיחה ומציץ בפאנל לשנייה.
- insights קצר וממוקד: עד 3 שאלות עסקיות שישפרו את התוכנית באמת (היקפים, כסף, זמן, מה הכי כואב), נקודה אחת או שתיים ב-roi, ובכל היותר 2 סיכונים עסקיים אמיתיים.
- התמלול אוטומטי ויכול להכיל טעויות שמיעה. תקן אותן בשקט לפי ההקשר. לעולם אל תזכיר טעויות תמלול, לא בתוכנית ולא ב-insights, ואל תשאל עליהן.
- "insights" מיועד רק לאיש המכירות ולא מוצג ללקוח: כתוב שם בכנות מה ה-ROI, מה חסר ומה מסוכן.

דוגמה לרמת הכתיבה (מפרויקט קודם, מפעל ייצור):
התהליך היום: "היום, כל פריט נבנה ומופק ידנית בסולידוורקס:" • מידול דלפק אחד מסקיצה לוקח יום עד יומיים • כל ארון, גם פתוח, הוא לפחות שנים־עשר חלקים • חלקים דומים מחפשים בפרויקטים ישנים, בלי ספרייה
הפתרון: "מהמידה לקובץ חיתוך בלחיצה" / "תוסף בתוך הסולידוורקס של המפעל, שעובד לפי המוסכמות שלכם:" • ספרייה חכמה של כל הפריטים מפרויקטים קודמים • שינוי מידות בפקודה: ארונית מטר, כיור באמצע • הפקה בלחיצה: פרישות, קבצי חיתוך, שרטוטים / תוצאה: "פריט מותאם מוכן לחיתוך בדקות במקום שעות"
שלב: "ספריית פריטים חכמה" / "במקום לחפש בפרויקטים ישנים:" • סריקת כל הפרויקטים בשרת • חיפוש לפי קוד, סוג ומידות • משיכה לפרויקט חדש עם שמות נכונים / מטרה: "פריט דומה נמצא בפחות מדקה"
מה נדרש: "כדי להתחיל מיד אנחנו צריכים:" • גישה לתיקיית הפרויקטים בשרת • פרויקט מלא נוסף מקצה לקצה • איש קשר לאישורים`;

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const words = (s: string) =>
  new Set(
    s
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );

/**
 * Without headphones the mic also picks up the client from the speakers, so the same words arrive
 * on both channels. Drop a "sales" segment that mostly repeats a nearby "client" segment.
 */
export function dropEchoes(segs: Segment[]): Segment[] {
  const clients = segs.filter((s) => s.speaker === "client").map((s) => ({ t: s.t, w: words(s.text) }));
  return segs.filter((s) => {
    if (s.speaker !== "sales") return true;
    const w = words(s.text);
    if (w.size < 3) return true;
    return !clients.some((c) => {
      if (Math.abs(c.t - s.t) > 25_000) return false;
      let shared = 0;
      for (const x of w) if (c.w.has(x)) shared++;
      return shared / w.size >= 0.6;
    });
  });
}

/** Merge consecutive lines by the same speaker and render as text lines. */
export function formatTranscript(segs: Segment[]): string[] {
  const lines: string[] = [];
  let cur: { t: number; speaker: string; text: string } | null = null;
  for (const s of dropEchoes([...segs].sort((a, b) => a.t - b.t))) {
    if (cur && cur.speaker === s.speaker && s.t - cur.t < 60_000) {
      cur.text += " " + s.text;
    } else {
      if (cur) lines.push(`[${mmss(cur.t)}] ${cur.speaker === "sales" ? "איש המכירות" : "לקוח"}: ${cur.text}`);
      cur = { t: s.t, speaker: s.speaker, text: s.text };
    }
  }
  if (cur) lines.push(`[${mmss(cur.t)}] ${cur.speaker === "sales" ? "איש המכירות" : "לקוח"}: ${cur.text}`);
  return lines;
}

export async function analyze(input: {
  segments: Segment[];
  notes: Note[];
  previous: Plan | null;
  clientName: string;
  final: boolean;
  /** Epoch ms by which we must have returned (the route's function limit minus a margin). */
  deadline: number;
}): Promise<Analysis> {
  const lines = formatTranscript(input.segments);

  // Transcript goes first in fixed 40-line chunks. A cache breakpoint on the last *full* chunk is written
  // once and then read by every later update; the breakpoint on the growing tail chunk is a bonus.
  const CHUNK = 40;
  const transcriptBlocks: Anthropic.Beta.BetaTextBlockParam[] = [];
  for (let i = 0; i < lines.length; i += CHUNK) {
    transcriptBlocks.push({ type: "text", text: lines.slice(i, i + CHUNK).join("\n") });
  }
  if (!transcriptBlocks.length) transcriptBlocks.push({ type: "text", text: "(השיחה רק התחילה, אין עדיין תמלול)" });
  transcriptBlocks[0] = { ...transcriptBlocks[0], text: "<transcript>\n" + transcriptBlocks[0].text };
  const fullChunks = Math.floor(lines.length / CHUNK);
  const lastFull = fullChunks - 1;
  const last = transcriptBlocks.length - 1;
  if (lastFull >= 0 && lastFull !== last) {
    transcriptBlocks[lastFull] = { ...transcriptBlocks[lastFull], cache_control: { type: "ephemeral" } };
  }
  transcriptBlocks[last] = { ...transcriptBlocks[last], cache_control: { type: "ephemeral" } };

  const notes = input.notes.map((n) => `[${mmss(n.t)}] ${n.text}`).join("\n");
  const tail = [
    "</transcript>",
    input.clientName ? `<client_name>${input.clientName}</client_name>` : "",
    `<previous_plan>\n${input.previous ? JSON.stringify(input.previous) : "אין עדיין, זו הגרסה הראשונה"}\n</previous_plan>`,
    notes ? `<salesperson_notes>\n${notes}\n</salesperson_notes>` : "",
    input.final
      ? "השיחה הסתיימה. כתוב את הגרסה הסופית והמלאה של התוכנית, כבסיס לאפיון."
      : "עדכן את התוכנית לפי מה שנאמר עד עכשיו.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const remaining = () => input.deadline - Date.now();

  const call = async (instruction: string): Promise<Analysis> => {
    const timeout = Math.min(240_000, remaining() - 5_000);
    if (timeout < 20_000) throw new Error("Not enough time left for another Claude call");
    const response = await client.beta.messages.parse(
      {
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: EFFORT, format: betaZodOutputFormat(AnalysisSchema) },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [...transcriptBlocks, { type: "text", text: instruction }] }],
      },
      { timeout },
    );
    const u = response.usage;
    console.log(
      `analyze: model=${response.model} stop=${response.stop_reason} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`,
    );
    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined (${response.stop_details?.category ?? "unknown"})`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("Claude output was cut off (max_tokens)");
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("Claude returned output that did not match the schema");
    const { plan, removed } = sanitizePlan(normalizePlan(parsed.plan), input.previous);
    if (removed.length) console.warn("analyze: removed price/time text from the deck:", removed);
    const ins = parsed.insights;
    return {
      plan,
      insights: {
        roi: ins.roi.slice(0, 2),
        questions: ins.questions.slice(0, 3),
        risks: ins.risks.slice(0, 2),
        confidence: ins.confidence,
      },
    };
  };

  // One retry on a transient API failure, if there is still time for it.
  let result: Analysis;
  try {
    result = await call(tail);
  } catch (e) {
    if (e instanceof Anthropic.APIError && e.status !== undefined && e.status < 500 && e.status !== 429) throw e;
    if (remaining() < 100_000) throw e;
    console.warn("analyze: first call failed, retrying:", e instanceof Error ? e.message : e);
    result = await call(tail);
  }

  // Early in a call the model sometimes writes the first page and leaves the rest of the deck empty.
  // A half-empty deck looks broken to the client, so a focused second call builds just the missing part.
  if (hasBusinessContent(result.plan) && !stagesComplete(result.plan) && remaining() > 90_000) {
    console.warn("analyze: stages incomplete, completing them");
    try {
      const timeout = Math.min(120_000, remaining() - 5_000);
      const response = await client.beta.messages.parse(
        {
          model: MODEL,
          max_tokens: 8000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: EFFORT, format: betaZodOutputFormat(CompletionSchema) },
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: [
                ...transcriptBlocks,
                {
                  type: "text",
                  text: [
                    "</transcript>",
                    `<plan_so_far>\n${JSON.stringify({ currentProcess: result.plan.currentProcess, solution: result.plan.solution })}\n</plan_so_far>`,
                    "העמוד הראשון של המצגת כבר כתוב (plan_so_far). המשימה שלך עכשיו: לבנות את שאר המצגת שמממשת את הפתרון הזה – 5 שלבי עבודה מלאים (שלב 1 תשתית וחיבור, שלבים 2-4 הליבה מהערך הגבוה לנמוך, שלב 5 בדיקות הטמעה והדרכה), שמות 3 החלקים, מה נדרש מהלקוח, שורת היקף ונקודת בקרה. כשחסר מידע, כתוב השערה מקצועית סבירה. בנוסף: 2-3 שאלות שכדאי לאיש המכירות לשאול עכשיו ונקודת ROI אחת.",
                  ].join("\n\n"),
                },
              ],
            },
          ],
        },
        { timeout },
      );
      console.log(`analyze: completion out=${response.usage.output_tokens} stop=${response.stop_reason}`);
      const c = response.parsed_output;
      if (c) {
        const merged = normalizePlan({ ...result.plan, ...c, stages: c.stages, parts: c.parts });
        const { plan } = sanitizePlan(merged, input.previous);
        if (stagesComplete(plan)) {
          result = {
            plan,
            insights: {
              ...result.insights,
              questions: result.insights.questions.length ? result.insights.questions : c.questions.slice(0, 3),
              roi: result.insights.roi.length ? result.insights.roi : c.roi.slice(0, 2),
            },
          };
        }
      }
    } catch (e) {
      console.warn("analyze: completion failed:", e instanceof Error ? e.message : e);
    }
  }
  // Last resort: carry over stages from the previous version rather than blanking them in front of the client.
  const prev = input.previous;
  if (prev && !stagesComplete(result.plan) && stagesComplete(prev)) {
    result.plan = {
      ...result.plan,
      parts: result.plan.parts.map((p, i) => p || prev.parts[i]),
      stages: result.plan.stages.map((s, i) => (s.title ? s : prev.stages[i])),
      requirements: result.plan.requirements.bullets.length ? result.plan.requirements : prev.requirements,
      scopeSubtitle: result.plan.scopeSubtitle || prev.scopeSubtitle,
      checkpoint: result.plan.checkpoint || prev.checkpoint,
    };
  }
  return result;
}

function stagesComplete(p: Plan): boolean {
  return p.stages.length === 5 && p.stages.every((s) => s.title.trim() && s.bullets.length > 0);
}
