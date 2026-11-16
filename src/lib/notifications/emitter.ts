import { NOTIFICATION_EVENT, notificationBus } from "./bus";
import { resolveRecipients } from "./resolver";
import { EmitPayloadSchema, type EmitPayload, type NotificationRow } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const STATIC_TOKEN = process.env.DIRECTUS_STATIC_TOKEN;

/** A retry or double submit inside this window collapses to one row per recipient. */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Timestamps are stored as PHT wall clock, matching the rest of the database. */
export function phtStamp(date: Date = new Date()): string {
    return new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    })
        .format(date)
        .replace("T", " ");
}

function authHeaders(): Record<string, string> {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${STATIC_TOKEN}`,
    };
}

interface ExistingRow {
    user_id?: number;
}

async function alreadyNotified(recipients: number[], dedupeKey: string): Promise<Set<number>> {
    const query = new URLSearchParams();
    query.set("limit", "-1");
    query.set("fields", "user_id");
    query.set("filter[user_id][_in]", recipients.join(","));
    query.set("filter[dedupe_key][_eq]", dedupeKey);
    query.set("filter[is_deleted][_eq]", "false");
    query.set("filter[created_at][_gte]", phtStamp(new Date(Date.now() - DEDUPE_WINDOW_MS)));

    const res = await fetch(`${API_BASE}/items/notification?${query.toString()}`, {
        headers: authHeaders(),
        cache: "no-store",
    });

    if (!res.ok) return new Set();

    const body = (await res.json()) as { data?: ExistingRow[] };
    return new Set((body.data ?? []).map((row) => Number(row.user_id)).filter(Number.isFinite));
}

export interface NotifyResult {
    recipients: number[];
    inserted: number;
    skipped: "invalid" | "no-recipients" | "duplicate" | "provider-error" | null;
}

/**
 * Resolve the category's recipients, store one row each, and push them to any open
 * stream on this instance. Never throws: a failed notification must not fail the
 * approval that triggered it. Failures are logged with their payload instead.
 */
export async function notify(input: EmitPayload | unknown): Promise<NotifyResult> {
    const parsed = EmitPayloadSchema.safeParse(input);
    if (!parsed.success) {
        console.error("[notifications] invalid emit payload", parsed.error.flatten(), input);
        return { recipients: [], inserted: 0, skipped: "invalid" };
    }

    const payload = parsed.data;

    if (!API_BASE || !STATIC_TOKEN) {
        console.error("[notifications] missing NEXT_PUBLIC_API_BASE_URL or DIRECTUS_STATIC_TOKEN");
        return { recipients: [], inserted: 0, skipped: "provider-error" };
    }

    let recipients =
        payload.category === "individual"
            ? Array.from(new Set(payload.user_ids ?? []))
            : await resolveRecipients(payload.category, payload.scope);

    recipients = recipients.slice(0, 200);

    if (recipients.length === 0) {
        return { recipients: [], inserted: 0, skipped: "no-recipients" };
    }

    if (payload.dedupe_key) {
        const seen = await alreadyNotified(recipients, payload.dedupe_key);
        if (seen.size > 0) recipients = recipients.filter((id) => !seen.has(id));
        if (recipients.length === 0) {
            return { recipients: [], inserted: 0, skipped: "duplicate" };
        }
    }

    const createdAt = phtStamp();
    const rows = recipients.map((userId) => ({
        user_id: userId,
        category: payload.category,
        kind: payload.kind,
        priority: payload.priority,
        title: payload.title,
        body: payload.body ?? null,
        action_url: payload.action_url ?? null,
        module: payload.module,
        entity_type: payload.entity_type ?? null,
        entity_id: payload.entity_id ?? null,
        dedupe_key: payload.dedupe_key ?? null,
        // Directus types these tinyint columns as boolean, so send booleans.
        is_read: false,
        is_deleted: false,
        created_at: createdAt,
        created_by: payload.created_by ?? null,
    }));

    try {
        const res = await fetch(`${API_BASE}/items/notification`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(rows),
            cache: "no-store",
        });

        const text = await res.text();
        if (!res.ok) {
            console.error(`[notifications] insert failed (${res.status})`, text, payload);
            return { recipients, inserted: 0, skipped: "provider-error" };
        }

        // Directus echoes created rows; on a bare 204 fall back to the ids we sent.
        let created: NotificationRow[] = [];
        try {
            const parsedBody = JSON.parse(text) as { data?: NotificationRow[] };
            created = parsedBody.data ?? [];
        } catch {
            created = [];
        }

        if (created.length > 0) {
            created.forEach((row) => notificationBus.emit(NOTIFICATION_EVENT, row));
        }

        return { recipients, inserted: created.length || rows.length, skipped: null };
    } catch (error) {
        console.error("[notifications] insert threw", error, payload);
        return { recipients, inserted: 0, skipped: "provider-error" };
    }
}
