/**
 * Assertion harness for the task tree's drag-and-drop engine.
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/task-management/tasks/components/tree-dnd/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * The engine is the reference mockup's pointer model, so this covers it in the same three parts: where
 * the gap is (`pointerGapIndex`), what level and parent that gap accepts (`projectDropSlot`), and what
 * the move route is then asked to write (`childInsertIndex` + `computeMovePayload`, including the
 * neighbour clamps and the cycle guard). Every one of those is a pure function of plain data, which is
 * why the whole decision path is asserted without a browser.
 *
 * Why the `.ts` extension and the directive: Node resolves a relative import only when the specifier
 * carries the real file extension, while `tsc` rejects a `.ts` specifier unless
 * `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a protected scaffold file this
 * module may not edit) does not enable it. The directive suppresses only that extension complaint; the
 * module is still fully resolved and typed by `tsc`, so `npx tsc --noEmit` stays green alongside this
 * run. It must sit on the import's FIRST line: a multi-line import moves the complaint to the closing
 * `} from` line, where the directive no longer covers it.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { childInsertIndex, computeMovePayload, isCycleTarget, listChildIds, pointerGapIndex, projectDropSlot, type DndRow, type MovePayload, type PointerRow } from "./dnd-logic.ts";

let checks = 0;
let failures = 0;

function check(label: string, passed: boolean, detail: string = ""): void {
    checks += 1;
    const suffix = detail === "" ? "" : ` (${detail})`;
    if (passed) {
        console.log(`ok   - ${label}${suffix}`);
        return;
    }
    failures += 1;
    console.error(`FAIL - ${label}${suffix}`);
}

function sameIds(actual: readonly number[], expected: readonly number[]): boolean {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Applies a payload the way the move route would, so the read-back order can be asserted. */
function applyPayload(rows: readonly DndRow[], payload: MovePayload, activeId: number): DndRow[] {
    return rows.map((row) => {
        if (row.id === activeId) {
            return {
                ...row,
                parent_id: payload.parent_id,
                sort_order: payload.sibling_ids.indexOf(activeId),
            };
        }
        const index = payload.sibling_ids.indexOf(row.id);
        return index === -1 ? row : { ...row, sort_order: index };
    });
}

function parentOfRow(rows: readonly DndRow[], id: number): number | null {
    const row = rows.find((candidate) => candidate.id === id);
    return row === undefined ? null : row.parent_id;
}

/**
 * 1 (d0) -> 2, 3 (d1)        4 (d0) -> 5, 6 (d1)
 *
 * The same shape the mockup's fixture uses: two roots, each with two children, so a gap can be read at
 * every level without a deep tree.
 */
const rows: readonly DndRow[] = [
    { id: 1, parent_id: null, sort_order: 0 },
    { id: 2, parent_id: 1, sort_order: 0 },
    { id: 3, parent_id: 1, sort_order: 1 },
    { id: 4, parent_id: null, sort_order: 1 },
    { id: 5, parent_id: 4, sort_order: 0 },
    { id: 6, parent_id: 4, sort_order: 1 },
];

/* 1 — the cycle guard ----------------------------------------------------- */

check("a row is never its own parent", isCycleTarget(rows, 1, 1));
check("a descendant is refused as a parent", isCycleTarget(rows, 1, 2));
check("a grandchild is refused as a parent", isCycleTarget(rows, 1, 3));
check("a sibling is a legal parent", !isCycleTarget(rows, 2, 3));
check("the root is always legal", !isCycleTarget(rows, 3, null));
check("a row may move onto another branch", !isCycleTarget(rows, 2, 4));

/* 2 — child lists and the write payload ----------------------------------- */

check("root children come back in sort order", sameIds(listChildIds(rows, null), [1, 4]));
check("one parent's children, in order", sameIds(listChildIds(rows, 1), [2, 3]));
check("the moved row is already excluded", sameIds(listChildIds(rows, 1, 2), [3]));

const intoSibling = computeMovePayload(rows, 3, 1, 0);
check(
    "moving a sibling to the front of its own parent writes the full order",
    intoSibling !== null && sameIds(intoSibling.sibling_ids, [3, 2]),
    JSON.stringify(intoSibling),
);

const toRoot = computeMovePayload(rows, 2, null, 1);
check(
    "promoting a child writes the root order with it spliced in",
    toRoot !== null && toRoot.parent_id === null && sameIds(toRoot.sibling_ids, [1, 2, 4]),
    JSON.stringify(toRoot),
);

const applied = toRoot === null ? rows : applyPayload(rows, toRoot, 2);
check("the payload really re-parents the row", parentOfRow(applied, 2) === null);
check(
    "the payload really renumbers the siblings",
    applied.find((row) => row.id === 2)?.sort_order === 1 && parentOfRow(applied, 4) === null,
);

const clamped = computeMovePayload(rows, 5, 4, 99);
check(
    "a stale insert index is clamped to the end",
    clamped !== null && sameIds(clamped.sibling_ids, [6, 5]),
    JSON.stringify(clamped),
);

check("a cycle is refused rather than written", computeMovePayload(rows, 1, 2, 0) === null);

/* 3 — where the pointer is ------------------------------------------------ */

const rects = [
    { top: 100, height: 40 },
    { top: 140, height: 40 },
    { top: 180, height: 40 },
];

check("above every row is the first gap", pointerGapIndex(rects, 90) === 0);
check("just above a centre has not passed it", pointerGapIndex(rects, 119) === 0);
check("just past a centre counts the row as passed", pointerGapIndex(rects, 121) === 1);
check("between two rows resolves to the gap between them", pointerGapIndex(rects, 150) === 1);
check("below every row is the last gap", pointerGapIndex(rects, 400) === 3);
check("an empty list only has one gap", pointerGapIndex([], 400) === 0);

/* 4 — what that gap accepts ---------------------------------------------- */

/** Render order without the dragged row: 1 d0, 2 d1, 3 d1, 4 d0, 5 d1, 6 d1. */
const pointerRows: readonly PointerRow[] = [
    { id: 1, parentId: null, depth: 0 },
    { id: 2, parentId: 1, depth: 1 },
    { id: 3, parentId: 1, depth: 1 },
    { id: 4, parentId: null, depth: 0 },
    { id: 5, parentId: 4, depth: 1 },
    { id: 6, parentId: 4, depth: 1 },
];

const nestedUnderFirst = projectDropSlot({
    rows: pointerRows,
    activeDepth: 0,
    offsetX: 0,
    index: 1,
    indentWidth: 20,
});
check(
    "a gap under a root adopts its level, parented to that root",
    nestedUnderFirst.depth === 1 && nestedUnderFirst.parentId === 1,
    JSON.stringify(nestedUnderFirst),
);

const cannotOrphan = projectDropSlot({
    rows: pointerRows,
    activeDepth: 0,
    offsetX: -20,
    index: 1,
    indentWidth: 20,
});
check(
    "a gap cannot be shallower than the row below it",
    cannotOrphan.depth === 1,
    JSON.stringify(cannotOrphan),
);

const backToLevel = projectDropSlot({
    rows: pointerRows,
    activeDepth: 1,
    offsetX: 0,
    index: 3,
    indentWidth: 20,
});
check(
    "no sideways travel keeps the row at its own level, same parent",
    backToLevel.depth === 1 && backToLevel.parentId === 1,
    JSON.stringify(backToLevel),
);

const oneDeeper = projectDropSlot({
    rows: pointerRows,
    activeDepth: 1,
    offsetX: 40,
    index: 3,
    indentWidth: 20,
});
check(
    "dragging right nests under the row above",
    oneDeeper.depth === 2 && oneDeeper.parentId === 3,
    JSON.stringify(oneDeeper),
);

const toTop = projectDropSlot({
    rows: pointerRows,
    activeDepth: 1,
    offsetX: -60,
    index: 3,
    indentWidth: 20,
});
check(
    "dragging left past every level lands at the top",
    toTop.depth === 0 && toTop.parentId === null,
    JSON.stringify(toTop),
);

const deepRows: readonly PointerRow[] = [
    { id: 1, parentId: null, depth: 0 },
    { id: 2, parentId: 1, depth: 1 },
    { id: 3, parentId: 2, depth: 2 },
];
const walkedBack = projectDropSlot({
    rows: deepRows,
    activeDepth: 2,
    offsetX: -20,
    index: 3,
    indentWidth: 20,
});
check(
    "a shallower level is parented by walking back to the row that owns it",
    walkedBack.depth === 1 && walkedBack.parentId === 1,
    JSON.stringify(walkedBack),
);

const noTravelAtEnd = projectDropSlot({
    rows: deepRows,
    activeDepth: 2,
    offsetX: 0,
    index: 3,
    indentWidth: 20,
});
check(
    "the deepest row can stay where it is at the end of the list",
    noTravelAtEnd.depth === 2 && noTravelAtEnd.parentId === 2,
    JSON.stringify(noTravelAtEnd),
);

const besideOwnParent = projectDropSlot({
    rows: deepRows,
    activeDepth: 2,
    offsetX: -40,
    index: 3,
    indentWidth: 20,
});
check(
    "dragging left twice promotes two levels to the top",
    besideOwnParent.depth === 0 && besideOwnParent.parentId === null,
    JSON.stringify(besideOwnParent),
);

const emptyList = projectDropSlot({
    rows: [],
    activeDepth: 3,
    offsetX: 0,
    index: 0,
    indentWidth: 20,
});
check(
    "an empty list accepts only a root",
    emptyList.depth === 0 && emptyList.parentId === null,
    JSON.stringify(emptyList),
);

/* 5 — where it lands inside the new parent -------------------------------- */

check("the first gap is the first child slot", childInsertIndex(pointerRows, 0, null) === 0);
check(
    "the slot counts only the new parent's own children above the gap",
    childInsertIndex(pointerRows, 4, 1) === 2,
    String(childInsertIndex(pointerRows, 4, 1)),
);
check(
    "the end of the list counts every root above it",
    childInsertIndex(pointerRows, 6, null) === 2,
    String(childInsertIndex(pointerRows, 6, null)),
);

/* ------------------------------------------------------------------------- */

if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed of ${checks}.`);
    process.exit(1);
}
console.log(`\n${checks} assertions passed`);
