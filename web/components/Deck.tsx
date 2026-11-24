"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Plan, Stage } from "@/lib/schema";

/*
 * 1:1 rebuild of the "תוכנית עבודה" Canva deck. Backgrounds are the original pages
 * exported without their text; every text box below sits at the exact position
 * (in 1920x1080 px) it had in Canva.
 */

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Scales a 1920x1080 slide to the width of its frame. */
function Frame({ bg, children }: { bg: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / 1920);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="frame" ref={ref}>
      <div
        className="slide"
        style={{
          backgroundImage: `url(${bg})`,
          transform: `scale(${scale})`,
          visibility: scale ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Briefly highlights its content whenever `value` changes (after the first render). */
function useFlash(value: string) {
  const first = useRef(true);
  const prev = useRef(value);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      prev.current = value;
      return;
    }
    if (prev.current !== value) {
      prev.current = value;
      setFlash((n) => n + 1);
    }
  }, [value]);
  return flash;
}

/**
 * Absolutely positioned box whose font shrinks until the content fits,
 * so long Hebrew text never spills out of a card.
 */
function Box({
  x,
  y,
  w,
  h,
  size,
  min = 14,
  className = "",
  style,
  children,
  watch,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  min?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  watch: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(size);
  const flash = useFlash(watch);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let s = size;
    el.style.fontSize = `${s}px`;
    while (s > min && (el.scrollHeight > h + 1 || el.scrollWidth > w + 1)) {
      s -= 1;
      el.style.fontSize = `${s}px`;
    }
    setFs(s);
  }, [watch, size, min, w, h]);
  return (
    <div
      ref={ref}
      key={flash}
      className={`box ${className} ${flash ? "flash" : ""}`}
      style={{ left: x, top: y, width: w, height: h, fontSize: fs, ...style }}
    >
      {children}
    </div>
  );
}

function Skel({ widths }: { widths: number[] }) {
  return (
    <>
      {widths.map((wd, i) => (
        <span key={i} className="skel" style={{ width: `${wd}%` }} />
      ))}
    </>
  );
}

const RLM = "‏";

/** Intro line, "• " bullets and an optional "מטרה:" line, like the Canva text boxes. */
function Lines({ intro, bullets, goal, goalLabel = "מטרה" }: { intro: string; bullets: string[]; goal?: string; goalLabel?: string }) {
  const empty = !intro && !bullets.some(Boolean) && !goal;
  if (empty) return <Skel widths={[70, 85, 78, 82, 60]} />;
  return (
    <>
      {intro && <div>{RLM + intro}</div>}
      {bullets.filter(Boolean).map((b, i) => (
        <div key={i}>{RLM + "• " + b}</div>
      ))}
      {goal && <div>{`${RLM}${goalLabel}: ${goal}`}</div>}
    </>
  );
}

function linesKey(...parts: (string | string[] | undefined)[]) {
  return parts.map((p) => (Array.isArray(p) ? p.join("|") : p ?? "")).join("§");
}

function Title({ text, ...pos }: { text: string; x: number; y: number; w: number; h: number; size?: number }) {
  return (
    <Box {...pos} size={pos.size ?? 24} min={16} className="card-title" watch={text}>
      {text || <Skel widths={[55]} />}
    </Box>
  );
}

function StageCard({ stage, title, body }: { stage: Stage; title: [number, number, number, number]; body: [number, number, number, number] }) {
  return (
    <>
      <Title text={stage.title} x={title[0]} y={title[1]} w={title[2]} h={title[3]} />
      <Box
        x={body[0]}
        y={body[1]}
        w={body[2]}
        h={body[3]}
        size={23}
        className="lines"
        watch={linesKey(stage.intro, stage.bullets, stage.goal)}
      >
        <Lines intro={stage.intro} bullets={stage.bullets} goal={stage.goal} />
      </Box>
    </>
  );
}

function PartLabel({ letter, name, x, y, w, h, size }: { letter: string; name: string; x: number; y: number; w: number; h: number; size: number }) {
  return (
    <Box x={x} y={y} w={w} h={h} size={size} min={22} className="circle-sub on-dark" watch={name}>
      <div>{name ? `${RLM}חלק ${letter} – ${name}` : <Skel widths={[70, 50]} />}</div>
    </Box>
  );
}

const STAGE_COLORS = ["#6d90fa", "#5fcafa", "#cb6ce6", "#8743dd", "#20caff"];
// Slide 6 cards, right to left: stage 01 is the rightmost.
const SCOPE_CARD_X = [1481, 1166, 851, 536, 229.5];

export function Deck({ plan }: { plan: Plan | null }) {
  const p: Plan = plan ?? EMPTY_PLAN;
  const s = p.stages;
  return (
    <>
      {/* 1 – cover (static) */}
      <Frame bg="/slides/slide1.png">{null}</Frame>

      {/* 2 – the request: today's process and the solution */}
      <Frame bg="/slides/slide2.png">
        <Box x={187} y={318} w={978} h={262} size={23} className="lines" watch={linesKey(p.currentProcess.intro, p.currentProcess.bullets)}>
          <Lines intro={p.currentProcess.intro} bullets={p.currentProcess.bullets} />
        </Box>
        <Box x={187} y={590} w={978} h={52} size={32} min={20} style={{ fontWeight: 700, color: "#112f8d", textAlign: "right" }} watch={p.solution.title}>
          {p.solution.title ? `הפתרון: ${p.solution.title}` : <Skel widths={[45]} />}
        </Box>
        <Box x={187} y={652} w={978} h={340} size={23} className="lines" watch={linesKey(p.solution.intro, p.solution.bullets, p.solution.result)}>
          <Lines intro={p.solution.intro} bullets={[...p.solution.bullets, ...(p.solution.result ? [`התוצאה: ${p.solution.result}`] : [])]} />
        </Box>
      </Frame>

      {/* 3 – stages 01, 02 */}
      <Frame bg="/slides/slide3.png">
        <PartLabel letter="א׳" name={p.parts[0]} x={150} y={540} w={466} h={140} size={40} />
        <StageCard stage={s[0]} title={[836, 326, 420, 40]} body={[842, 378, 404, 286]} />
        <StageCard stage={s[1]} title={[1380, 713, 426, 40]} body={[1377, 760, 424, 236]} />
      </Frame>

      {/* 4 – stages 03, 04 */}
      <Frame bg="/slides/slide4.png">
        <PartLabel letter="ב׳" name={p.parts[1]} x={1320} y={488} w={460} h={140} size={42} />
        <StageCard stage={s[2]} title={[222, 328, 426, 40]} body={[230, 370, 410, 222]} />
        <StageCard stage={s[3]} title={[749, 743, 420, 40]} body={[745, 784, 414, 222]} />
      </Frame>

      {/* 5 – stage 05 and what we need from the client */}
      <Frame bg="/slides/slide5.png">
        <PartLabel letter="ג׳" name={p.parts[2]} x={130} y={800} w={520} h={120} size={42} />
        <StageCard stage={s[4]} title={[856, 375, 416, 40]} body={[862, 416, 404, 240]} />
        <Box x={1440} y={712} w={372} h={288} size={23} className="lines" watch={linesKey(p.requirements.intro, p.requirements.bullets)}>
          <Lines intro={p.requirements.intro} bullets={p.requirements.bullets} />
        </Box>
      </Frame>

      {/* 6 – scope: the five parts, no hours */}
      <Frame bg="/slides/slide6.png">
        <Box x={225} y={4} w={1493} h={90} size={69} min={40} style={{ fontWeight: 800, color: "#20caff", textAlign: "center", letterSpacing: "-0.01em" }} watch="title">
          שלבי העבודה – היקף ההצעה
        </Box>
        <Box x={229} y={98} w={1493} h={72} size={32} min={20} className="on-dark" style={{ color: "#fff", textAlign: "center", lineHeight: 1.35 }} watch={p.scopeSubtitle}>
          {p.scopeSubtitle ? RLM + p.scopeSubtitle : <Skel widths={[60]} />}
        </Box>
        {s.map((st, i) => (
          <div key={i}>
            <Box x={SCOPE_CARD_X[i] + 20} y={318} w={240} h={96} size={30} min={20} style={{ fontWeight: 700, color: "#112f8d", lineHeight: 1.25, textAlign: "right" }} watch={st.shortTitle}>
              {st.shortTitle || <Skel widths={[80]} />}
            </Box>
            <Box x={SCOPE_CARD_X[i] + 20} y={430} w={240} h={320} size={21} min={15} style={{ color: "#122359", lineHeight: 1.45, textAlign: "right" }} watch={st.summary}>
              {st.summary ? RLM + st.summary : <Skel widths={[90, 80, 85, 60]} />}
            </Box>
          </div>
        ))}
        <Box x={250} y={822} w={416} h={104} size={52} min={26} style={pillStyle} watch="count">
          <div style={{ fontWeight: 700, lineHeight: 1.1 }}>5 שלבים</div>
          <div style={{ fontSize: "0.52em", fontWeight: 400, marginTop: 4 }}>היקף הפרויקט</div>
        </Box>
        <Box x={1262} y={820} w={416} h={104} size={46} min={24} style={pillStyle} watch={p.checkpoint}>
          <div style={{ fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.02em" }}>{p.checkpoint || "—"}</div>
          <div style={{ fontSize: "0.6em", fontWeight: 400, marginTop: 4 }}>נקודת בקרה</div>
        </Box>
      </Frame>
    </>
  );
}

const pillStyle: React.CSSProperties = {
  color: "#fff",
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
};

const EMPTY_STAGE: Stage = { title: "", shortTitle: "", intro: "", bullets: [], goal: "", summary: "" };

export const EMPTY_PLAN: Plan = {
  clientName: "",
  currentProcess: { intro: "", bullets: [] },
  solution: { title: "", intro: "", bullets: [], result: "" },
  parts: ["", "", ""],
  stages: [EMPTY_STAGE, EMPTY_STAGE, EMPTY_STAGE, EMPTY_STAGE, EMPTY_STAGE],
  requirements: { intro: "", bullets: [] },
  scopeSubtitle: "",
  checkpoint: "",
};
