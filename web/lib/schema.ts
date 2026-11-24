import { z } from "zod";

/** One work stage (01–05). Shown on slides 3–5 (full) and slide 6 (summary). */
export const StageSchema = z.object({
  title: z.string().describe("כותרת השלב בכרטיס, עד 5 מילים"),
  shortTitle: z.string().describe("כותרת קצרה לעמוד ההיקף, 2-3 מילים"),
  intro: z.string().describe("משפט פתיחה קצר שמסתיים בנקודתיים"),
  bullets: z.array(z.string()).describe("בדיוק 3 נקודות, כל אחת עד 7 מילים"),
  goal: z.string().describe("המטרה המדידה של השלב, בלי המילה 'מטרה:'"),
  summary: z.string().describe("משפט אחד של עד 15 מילים לעמוד ההיקף"),
});

/** The client-facing work plan. Mirrors the 6-page deck. No prices, no hours. */
export const PlanSchema = z.object({
  clientName: z.string().describe("שם הלקוח או החברה, ריק אם לא ידוע"),
  currentProcess: z.object({
    intro: z.string().describe("משפט שמתאר איך זה עובד היום, מסתיים בנקודתיים"),
    bullets: z.array(z.string()).describe("3-4 כאבים מוחשיים, עדיף עם זמן/כסף"),
  }),
  solution: z.object({
    title: z.string().describe("כותרת הפתרון, עד 6 מילים, בלי 'הפתרון:'"),
    intro: z.string().describe("משפט שמתאר את הפתרון, מסתיים בנקודתיים"),
    bullets: z.array(z.string()).describe("4-5 יכולות מרכזיות"),
    result: z.string().describe("התוצאה העסקית במשפט אחד, בלי 'התוצאה:'"),
  }),
  parts: z
    .array(z.string())
    .describe("3 שמות חלקים לעיגולים: חלק א׳ (שלבים 1-2), חלק ב׳ (3-4), חלק ג׳ (5 ומה נדרש). כל אחד עד 5 מילים, בלי 'חלק א׳'"),
  stages: z.array(StageSchema).describe("בדיוק 5 שלבים"),
  requirements: z.object({
    intro: z.string().describe("משפט פתיחה, למשל 'כדי להתחיל מיד אנחנו צריכים:'"),
    bullets: z.array(z.string()).describe("3-4 דברים שנדרשים מהלקוח"),
  }),
  scopeSubtitle: z.string().describe("שורת סיכום להיקף ההצעה, עד 14 מילים, בלי שעות ובלי מחירים"),
  checkpoint: z.string().describe("נקודת הבקרה בלבד, עד 4 מילים, למשל 'אחרי שלב 02'. בלי הסבר ובלי שעות"),
});

/** Private notes for the salesperson only. Never shown on the public page. */
export const InsightsSchema = z.object({
  roi: z.array(z.string()).describe("1-2 משפטים קצרים: איפה ה-ROI הכי גבוה"),
  questions: z.array(z.string()).describe("עד 3 שאלות עסקיות קצרות שכדאי לשאול עכשיו. אף פעם לא על טעויות תמלול"),
  risks: z.array(z.string()).describe("עד 2 סיכונים עסקיים, למשל משהו שהלקוח ביקש ולא כדאי לפתח. ריק אם אין"),
  confidence: z.enum(["low", "medium", "high"]).describe("כמה התוכנית מבוססת על מה שנאמר בשיחה"),
});

export const AnalysisSchema = z.object({
  plan: PlanSchema,
  insights: InsightsSchema,
});

export type Stage = z.infer<typeof StageSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Insights = z.infer<typeof InsightsSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;

export type Speaker = "sales" | "client";

export interface Segment {
  t: number; // ms since session start
  speaker: Speaker;
  text: string;
}

export interface Note {
  t: number;
  text: string;
}

export interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: "live" | "ended";
  clientName: string;
  plan: Plan | null;
  insights: Insights | null;
  version: number;
  analyzedSegments: number; // how many segments the current plan is based on
  analyzedNotes: number;
  lastError: string | null;
  finalRequested?: boolean; // "end call" arrived while another update held the lock
}

/** A session nobody ended (app crashed, laptop closed) stops claiming to be live after a few quiet hours. */
const STALE_MS = 3 * 60 * 60 * 1000;
export function effectiveStatus(meta: SessionMeta, now = Date.now()): "live" | "ended" {
  if (meta.status === "ended") return "ended";
  return now - meta.updatedAt > STALE_MS ? "ended" : "live";
}

const EMPTY_STAGE: Stage = { title: "", shortTitle: "", intro: "", bullets: [], goal: "", summary: "" };

const clean = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();
const bullet = (s: string) => clean(s).replace(/^[\s•\-–*·]+/, "").trim();
const unlabel = (s: string, re: RegExp) => clean(s).replace(re, "").trim();
const bulletList = (xs: string[], max: number) => xs.map(bullet).filter(Boolean).slice(0, max);

/**
 * Force the exact shape the slides expect: 5 stages, 3 parts, capped list lengths,
 * and strip labels the slides already print ("מטרה:", "התוצאה:", "חלק א׳", bullet marks).
 */
export function normalizePlan(p: Plan): Plan {
  const stages = [...p.stages.slice(0, 5)];
  while (stages.length < 5) stages.push({ ...EMPTY_STAGE });
  const parts = [...p.parts.slice(0, 3)].map((x) => unlabel(x, /^חלק\s*[א-ג][׳'"]?\s*[:–-]?\s*/));
  while (parts.length < 3) parts.push("");
  return {
    clientName: clean(p.clientName),
    currentProcess: { intro: clean(p.currentProcess.intro), bullets: bulletList(p.currentProcess.bullets, 4) },
    solution: {
      title: unlabel(p.solution.title, /^הפתרון\s*[:–-]\s*/),
      intro: clean(p.solution.intro),
      bullets: bulletList(p.solution.bullets, 5),
      result: unlabel(p.solution.result, /^(התוצאה|תוצאה)\s*[:–-]\s*/),
    },
    parts,
    stages: stages.map((s) => ({
      title: clean(s.title),
      shortTitle: clean(s.shortTitle),
      intro: clean(s.intro),
      bullets: bulletList(s.bullets, 3),
      goal: unlabel(s.goal, /^(מטרה|המטרה)\s*[:–-]\s*/),
      summary: clean(s.summary),
    })),
    requirements: { intro: clean(p.requirements.intro), bullets: bulletList(p.requirements.bullets, 4) },
    scopeSubtitle: clean(p.scopeSubtitle),
    checkpoint: clean(p.checkpoint),
  };
}

/**
 * Hard guard on top of the prompt: no prices, budgets, dev hours or delivery timelines on the client's deck.
 * currentProcess is exempt (it may quote the client's own numbers, e.g. "שעה לכל הצעה").
 * Returns the cleaned plan and what was removed (for logging).
 */
// Note: JS \b does not work next to Hebrew letters, so the patterns avoid it.
const MONEY_OR_TIME =
  /₪|\$|ש"ח|ש״ח|שקל|עלות (הפיתוח|הפרויקט|המערכת)|תקציב|בנק שעות|שעות (פיתוח|עבודה)|\d+\s*(ימי עבודה|שבועות)|תוך (שבוע|שבועיים|חודש|חודשיים)/;
const PRICE_QUOTE = /הצע(ת|ות) מחיר/g; // the client's own process ("הצעות מחיר") is fine

function hasMoneyOrTime(s: string): boolean {
  return MONEY_OR_TIME.test(s.replace(PRICE_QUOTE, ""));
}

export function sanitizePlan(p: Plan, previous: Plan | null): { plan: Plan; removed: string[] } {
  const removed: string[] = [];
  const list = (xs: string[]) =>
    xs.filter((x) => {
      if (hasMoneyOrTime(x)) {
        removed.push(x);
        return false;
      }
      return true;
    });
  const scalar = (v: string, prev: string | undefined) => {
    if (!hasMoneyOrTime(v)) return v;
    removed.push(v);
    return prev && !hasMoneyOrTime(prev) ? prev : "";
  };
  const plan: Plan = {
    ...p,
    solution: {
      title: scalar(p.solution.title, previous?.solution.title),
      intro: scalar(p.solution.intro, previous?.solution.intro),
      bullets: list(p.solution.bullets),
      result: scalar(p.solution.result, previous?.solution.result),
    },
    parts: p.parts.map((x, i) => scalar(x, previous?.parts[i])),
    stages: p.stages.map((s, i) => ({
      title: scalar(s.title, previous?.stages[i]?.title),
      shortTitle: scalar(s.shortTitle, previous?.stages[i]?.shortTitle),
      intro: scalar(s.intro, previous?.stages[i]?.intro),
      bullets: list(s.bullets),
      goal: scalar(s.goal, previous?.stages[i]?.goal),
      summary: scalar(s.summary, previous?.stages[i]?.summary),
    })),
    requirements: { intro: scalar(p.requirements.intro, previous?.requirements.intro), bullets: list(p.requirements.bullets) },
    scopeSubtitle: scalar(p.scopeSubtitle, previous?.scopeSubtitle),
    checkpoint: scalar(p.checkpoint, previous?.checkpoint),
  };
  return { plan, removed };
}

/** True once the client described something business-related (otherwise the deck stays in its "building" state). */
export function hasBusinessContent(p: Plan | null): boolean {
  return !!p && (p.currentProcess.bullets.length > 0 || !!p.solution.title.trim());
}

/** Same plan for the client's eyes (ignores whitespace differences). */
export function samePlan(a: Plan | null, b: Plan | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
