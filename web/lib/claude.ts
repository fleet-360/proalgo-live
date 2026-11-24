import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AnalysisSchema, normalizePlan, type Analysis, type Note, type Plan, type Segment } from "./schema";

const client = new Anthropic({ timeout: 240_000, maxRetries: 1 });

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
- אסור לכתוב מחירים, שעות, ימים, בנק שעות או עלויות פיתוח. מספרים מותרים רק כשהם מתארים את המצב של הלקוח (למשל "יומיים למידול דלפק").
- השתמש במילים של הלקוח: שמות מערכות, מוצרים ותהליכים כפי שנאמרו.
- שלב 1 הוא בדרך כלל תשתית וחיבור למערכות, שלב 5 הוא בדיקות, הטמעה והדרכה. שלבים 2-4 הם הליבה, מהערך הכי גבוה לפחות.
- כל עדכון ממשיך את הגרסה הקודמת. שנה רק מה שהשיחה החדשה מצדיקה, כדי שהמצגת לא "תקפוץ" מול הלקוח.
- הערות של איש המכירות גוברות על כל השאר: אם הוא כתב שמשהו לא נכון או שצריך להתמקד במשהו, תקן בהתאם.
- כל גרסה, כבר מהראשונה, ממלאת את כל המצגת: 5 שלבים מלאים, שמות 3 החלקים, "מה נדרש מכם", שורת ההיקף ונקודת הבקרה. אסור להשאיר שדה או מערך ריק.
- בתחילת השיחה, כשעוד אין מספיק מידע, כתוב השערה סבירה שמבוססת על מה שכן נאמר. אל תמציא פרטים שלא נאמרו; עדיף ניסוח כללי.
- העדיפות הראשונה היא תוכנית עבודה טובה וזורמת. אל תעמיס על איש המכירות: הוא באמצע שיחה ומציץ בפאנל לשנייה.
- insights קצר וממוקד: עד 3 שאלות עסקיות שישפרו את התוכנית באמת (היקפים, כסף, זמן, מה הכי כואב), נקודה אחת או שתיים ב-roi, ובכל היותר 2 סיכונים עסקיים אמיתיים. אם אין מה להוסיף, השאר ריק.
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

/** Merge consecutive lines by the same speaker and render as text lines. */
export function formatTranscript(segs: Segment[]): string[] {
  const lines: string[] = [];
  let cur: { t: number; speaker: string; text: string } | null = null;
  for (const s of [...segs].sort((a, b) => a.t - b.t)) {
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
}): Promise<Analysis> {
  const lines = formatTranscript(input.segments);

  // Transcript goes first in stable chunks so earlier chunks stay cache hits as the call grows.
  const CHUNK = 40;
  const transcriptBlocks: Anthropic.Beta.BetaTextBlockParam[] = [];
  for (let i = 0; i < lines.length; i += CHUNK) {
    transcriptBlocks.push({ type: "text", text: lines.slice(i, i + CHUNK).join("\n") });
  }
  if (!transcriptBlocks.length) transcriptBlocks.push({ type: "text", text: "(השיחה רק התחילה, אין עדיין תמלול)" });
  transcriptBlocks[0] = { ...transcriptBlocks[0], text: "<transcript>\n" + transcriptBlocks[0].text };
  const last = transcriptBlocks.length - 1;
  transcriptBlocks[last] = {
    ...transcriptBlocks[last],
    text: transcriptBlocks[last].text + "\n</transcript>",
    cache_control: { type: "ephemeral" },
  };

  const notes = input.notes.map((n) => `[${mmss(n.t)}] ${n.text}`).join("\n");
  const tail = [
    input.clientName ? `<client_name>${input.clientName}</client_name>` : "",
    `<previous_plan>\n${input.previous ? JSON.stringify(input.previous) : "אין עדיין, זו הגרסה הראשונה"}\n</previous_plan>`,
    notes ? `<salesperson_notes>\n${notes}\n</salesperson_notes>` : "",
    input.final
      ? "השיחה הסתיימה. כתוב את הגרסה הסופית והמלאה של התוכנית, כבסיס לאפיון."
      : "עדכן את התוכנית לפי מה שנאמר עד עכשיו. מלא את כל שדות התוכנית, כולל 5 השלבים.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: betaZodOutputFormat(AnalysisSchema) },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [...transcriptBlocks, { type: "text", text: tail }] }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined (${response.stop_details?.category ?? "unknown"})`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("Claude output was cut off (max_tokens)");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Claude returned output that did not match the schema");
  return { plan: normalizePlan(parsed.plan), insights: parsed.insights };
}
