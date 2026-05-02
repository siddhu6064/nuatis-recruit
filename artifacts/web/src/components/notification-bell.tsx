/**
 * Notification bell — shows unread count badge + dropdown.
 * Polls every 30s for new notifications.
 */
import { useState, useEffect, useRef } from "react";
import { Bell, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import { useLocation } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Notification = {
  id: string;
  type: string;
  payload: {
    candidate_id?: string;
    note_id?: string;
    snippet?: string;
    author_id?: string;
  };
  readAt: string | null;
  createdAt: string | null;
};

async function fetchNotifications(): Promise<{
  notifications: Notification[];
  unreadCount: number;
}> {
  const r = await fetch(`${BASE}/api/notifications`);
  if (!r.ok) throw new Error("Failed");
  return r.json();
}

async function markRead(opts: { id?: string; all?: boolean }): Promise<void> {
  await fetch(`${BASE}/api/notifications/mark-read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
}

function notificationLabel(n: Notification): string {
  if (n.type === "note.mention") {
    return n.payload.snippet ? `Mentioned you: "${n.payload.snippet.slice(0, 80)}"` : "Mentioned you in a note";
  }
  return n.type;
}

export function NotificationBell() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const data = await fetchNotifications();
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // Silent — user may not be authed yet
    }
  };

  useEffect(() => {
    void load();
    intervalRef.current = setInterval(() => void load(), 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const handleMarkAll = async () => {
    await markRead({ all: true });
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: new Date().toISOString() })));
    setUnreadCount(0);
  };

  const handleOpen = async (n: Notification) => {
    if (!n.readAt) {
      await markRead({ id: n.id });
      setNotifications((prev) => prev.map((x) => x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x));
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    if (n.payload.candidate_id) {
      setOpen(false);
      navigate(`/candidates/${n.payload.candidate_id}`);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-4 w-4 p-0 flex items-center justify-center text-[10px] leading-none"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-4 py-2.5 border-b">
          <span className="text-sm font-semibold">Notifications</span>
          {unreadCount > 0 && (
            <button
              className="text-xs text-primary hover:underline flex items-center gap-1"
              onClick={handleMarkAll}
            >
              <Check className="h-3 w-3" />
              Mark all read
            </button>
          )}
        </div>
        {notifications.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No notifications</p>
        ) : (
          <ul className="divide-y max-h-96 overflow-y-auto">
            {notifications.map((n) => (
              <li
                key={n.id}
                className={`px-4 py-3 cursor-pointer hover:bg-accent transition-colors ${!n.readAt ? "bg-primary/5" : ""}`}
                onClick={() => void handleOpen(n)}
              >
                <p className="text-sm">{notificationLabel(n)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {n.createdAt
                    ? formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
