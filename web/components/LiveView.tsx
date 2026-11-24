"use client";

import { useEffect, useRef, useState } from "react";
import type { Plan } from "@/lib/schema";
import { Deck } from "./Deck";

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
  const versionRef = useRef(initial.version);

  useEffect(() => {
    if (state.status === "ended") return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/live/${id}`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as LiveState;
          if (!stopped && (next.version !== versionRef.current || next.status !== state.status)) {
            if (next.version > versionRef.current && versionRef.current > 0) setToast((n) => n + 1);
            versionRef.current = next.version;
            setState(next);
          }
        }
      } catch {
        // offline for a moment; try again on the next tick
      }
    };
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, state.status]);

  const name = state.clientName || state.plan?.clientName || "";
  const live = state.status === "live";

  return (
    <>
      <header className="topbar">
        <div>
          <h1>תוכנית עבודה{name ? ` – ${name}` : ""}</h1>
          <div className="sub">Pro Algorithm · {live ? "נבנית תוך כדי השיחה" : "גרסה סופית"}</div>
        </div>
        <span className={`chip ${live ? "" : "ended"}`}>
          <span className="dot" />
          {live ? "מתעדכן בזמן אמת" : `עודכן ${new Date(state.updatedAt).toLocaleDateString("he-IL")}`}
        </span>
      </header>
      <main className="deck">
        <Deck plan={state.plan} />
      </main>
      {toast > 0 && (
        <div className="toast" key={toast}>
          התוכנית עודכנה לפי השיחה
        </div>
      )}
    </>
  );
}
