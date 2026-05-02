import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Status = "connecting" | "live" | "reconnecting" | "offline";

type Props = {
  jobId: string;
  onEvent: (payload: Record<string, unknown>) => void;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function LiveIndicator({ jobId, onEvent }: Props) {
  const [status, setStatus] = useState<Status>("connecting");
  const esRef = useRef<EventSource | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      setStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");

      const es = new EventSource(`/api/jobs/${jobId}/stream`, { withCredentials: true });
      esRef.current = es;

      es.onopen = () => {
        if (destroyed) return;
        attemptRef.current = 0;
        setStatus("live");
      };

      es.onerror = () => {
        if (destroyed) return;
        es.close();
        esRef.current = null;
        setStatus("reconnecting");
        const delay = Math.min(
          RECONNECT_BASE_MS * 2 ** attemptRef.current,
          RECONNECT_MAX_MS,
        );
        attemptRef.current += 1;
        timerRef.current = setTimeout(connect, delay);
      };

      es.onmessage = (ev) => {
        if (destroyed) return;
        try {
          const payload = JSON.parse(ev.data as string) as Record<string, unknown>;
          onEvent(payload);
        } catch {
          /* ignore malformed events */
        }
      };
    }

    connect();

    return () => {
      destroyed = true;
      esRef.current?.close();
      if (timerRef.current) clearTimeout(timerRef.current);
      setStatus("offline");
    };
  }, [jobId, onEvent]);

  const label: Record<Status, string> = {
    connecting: "Connecting…",
    live: "Live",
    reconnecting: "Reconnecting…",
    offline: "Offline",
  };

  const dotClass: Record<Status, string> = {
    connecting: "bg-yellow-400 animate-pulse",
    live: "bg-emerald-500",
    reconnecting: "bg-orange-400 animate-pulse",
    offline: "bg-muted-foreground",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full border",
        status === "live"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : status === "offline"
          ? "border-muted bg-muted text-muted-foreground"
          : "border-yellow-200 bg-yellow-50 text-yellow-700",
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", dotClass[status])} />
      {label[status]}
    </span>
  );
}
