/**
 * Pure logic for the task tree's drag-and-drop.
 *
 * The model is the reference mockup's (`pm/drag&drop/task-dnd-preview.html`), not dnd-kit's sortable
 * model: the pointer's vertical position picks the GAP a row would land in, its horizontal travel
 * picks the LEVEL, and the dragged row leaves the list while it travels. Everything here is a function
 * of plain data, so the whole decision path is covered by `__assert.ts` without a browser.
 */

/** The columns of a task this logic needs: identity, parent, order in the parent's list. */
export interface DndRow {
    readonly id: number;
    readonly parent_id: number | null;
    readonly sort_order: number;
}

/** The write payload the move route accepts: the destination parent and its COMPLETE child order. */
export interface MovePayload {
    readonly parent_id: number | null;
    readonly sibling_ids: number[];
}

/** Rows come back from the API in no particular order, so every list is sorted by the persisted key. */
function bySortOrder(a: DndRow, b: DndRow): number {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.id - b.id;
}

/**
 * True when `parentId` is the moved row itself or sits underneath it.
 *
 * This is the one structural refusal a re-parent must make: dropping a task inside its own descendant
 * would detach that subtree from the tree. Everything else — a new parent, another level, the root —
 * is legal.
 */
export function isCycleTarget(
    rows: readonly DndRow[],
    activeId: number,
    parentId: number | null,
): boolean {
    if (parentId === null) return false;
    if (parentId === activeId) return true;

    const parentOf = new Map<number, number | null>();
    for (const row of rows) parentOf.set(row.id, row.parent_id);

    let cursor: number | null = parentId;
    const seen = new Set<number>([parentId]);
    while (cursor !== null) {
        if (cursor === activeId) return true;
        const next: number | null = parentOf.get(cursor) ?? null;
        if (next === null) return false;
        if (seen.has(next)) return false;
        seen.add(next);
        cursor = next;
    }
    return false;
}

/**
 * The destination parent's ordered live child ids with the moved node removed.
 *
 * The subtraction matters: before the write the moved node is not yet a child of the target parent, so
 * a caller that wants the post-move list must splice it back in — which is exactly the membership rule
 * the move route applies. Passing `excludeId` here keeps that logic in one place.
 */
export function listChildIds(
    rows: readonly DndRow[],
    parentId: number | null,
    excludeId?: number,
): number[] {
    return rows
        .filter((row) => row.parent_id === parentId && row.id !== excludeId)
        .sort(bySortOrder)
        .map((row) => row.id);
}

/**
 * Splices the moved id into the destination parent's child list and returns the pinned payload.
 *
 * The cycle guard is the one structural refusal: `parentId` may not be the moved node or any of its
 * descendants. Every other parent is legal, including a different level (re-parent) and `null`
 * (promote to root). `insertIndex` is clamped so a stale index can never drop a sibling.
 */
export function computeMovePayload(
    rows: readonly DndRow[],
    activeId: number,
    parentId: number | null,
    insertIndex: number,
): MovePayload | null {
    if (isCycleTarget(rows, activeId, parentId)) return null;

    const children = listChildIds(rows, parentId, activeId);
    const index = Math.max(0, Math.min(insertIndex, children.length));
    return { parent_id: parentId, sibling_ids: [...children.slice(0, index), activeId, ...children.slice(index)] };
}

/* ------------------------------------------------------------------ */
/*  Pointer model                                                      */
/* ------------------------------------------------------------------ */

/**
 * The deepest level a drag may project. The tree itself is unbounded; this only stops a sideways drag
 * from promising a level the list would render flush anyway.
 */
export const MAX_PROJECTED_DEPTH = 12;

/** A row as the pointer engine sees it: render order, true depth, real parent. */
export interface PointerRow {
    readonly id: number;
    readonly parentId: number | null;
    readonly depth: number;
}

/** A measured row rect in viewport coordinates. */
export interface RowRect {
    readonly top: number;
    readonly height: number;
}

/**
 * Which gap the pointer is in, counted against row CENTRES.
 *
 * The dragged row is already out of the list when this runs, so the result indexes the rows the user
 * can actually see: `0` is the gap above the first row and `rects.length` the gap after the last. A row
 * counts as "passed" once the pointer is below its midpoint, which is what makes the line move halfway
 * through a row instead of only at its edges.
 */
export function pointerGapIndex(rects: readonly RowRect[], pointerY: number): number {
    let index = 0;
    for (const rect of rects) {
        if (rect.top + rect.height / 2 < pointerY) index += 1;
    }
    return index;
}

/** Inputs for the slot projection. */
export interface SlotProjectionInput {
    /** Visible rows in render order, WITHOUT the dragged row. */
    readonly rows: readonly PointerRow[];
    /** The dragged row's depth when it was picked up — the base the sideways travel is added to. */
    readonly activeDepth: number;
    /** Sideways travel from the grab point, in pixels. */
    readonly offsetX: number;
    /** Gap index from `pointerGapIndex`. */
    readonly index: number;
    /** Pixels of sideways travel that mean one level. */
    readonly indentWidth: number;
    /** Ceiling on the level a drag may promise. */
    readonly maxDepth?: number;
}

/** The slot a drop would take: which gap, which level, which parent. */
export interface SlotProjection {
    readonly index: number;
    readonly depth: number;
    readonly parentId: number | null;
}

/**
 * The reference's `project()`: the gap picks the neighbours, the sideways travel picks the level.
 *
 * A gap can only accept a level between its neighbours — never deeper than one under the row above
 * (`previous.depth + 1`), never shallower than the row below (`next.depth`) — so the list can never be
 * orphaned by a drop. The parent then falls out of the row above: same level means sharing its parent,
 * one deeper means becoming its child, shallower means walking back to the row that owns that level.
 */
export function projectDropSlot(input: SlotProjectionInput): SlotProjection {
    const { rows, activeDepth, offsetX, index, indentWidth, maxDepth = MAX_PROJECTED_DEPTH } = input;
    const previous = index > 0 ? rows[index - 1] : undefined;
    const next = index < rows.length ? rows[index] : undefined;

    const ceiling = previous === undefined ? 0 : Math.min(previous.depth + 1, maxDepth);
    const floor = next === undefined ? 0 : next.depth;
    const travelled = activeDepth + Math.round(offsetX / Math.max(1, indentWidth));
    const depth = Math.max(floor, Math.min(ceiling, travelled));

    let parentId: number | null = null;
    if (depth > 0 && previous !== undefined) {
        if (depth === previous.depth) {
            parentId = previous.parentId;
        } else if (depth > previous.depth) {
            parentId = previous.id;
        } else {
            for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
                if (rows[cursor].depth === depth) {
                    parentId = rows[cursor].parentId;
                    break;
                }
            }
        }
    }

    return { index, depth, parentId };
}

/**
 * Where the moved node lands inside its new parent's child list: one slot after the last child that
 * sits above the gap, or first when none does. `rows` is the visible order without the dragged row.
 */
export function childInsertIndex(
    rows: readonly PointerRow[],
    index: number,
    parentId: number | null,
): number {
    let count = 0;
    for (let cursor = 0; cursor < index && cursor < rows.length; cursor += 1) {
        if (rows[cursor].parentId === parentId) count += 1;
    }
    return count;
}
