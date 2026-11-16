import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

import { decodeJwtSub } from "@/lib/directus";
import { phtStamp } from "@/lib/notifications/emitter";
import { MarkReadSchema, type NotificationInbox, type NotificationRow } from "@/lib/notifications/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const STATIC_TOKEN = process.env.DIRECTUS_STATIC_TOKEN;
const LIST_LIMIT = 30;

const ROW_FIELDS = [
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

function authHeaders(contentType = false): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${STATIC_TOKEN}` };
    if (contentType) headers["Content-Type"] = "application/json";
    return headers;
}

/** Identity always comes from the cookie, never from the query or body. */
async function currentUserId(): Promise<number | null> {
    const cookieStore = await cookies();
    return decodeJwtSub(cookieStore.get("vos_access_token")?.value);
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
    try {
        const res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

export async function GET() {
    const userId = await currentUserId();
    if (!userId) {
        return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const listQuery = new URLSearchParams();
    listQuery.set("fields", ROW_FIELDS);
    listQuery.set("filter[user_id][_eq]", String(userId));
    listQuery.set("filter[is_deleted][_eq]", "0");
    listQuery.set("sort", "-id");
    listQuery.set("limit", String(LIST_LIMIT));

    const countQuery = new URLSearchParams();
    countQuery.set("filter[user_id][_eq]", String(userId));
    countQuery.set("filter[is_deleted][_eq]", "0");
    countQuery.set("filter[is_read][_eq]", "false");
    countQuery.set("aggregate[count]", "*");

    const [list, count] = await Promise.all([
        fetchJson<{ data?: NotificationRow[] }>(`/items/notification?${listQuery.toString()}`, {
            headers: authHeaders(),
        }),
        fetchJson<{ data?: Array<{ count?: string | number }> }>(`/items/notification?${countQuery.toString()}`, {
            headers: authHeaders(),
        }),
    ]);

    if (!list) {
        return NextResponse.json({ success: false, message: "Could not load notifications" }, { status: 502 });
    }

    const inbox: NotificationInbox = {
        items: list.data ?? [],
        unread: Number(count?.data?.[0]?.count ?? 0) || 0,
    };

    return NextResponse.json({ success: true, data: inbox });
}

export async function PATCH(req: NextRequest) {
    const userId = await currentUserId();
    if (!userId) {
        return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const parsed = MarkReadSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { success: false, message: "Invalid request", errors: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    // Directus only accepts a filtered bulk update in its legacy { keys, data } shape, so the
    // ids are resolved first — scoped by user_id, which is what keeps this from marking anyone
    // else's rows read.
    const query = new URLSearchParams();
    query.set("fields", "id");
    query.set("filter[user_id][_eq]", String(userId));
    query.set("filter[is_read][_eq]", "false");
    query.set("filter[is_deleted][_eq]", "false");
    query.set("limit", parsed.data.all ? "-1" : String(parsed.data.ids?.length ?? 0));
    if (!parsed.data.all && parsed.data.ids) {
        query.set("filter[id][_in]", parsed.data.ids.join(","));
    }

    const found = await fetchJson<{ data?: Array<{ id: number }> }>(`/items/notification?${query.toString()}`, {
        headers: authHeaders(),
    });
    if (!found) {
        return NextResponse.json({ success: false, message: "Could not load notifications" }, { status: 502 });
    }

    const keys = (found.data ?? []).map((row) => row.id);
    if (keys.length === 0) {
        return NextResponse.json({ success: true, data: { updated: 0 } });
    }

    const updated = await fetchJson<{ data?: Array<{ id: number }> }>("/items/notification", {
        method: "PATCH",
        headers: authHeaders(true),
        body: JSON.stringify({ keys, data: { is_read: true, read_at: phtStamp() } }),
    });

    if (!updated) {
        return NextResponse.json({ success: false, message: "Could not update notifications" }, { status: 502 });
    }

    return NextResponse.json({ success: true, data: { updated: updated.data?.length ?? keys.length } });
}
