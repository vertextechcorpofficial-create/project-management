"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTitle,
    PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { NotificationInbox, NotificationRow } from "@/lib/notifications/types";

const CHANNEL_NAME = "vos-notifications";
const POLL_INTERVAL_MS = 60_000;
const TOAST_DURATION_MS = 8_000;
const LIST_LIMIT = 30;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const KIND_DOT: Record<NotificationRow["kind"], string> = {
    action: "bg-primary",
    alert: "bg-destructive",
    info: "bg-muted-foreground/60",
};

const isUnread = (row: NotificationRow) => !row.is_read;

/**
 * Splits the naive PHT wall-clock stamp (`2026-11-15 15:04:00`). Deliberately not
 * `new Date(stamp)`: that parses in the browser's zone, not the server's.
 */
function phtParts(stamp: string) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(stamp);
    if (!m) return null;
    return {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: Number(m[4]),
        minute: Number(m[5]),
        second: Number(m[6] ?? 0),
    };
}

/** PHT is a fixed UTC+8 with no DST, so the offset shift is exact year-round. */
function timeAgo(stamp: string): string {
    const p = phtParts(stamp);
    if (!p) return stamp;

    const then = Date.UTC(p.year, p.month - 1, p.day, p.hour - 8, p.minute, p.second);
    const minutes = Math.floor((Date.now() - then) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;

    const hh = String(p.hour).padStart(2, "0");
    const mm = String(p.minute).padStart(2, "0");
    return `${MONTHS[p.month - 1]} ${p.day}, ${hh}:${mm}`;
}

export function NotificationBell() {
    const router = useRouter();
    const [items, setItems] = React.useState<NotificationRow[]>([]);
    const [unread, setUnread] = React.useState(0);
    const [loading, setLoading] = React.useState(true);
    const [open, setOpen] = React.useState(false);
    const [liveTitle, setLiveTitle] = React.useState("");

    const itemsRef = React.useRef<NotificationRow[]>([]);
    const channelRef = React.useRef<BroadcastChannel | null>(null);

    React.useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    const load = React.useCallback(async () => {
        try {
            const res = await fetch("/api/notifications", { cache: "no-store" });
            if (res.status === 401) {
                setItems([]);
                setUnread(0);
                return;
            }
            if (!res.ok) return;
            const payload = (await res.json()) as { success?: boolean; data?: NotificationInbox };
            if (!payload?.success || !payload.data) return;
            setItems(payload.data.items);
            setUnread(payload.data.unread);
        } catch {
            // Keep the last known inbox; the next poll, push or focus retries.
        } finally {
            setLoading(false);
        }
    }, []);

    /** Marks the given rows read locally and trims the unread count by the rows that were unread. */
    const applyRead = React.useCallback((ids: number[]) => {
        if (!ids.length) return;
        const idSet = new Set(ids);
        const cleared = itemsRef.current.filter((row) => idSet.has(row.id) && isUnread(row)).length;
        if (!cleared) return;

        setItems((prev) =>
            prev.map((row) => (idSet.has(row.id) && isUnread(row) ? { ...row, is_read: 1 } : row)),
        );
        setUnread((prev) => Math.max(0, prev - cleared));
    }, []);

    const applyMark = React.useCallback(
        async (body: { ids?: number[]; all?: boolean }) => {
            const ids = body.all
                ? itemsRef.current.filter(isUnread).map((row) => row.id)
                : body.ids ?? [];

            applyRead(ids);
            if (body.all) setUnread(0);

            try {
                const res = await fetch("/api/notifications", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                if (!res.ok) {
                    await load();
                    return;
                }
                channelRef.current?.postMessage({ type: "read", ids });
            } catch {
                await load();
            }
        },
        [applyRead, load],
    );

    /** Live push only: the mount-time backlog must never toast. */
    const push = React.useCallback(
        (row: NotificationRow) => {
            setItems((prev) => [row, ...prev.filter((n) => n.id !== row.id)].slice(0, LIST_LIMIT));
            if (isUnread(row)) setUnread((prev) => prev + 1);
            setLiveTitle(row.title);

            const url = row.action_url;
            toast(row.title, {
                description: row.body ?? undefined,
                duration: TOAST_DURATION_MS,
                action: url ? { label: "Open", onClick: () => router.push(url) } : undefined,
            });
        },
        [router],
    );

    React.useEffect(() => {
        void load();
    }, [load]);

    React.useEffect(() => {
        if (typeof BroadcastChannel === "undefined") return;
        const channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = (event: MessageEvent) => {
            const msg = event.data as { type?: string; ids?: number[] } | null;
            if (msg?.type === "read" && Array.isArray(msg.ids)) applyRead(msg.ids);
        };
        channelRef.current = channel;
        return () => {
            channelRef.current = null;
            channel.close();
        };
    }, [applyRead]);

    React.useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === "visible") void load();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, [load]);

    React.useEffect(() => {
        let failures = 0;
        let poll: ReturnType<typeof setInterval> | null = null;
        const stopPoll = () => {
            if (poll) {
                clearInterval(poll);
                poll = null;
            }
        };
        const startPoll = () => {
            if (!poll) poll = setInterval(() => void load(), POLL_INTERVAL_MS);
        };

        if (typeof EventSource === "undefined") {
            startPoll();
            return stopPoll;
        }

        let created: EventSource | null = null;
        try {
            created = new EventSource("/api/notifications/stream");
        } catch {
            // Locked-down contexts can throw at construction; poll instead of dying.
            startPoll();
        }
        if (!created) return stopPoll;
        const source = created;

        const onNotification = (event: Event) => {
            const data = (event as MessageEvent<string>).data;
            let row: NotificationRow;
            try {
                row = JSON.parse(data) as NotificationRow;
            } catch {
                return;
            }
            if (typeof row?.id !== "number" || typeof row.title !== "string") return;
            push(row);
        };

        // The server sends `reconnect` then closes to force a clean re-dial. The
        // error that follows is expected, so reset the streak and resync instead.
        const onReconnect = () => {
            failures = 0;
            void load();
        };

        source.addEventListener("notification", onNotification);
        source.addEventListener("reconnect", onReconnect);
        source.onopen = () => {
            failures = 0;
            stopPoll();
        };
        source.onerror = () => {
            failures += 1;
            if (failures >= 2 || source.readyState === EventSource.CLOSED) startPoll();
        };

        return () => {
            source.removeEventListener("notification", onNotification);
            source.removeEventListener("reconnect", onReconnect);
            source.close();
            stopPoll();
        };
    }, [load, push]);

    const openRow = (row: NotificationRow) => {
        if (isUnread(row)) void applyMark({ ids: [row.id] });
        setOpen(false);
        if (row.action_url) router.push(row.action_url);
    };

    const badge = unread > 99 ? "99+" : String(unread);

    return (
        <>
            <span aria-live="polite" aria-atomic="true" className="sr-only">
                {liveTitle}
            </span>

            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
                        className="relative text-foreground/70 hover:bg-accent hover:text-foreground"
                    >
                        <Bell />
                        {unread > 0 && (
                            <Badge className="absolute -right-0.5 -top-0.5 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none tabular-nums">
                                {badge}
                            </Badge>
                        )}
                    </Button>
                </PopoverTrigger>

                <PopoverContent
                    align="end"
                    alignOffset={-8}
                    sideOffset={8}
                    collisionPadding={16}
                    className="w-80 p-0"
                >
                    <span
                        aria-hidden
                        className="pointer-events-none absolute -top-1.5 right-4 size-2.5 rotate-45 rounded-[1px] border-l border-t border-border bg-popover"
                    />
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <PopoverTitle className="text-sm">Notifications</PopoverTitle>
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => void applyMark({ all: true })}
                            disabled={unread === 0}
                            className="text-muted-foreground"
                        >
                            <CheckCheck />
                            Mark all read
                        </Button>
                    </div>
                    <Separator />

                    <ScrollArea className="max-h-80">
                        {loading && items.length === 0 ? (
                            <div className="space-y-2 p-3">
                                <Skeleton className="h-9 w-full" />
                                <Skeleton className="h-9 w-full" />
                                <Skeleton className="h-9 w-full" />
                            </div>
                        ) : items.length === 0 ? (
                            <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
                                <Bell className="size-6 text-muted-foreground/40" />
                                <p className="text-sm text-muted-foreground">No notifications</p>
                                <p className="text-xs text-muted-foreground/70">You are all caught up.</p>
                            </div>
                        ) : (
                            <ul className="divide-y divide-border/60">
                                {items.map((row) => (
                                    <li key={row.id}>
                                        <button
                                            type="button"
                                            onClick={() => openRow(row)}
                                            className={cn(
                                                "flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors",
                                                "hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none",
                                                isUnread(row) && "bg-accent/30",
                                            )}
                                        >
                                            <span
                                                aria-hidden="true"
                                                className={cn(
                                                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                                                    KIND_DOT[row.kind] ?? "bg-muted-foreground/60",
                                                )}
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span
                                                    className={cn(
                                                        "block truncate text-sm",
                                                        isUnread(row) ? "font-medium" : "text-muted-foreground",
                                                    )}
                                                >
                                                    {row.title}
                                                </span>
                                                {row.body && (
                                                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                                                        {row.body}
                                                    </span>
                                                )}
                                                <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/70">
                                                    <span className="uppercase tracking-wide">{row.module}</span>
                                                    <span>{timeAgo(row.created_at)}</span>
                                                </span>
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </ScrollArea>
                </PopoverContent>
            </Popover>
        </>
    );
}
