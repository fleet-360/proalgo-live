"use client";

import { useEffect, useRef, useState } from "react";
import type { Plan } from "@/lib/schema";
import { Deck, PlanText } from "./Deck";

interface LiveState {
  status: "live" | "ended";
  clientName: string;
  plan: Plan | null;
  version: number;
  updatedAt: number;
}

const POLL_MS = 3000;

export function LiveView({ id, initial }: { id: string; initial: LiveState }) {
  const [state, setState] = useState<LiveState>(initial);
  const [toast, setToast] = useState(0);
  const [missing, setMissing] = useState(false);
  const stateRef = useRef(initial);

  useEffect(() => {
    if (state.status === "ended" || missing) return;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // One request at a time; the next tick starts only after this one settles, so answers can't arrive out of order.
    const tick = async () => {
      if (stopped) return;
      timer = undefined;
      inFlight = true;
      try {
        await poll();
      } finally {
        inFlight = false;
      }
      if (!stopped && stateRef.current.status !== "ended") timer = setTimeout(tick, POLL_MS);
    };
    const poll = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch(`/api/live/${id}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
          if (res.status === 404) {
            stopped = true;
            setMissing(true);
            return;
          }
          if (res.ok && !stopped) {
            const next = (await res.json()) as LiveState;
            const cur = stateRef.current;
            const newer = next.version > cur.version || (next.version === cur.version && next.status !== cur.status);
            if (newer) {
              if (cur.version > 0 && JSON.stringify(next.plan) !== JSON.stringify(cur.plan)) setToast((n) => n + 1);
              stateRef.current = next;
              setState(next);
            }
          }
        } catch {
          // offline for a moment; try again on the next tick
        }
      }
    };
    // Back to the tab: fetch now instead of waiting, unless a request is already on its way.
    const onVisible = () => {
      if (!document.hidden && timer && !inFlight) {
        clearTimeout(timer);
        tick();
      }
    };
    timer = setTimeout(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, state.status, missing]);

  const name = state.clientName || state.plan?.clientName || "";
  const live = state.status === "live";

  // Keeps the browser tab and the "Save as PDF" file name in step with the client name learned during the call.
  useEffect(() => {
    document.title = name ? `תוכנית עבודה – ${name} | Pro Algorithm` : "תוכנית עבודה | Pro Algorithm";
  }, [name]);

  if (missing) return <div className="center-msg">הקישור לא נמצא או שפג תוקפו.</div>;

  return (
    <>
      <header className="topbar">
        <div>
          <h1>תוכנית עבודה{name ? ` – ${name}` : ""}</h1>
          <div className="sub">Pro Algorithm · {live ? "נבנית תוך כדי השיחה" : "גרסה סופית"}</div>
        </div>
        <span className={`chip ${live ? "" : "ended"}`}>
          <span className="dot" />
          {live
            ? "מתעדכן בזמן אמת"
            : `עודכן ${new Date(state.updatedAt).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })}`}
        </span>
      </header>
      <main className="deck">
        <Deck plan={state.plan} />
      </main>
      <PlanText plan={state.plan} />
      {toast > 0 && (
        <div className="toast" key={toast}>
          התוכנית עודכנה לפי השיחה
        </div>
      )}
    </>
  );
}
