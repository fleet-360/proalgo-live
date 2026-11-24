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

/** Second-pass output when the first pass left the stages empty: everything after slide 2. */
export const CompletionSchema = z.object({
  parts: PlanSchema.shape.parts,
  stages: PlanSchema.shape.stages,
  requirements: PlanSchema.shape.requirements,
  scopeSubtitle: PlanSchema.shape.scopeSubtitle,
  checkpoint: PlanSchema.shape.checkpoint,
  questions: InsightsSchema.shape.questions,
  roi: InsightsSchema.shape.roi,
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
}

/** A session nobody ended (app crashed, laptop closed) stops claiming to be live after a few quiet hours. */
const STALE_MS = 3 * 60 * 60 * 1000;
export function effectiveStatus(meta: SessionMeta, finalRequested = false, now = Date.now()): "live" | "ended" {
  if (meta.status === "ended") return "ended";
  // "End call" was pressed but the final pass never completed (e.g. the app was closed): stop claiming live soon.
  if (finalRequested && now - meta.updatedAt > 6 * 60 * 1000) return "ended";
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
// Our prices / development cost: blocked everywhere on the client's deck.
// Only amounts with a currency, never the bare letters "שקל" (they appear inside "משקל", "שקלול").
// Note: JS \b does not work next to Hebrew letters, so the patterns avoid it.
const OUR_COST =
  /₪|\$|ש"ח|ש״ח|\d[\d,.]*\s*(אלף\s*)?שקל(ים)?(?![א-ת])|בנק שעות|שעות פיתוח|עלות (הפיתוח|הפרויקט|המערכת)|תקציב (הפרויקט|הפיתוח)|\d+\s*ימי עבודה/;
// Our delivery timeline: blocked only where the deck describes our work (stage cards, scope, checkpoint),
// not in the solution result or stage goals, which may describe the client's own savings ("דוח ביום במקום 3 שבועות").
const OUR_TIMELINE = /\d+\s*שבועות|תוך (שבוע|שבועיים|חודש|חודשיים)|תאריך מסירה/;

export function sanitizePlan(p: Plan, previous: Plan | null): { plan: Plan; removed: string[] } {
  const removed: string[] = [];
  const bad = (s: string, timeline: boolean) => OUR_COST.test(s) || (timeline && OUR_TIMELINE.test(s));
  const list = (xs: string[], timeline = false) =>
    xs.filter((x) => {
      if (!bad(x, timeline)) return true;
      removed.push(x);
      return false;
    });
  const scalar = (v: string, prev: string | undefined, timeline = false) => {
    if (!bad(v, timeline)) return v;
    removed.push(v);
    return prev && !bad(prev, timeline) ? prev : "";
  };
  const plan: Plan = {
    ...p,
    solution: {
      title: scalar(p.solution.title, previous?.solution.title),
      intro: scalar(p.solution.intro, previous?.solution.intro),
      bullets: list(p.solution.bullets),
      result: scalar(p.solution.result, previous?.solution.result),
    },
    parts: p.parts.map((x, i) => scalar(x, previous?.parts[i], true)),
    stages: p.stages.map((s, i) => ({
      title: scalar(s.title, previous?.stages[i]?.title, true),
      shortTitle: scalar(s.shortTitle, previous?.stages[i]?.shortTitle, true),
      intro: scalar(s.intro, previous?.stages[i]?.intro, true),
      bullets: list(s.bullets, true),
      goal: scalar(s.goal, previous?.stages[i]?.goal),
      summary: scalar(s.summary, previous?.stages[i]?.summary, true),
    })),
    requirements: {
      intro: scalar(p.requirements.intro, previous?.requirements.intro, true),
      bullets: list(p.requirements.bullets, true),
    },
    scopeSubtitle: scalar(p.scopeSubtitle, previous?.scopeSubtitle, true),
    checkpoint: scalar(p.checkpoint, previous?.checkpoint, true),
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
