import type { NotificationCategory, NotificationScope } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const STATIC_TOKEN = process.env.DIRECTUS_STATIC_TOKEN;

interface CommitteeSource {
    collection: string;
    /** Division or department column the committee is scoped by; null for a flat committee. */
    scopeField: "division_id" | "department_id" | null;
    levelField: string | null;
}

/**
 * The four committees of HRM > Role Management. Note the column spelling split:
 * `disbursement_draft_approver` really is `approver_heirarchy`.
 */
const COMMITTEES: Record<Exclude<NotificationCategory, "individual">, CommitteeSource> = {
    "target-review": { collection: "target_setting_approver", scopeField: null, levelField: null },
    "expense-review": {
        collection: "disbursement_draft_approver",
        scopeField: "division_id",
        levelField: "approver_heirarchy",
    },
    "expense-approver": {
        collection: "expense_approvers",
        scopeField: "division_id",
        levelField: "approver_hierarchy",
    },
    "ta-committee": { collection: "ta_draft_approvers", scopeField: "department_id", levelField: "level" },
};

/**
 * `user.is_deleted` is a MySQL `bit` column: Directus hands it over as
 * {type:"Buffer",data:[0]} and leaves it null for rows that were never set.
 * Null means "still active" — only a set bit means deactivated.
 */
function isDeactivated(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value === "object") {
        const data = (value as { data?: unknown }).data;
        return Array.isArray(data) ? Number(data[0] ?? 0) !== 0 : false;
    }
    if (typeof value === "boolean") return value;
    return Number(value) !== 0;
}

async function directusGet(path: string): Promise<unknown[] | null> {
    if (!API_BASE || !STATIC_TOKEN) return null;
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            headers: { Authorization: `Bearer ${STATIC_TOKEN}` },
            cache: "no-store",
        });
        if (!res.ok) {
            console.error(`[notifications] Directus GET ${path} failed: ${res.status}`);
            return null;
        }
        const body = (await res.json()) as { data?: unknown[] };
        return body.data ?? [];
    } catch (error) {
        console.error(`[notifications] Directus GET ${path} threw:`, error);
        return null;
    }
}

/** Drops users whose account is deactivated; the committee rows themselves stay put. */
async function activeOnly(ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];

    const query = new URLSearchParams();
    query.set("fields", "user_id,is_deleted");
    query.set("filter[user_id][_in]", ids.join(","));
    query.set("limit", "-1");

    const rows = await directusGet(`/items/user?${query.toString()}`);
    if (rows === null) return ids;

    const deactivated = new Set(
        rows
            .filter((row) => isDeactivated((row as { is_deleted?: unknown }).is_deleted))
            .map((row) => Number((row as { user_id?: unknown }).user_id)),
    );

    return ids.filter((id) => !deactivated.has(id));
}

/**
 * Committee members for a category, narrowed by the caller's scope.
 * Omitting `scope.level` addresses the whole chain, which is only wanted for
 * broadcast-style notices; approval routing should always pass its current tier.
 */
export async function resolveRecipients(
    category: Exclude<NotificationCategory, "individual">,
    scope: NotificationScope = {},
): Promise<number[]> {
    const source = COMMITTEES[category];
    if (!source) return [];

    const query = new URLSearchParams();
    query.set("fields", "approver_id");
    query.set("filter[is_deleted][_eq]", "false");
    query.set("limit", "-1");

    const scopeValue = source.scopeField ? scope[source.scopeField] : undefined;
    if (source.scopeField && typeof scopeValue === "number") {
        query.set(`filter[${source.scopeField}][_eq]`, String(scopeValue));
    }
    if (source.levelField && typeof scope.level === "number") {
        query.set(`filter[${source.levelField}][_eq]`, String(scope.level));
    }

    const rows = await directusGet(`/items/${source.collection}?${query.toString()}`);
    if (rows === null) return [];

    // `approver_id` is a plain integer column pointing at `user.user_id`; there is
    // no Directus relation to traverse, so the join is a second query.
    const ids = rows
        .map((row) => Number((row as { approver_id?: unknown }).approver_id))
        .filter((id) => Number.isFinite(id) && id > 0);

    return activeOnly(Array.from(new Set(ids)));
}
