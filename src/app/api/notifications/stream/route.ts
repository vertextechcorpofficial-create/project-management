import { NextRequest } from "next/server";

import { getJwtSubFromReq } from "@/lib/directus";
import { NOTIFICATION_EVENT, notificationBus } from "@/lib/notifications/bus";
import type { NotificationRow } from "@/lib/notifications/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const STATIC_TOKEN = process.env.DIRECTUS_STATIC_TOKEN;

const POLL_MS = 10_000;
const HEARTBEAT_MS = 25_000;
/** Close before the JWT refresh cycle so the next connection re-reads the cookie. */
const LIFETIME_MS = 5 * 60_000;
const BATCH = 20;

const FIELDS = [
    "id",
    "user_id",
    "category",
    "kind",
    "priority",
    "title",
    "body",
    "action_url",
    "module",
    "entity_type",
    "entity_id",
    "dedupe_key",
    "is_read",
    "read_at",
    "created_at",
    "created_by",
].join(",");

async function readRows(query: URLSearchParams): Promise<NotificationRow[]> {
    if (!API_BASE || !STATIC_TOKEN) return [];
    try {
        const res = await fetch(`${API_BASE}/items/notification?${query.toString()}`, {
            headers: { Authorization: `Bearer ${STATIC_TOKEN}` },
            cache: "no-store",
        });
        if (!res.ok) return [];
        const body = (await res.json()) as { data?: NotificationRow[] };
        return body.data ?? [];
    } catch {
        return [];
    }
}

async function latestId(userId: number): Promise<number> {
    const query = new URLSearchParams();
    query.set("fields", "id");
    query.set("filter[user_id][_eq]", String(userId));
    query.set("filter[is_deleted][_eq]", "false");
    query.set("sort", "-id");
    query.set("limit", "1");
    const [row] = await readRows(query);
    return row ? Number(row.id) : 0;
}

async function rowsSince(userId: number, lastId: number): Promise<NotificationRow[]> {
    const query = new URLSearchParams();
    query.set("fields", FIELDS);
    query.set("filter[user_id][_eq]", String(userId));
    query.set("filter[is_deleted][_eq]", "false");
    query.set("filter[id][_gt]", String(lastId));
    query.set("sort", "id");
    query.set("limit", String(BATCH));
    return readRows(query);
}

export async function GET(req: NextRequest) {
    const userId = getJwtSubFromReq(req);
    if (!userId) {
        return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const encoder = new TextEncoder();
    let closed = false;
    let lastId = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (lifetimeTimer) clearTimeout(lifetimeTimer);
        notificationBus.off(NOTIFICATION_EVENT, onNotification);
        req.signal.removeEventListener("abort", cleanup);
        try {
            controller?.close();
        } catch {
            // already closed by the client
        }
    };

    const send = (chunk: string) => {
        if (closed || !controller) return;
        try {
            controller.enqueue(encoder.encode(chunk));
        } catch {
            cleanup();
        }
    };

    const emitRow = (row: NotificationRow) => {
        send(`event: notification\ndata: ${JSON.stringify(row)}\n\n`);
    };

    function onNotification(row: NotificationRow) {
        if (!row || Number(row.user_id) !== userId) return;
        lastId = Math.max(lastId, Number(row.id) || 0);
        emitRow({ ...row, is_read: false });
    }

    const poll = async () => {
        if (closed) return;
        const rows = await rowsSince(userId, lastId);
        rows.forEach((row) => {
            lastId = Math.max(lastId, Number(row.id) || 0);
            emitRow(row);
        });
    };

    const stream = new ReadableStream<Uint8Array>({
        async start(streamController) {
            controller = streamController;

            // Anything already stored is the client's initial GET; the stream starts from now.
            lastId = await latestId(userId);

            send(`retry: 5000\n\n: connected\n\n`);

            notificationBus.on(NOTIFICATION_EVENT, onNotification);
            req.signal.addEventListener("abort", cleanup);

            pollTimer = setInterval(() => {
                void poll();
            }, POLL_MS);

            heartbeatTimer = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);

            lifetimeTimer = setTimeout(() => {
                send(`event: reconnect\ndata: {}\n\n`);
                cleanup();
            }, LIFETIME_MS);
        },
        cancel() {
            cleanup();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
