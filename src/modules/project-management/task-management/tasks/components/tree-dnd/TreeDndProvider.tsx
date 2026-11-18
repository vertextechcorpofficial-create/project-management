"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { GripVertical } from "lucide-react";

import { flattenVisible, type TreeNode } from "../../utils/tree";
import { type MoveTaskInput } from "@/modules/project-management/task-management/tasks/types/pm-task.schema";

import { TITLE_CHROME_PX, TITLE_MIN_TEXT_PX, type TaskRowView } from "../TaskRow";
import {
    childInsertIndex,
    computeMovePayload,
    pointerGapIndex,
    projectDropSlot,
    type DndRow,
    type PointerRow,
} from "./dnd-logic";

/** Pixels of sideways travel that mean one level. Mirrors `INDENT_STEP_PX` in `TaskRow`. */
const DRAG_INDENT_WIDTH = 20;

/** Where the drop line starts inside the row indent, in pixels — the mockup's 8px inset. */
const DROP_LINE_INSET_PX = 8;

/** Travel that separates a click from a drag, in pixels â€” the interactive elements stay clickable. */
const DRAG_THRESHOLD_PX = 5;

/** Stable identity for "nothing is hidden", so an idle list never re-renders a new Set. */
const EMPTY_ID_SET: ReadonlySet<number> = new Set();

/** Everything a row needs to know about the drag currently in flight. */
export interface TreeDndContextValue {
    /**
     * The row being dragged, or `null` when no drag is active. It KEEPS its slot while it moves (the
     * mockup's ghost, dimmed to 40%) so the rows around it never jump, and its descendants leave the
     * list for the duration of the drag.
     */
    readonly activeId: number | null;
    /** Where the drop line sits, in pixels from the list's top-left corner, or `null` when idle. */
    readonly line: { readonly top: number; readonly left: number } | null;
    /** The dragged row and its descendants — the rows that travel with it. */
    readonly hiddenIds: ReadonlySet<number>;
    /** True while a filter or search is active; dragging is off and no drop is emitted. */
    readonly isReorderDisabled: boolean;
    /** The page's flat row set — hidden rows included, so the payload sees the whole tree. */
    readonly rows: readonly DndRow[];
}
const TreeDndContext = createContext<TreeDndContextValue | null>(null);

/** The drag state for the nearest `TreeDndProvider`. Throws when used outside one. */
export function useTreeDnd(): TreeDndContextValue {
    const value = useContext(TreeDndContext);
    if (value === null) {
        throw new Error("useTreeDnd must be used inside a TreeDndProvider");
    }
    return value;
}

export interface TreeDndProviderProps {
    /** The department's forest from `buildTree` â€” the provider derives the flat set itself. */
    roots: readonly TreeNode<TaskRowView>[];
    /** Ids whose children are currently shown; the pointer model follows the visible rows. */
    expandedIds: ReadonlySet<number>;
    /**
     * Called with the moved row's id and the pinned `{ parent_id, sibling_ids }` payload when a drop
     * settles. The id is part of the contract because the move route is addressed by the moved node
     * (`PATCH /tasks/<id>/move`) while the payload describes its destination â€” including a new
     * `parent_id` when the drag re-parented.
     */
    onMove?: (activeId: number, payload: MoveTaskInput) => void;
    /**
     * The department's COMPLETE flat row set â€” every root, across every page. Used for the payload's
     * `sibling_ids`, and defaults to the rows under `roots`.
     */
    allRows?: readonly DndRow[];
    /** Disables dragging â€” set while a filter or search is active. */
    reorderDisabled?: boolean;
    /** Overrides the chip that follows the pointer; defaults to a compact grip + title card. */
    renderOverlay?: (node: TreeNode<TaskRowView>) => ReactNode;
    children: ReactNode;
}

/** Pre-order walk over the WHOLE forest â€” collapsed rows stay in the payload's view. */
function collectAllRows<T extends DndRow>(roots: readonly TreeNode<T>[]): TreeNode<T>[] {
    const collected: TreeNode<T>[] = [];
    const stack: TreeNode<T>[] = [...roots];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) continue;
        collected.push(node);
        for (const child of node.children) stack.push(child);
    }
    return collected;
}

/** The pointer gesture currently in flight. Plain refs: a move must not wait for a render. */
interface DragGesture {
    readonly id: number;
    readonly startX: number;
    readonly startY: number;
    /** The row's depth when it was picked up. Sideways travel is added to this. */
    readonly depth: number;
    /**
     * The row and everything under it. Held from the grab (not read from state) because the first
     * pointer move resolves BEFORE the list has re-rendered without the subtree: without this the
     * dragged row would still count as one of its own neighbours for that frame, shifting the gap and
     * the level by one.
     */
    readonly hiddenIds: ReadonlySet<number>;
    started: boolean;
}

/** A row plus its descendants, walked over the page's complete flat set. */
function collectSubtreeIds(rows: readonly DndRow[], rootId: number): ReadonlySet<number> {
    const childrenByParent = new Map<number, number[]>();
    for (const row of rows) {
        if (row.parent_id === null) continue;
        const siblings = childrenByParent.get(row.parent_id);
        if (siblings === undefined) childrenByParent.set(row.parent_id, [row.id]);
        else siblings.push(row.id);
    }
    const ids = new Set<number>([rootId]);
    const stack = [rootId];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) continue;
        for (const child of childrenByParent.get(current) ?? []) {
            if (ids.has(child)) continue;
            ids.add(child);
            stack.push(child);
        }
    }
    return ids;
}

/**
 * Drag-and-drop for the task tree, ported from the reference mockup (`pm/drag&drop/task-dnd-preview.html`).
 *
 * The model is the mockup's, and it is deliberately NOT dnd-kit's sortable model:
 * - A row is picked up by pressing anywhere on it (touch must start on the grip so the list still
 *   scrolls), and the drag begins after 5px of travel, so a plain click still opens the task.
 * - While dragging, the picked-up row is REMOVED from the list together with its descendants. The rows
 *   around it close up; nothing is displaced, no ghost keeps a slot, and the neighbours a drop is
 *   clamped against are the ones the drop would actually leave behind.
 * - The pointer's vertical position picks the GAP, measured against row centres; its horizontal travel
 *   picks the LEVEL (`offsetX / 20px`), clamped by the rows either side of that gap. One drop line
 *   sits IN the gap, from `depth Ã— 20 + 8` to the right edge â€” its length is the level.
 * - A chip follows the pointer (+12/+8) with the task's name. One sentence under the list says what
 *   the drop would do.
 * - Escape and `pointercancel` abandon without a write; the row regains focus after a drop.
 */
export function TreeDndProvider({
    roots,
    expandedIds,
    onMove,
    allRows,
    reorderDisabled = false,
    renderOverlay,
    children,
}: TreeDndProviderProps) {
    const [activeId, setActiveId] = useState<number | null>(null);
    const [line, setLine] = useState<{ top: number; left: number } | null>(null);
    const [hintParentId, setHintParentId] = useState<number | null>(null);
    const [chip, setChip] = useState<{ x: number; y: number } | null>(null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    /** Last pointer position, so a scroll can re-place the line without waiting for a new move. */
    const pointerRef = useRef<{ x: number; y: number } | null>(null);
    const gestureRef = useRef<DragGesture | null>(null);
    const payloadRef = useRef<MoveTaskInput | null>(null);

    const pageRows = useMemo(() => collectAllRows(roots), [roots]);
    const computationRows = useMemo<readonly DndRow[]>(
        () => allRows ?? pageRows,
        [allRows, pageRows],
    );

    /**
     * The rows on screen, in render order. Collapsed subtrees are absent on purpose: a drag positions
     * against what the user can see.
     */
    const visibleNodes = useMemo(() => flattenVisible(roots, expandedIds), [roots, expandedIds]);

    /**
     * The dragged row and its descendants, removed for the duration of the drag â€” the mockup's
     * `visible()` skip. The subtree is identified from the page's rows, so a collapsed child that is
     * not on screen still travels with its parent.
     */
    const hiddenIds = useMemo<ReadonlySet<number>>(() => {
        if (activeId === null) return EMPTY_ID_SET;
        const hidden = new Set<number>([activeId]);
        const stack = [activeId];
        const childrenByParent = new Map<number, number[]>();
        for (const row of computationRows) {
            if (row.parent_id === null) continue;
            const siblings = childrenByParent.get(row.parent_id);
            if (siblings === undefined) childrenByParent.set(row.parent_id, [row.id]);
            else siblings.push(row.id);
        }
        while (stack.length > 0) {
            const current = stack.pop();
            if (current === undefined) continue;
            for (const child of childrenByParent.get(current) ?? []) {
                if (hidden.has(child)) continue;
                hidden.add(child);
                stack.push(child);
            }
        }
        return hidden;
    }, [activeId, computationRows]);

    /** The rows the user sees while dragging: render order minus the dragged subtree. */
    const nodesById = useMemo(() => {
        const byId = new Map<number, TreeNode<TaskRowView>>();
        for (const node of pageRows) byId.set(node.id, node);
        return byId;
    }, [pageRows]);

    const depthById = useMemo(() => {
        const depths = new Map<number, number>();
        for (const node of visibleNodes) depths.set(node.id, node.depth);
        return depths;
    }, [visibleNodes]);

    const parentById = useMemo(() => {
        const parents = new Map<number, number | null>();
        for (const node of visibleNodes) parents.set(node.id, node.parent_id);
        return parents;
    }, [visibleNodes]);

    const reset = useCallback(() => {
        gestureRef.current = null;
        payloadRef.current = null;
        setActiveId(null);
        setLine(null);
        setHintParentId(null);
        setChip(null);
    }, []);

    /**
     * One resolution per pointer move: the line, the hint and the emitted payload all come from this,
     * so what the user sees is exactly what a drop writes.
     */
    const resolveAt = useCallback(
        (clientX: number, clientY: number) => {
            const container = containerRef.current;
            const gesture = gestureRef.current;
            if (container === null || gesture === null) return;

            const elements = Array.from(
                container.querySelectorAll<HTMLElement>("tr[data-task-id]"),
            ).filter((element) => !gesture.hiddenIds.has(Number(element.dataset.taskId)));
            const rects = elements.map((element) => element.getBoundingClientRect());
            const index = pointerGapIndex(rects, clientY);

            // The list is read from the DOM, not from the provider's own flatten: the tree renders a
            // page, so only the rows on screen are rows the pointer can reach. The dragged subtree is
            // gone from it, exactly as a drop would leave the list.
            const projectionRows: PointerRow[] = elements.map((element) => {
                const id = Number(element.dataset.taskId);
                return {
                    id,
                    parentId: parentById.get(id) ?? null,
                    depth: depthById.get(id) ?? 0,
                };
            });

            const projection = projectDropSlot({
                rows: projectionRows,
                activeDepth: gesture.depth,
                offsetX: clientX - gesture.startX,
                index,
                indentWidth: DRAG_INDENT_WIDTH,
            });

            const insertAt = childInsertIndex(projectionRows, projection.index, projection.parentId);
            const payload = computeMovePayload(
                computationRows,
                gesture.id,
                projection.parentId,
                insertAt,
            );

            payloadRef.current = payload;

            /*
             * The line is a child of the LIST, not of a row: it sits IN the gap and reaches to the
             * right edge, exactly as the mockup appends its `.line` to the list element. Its top is the
             * bottom edge of the row above the gap (0 at the top of the list); its left is the
             * projected level's indent inside the title cell, so the line's start reads as the depth.
             */
            const listRect = container.getBoundingClientRect();
            const anchorBottom = index === 0 ? 0 : (rects[index - 1]?.bottom ?? 0) - listRect.top;
            const titleCell = container.querySelector<HTMLElement>(
                `tr[data-task-id="${gesture.id}"] [data-slot="task-title-cell"]`,
            );
            const titleRect = titleCell?.getBoundingClientRect();
            const titleLeft = titleRect === undefined ? 0 : titleRect.left - listRect.left;
            const titleWidth = titleRect?.width ?? 0;

            setLine({
                top: anchorBottom,
                left:
                    titleLeft +
                    Math.min(
                        projection.depth * DRAG_INDENT_WIDTH,
                        Math.max(0, titleWidth - (TITLE_CHROME_PX + TITLE_MIN_TEXT_PX)),
                    ) +
                    DROP_LINE_INSET_PX,
            });
            setHintParentId(projection.parentId);
            setChip({ x: clientX + 12, y: clientY + 8 });
        },        [computationRows, parentById, depthById],
    );

    const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (reorderDisabled || event.button !== 0) return;

        const target = event.target as HTMLElement;
        if (target.closest("button, input, textarea, select, a, [role='combobox']") !== null) return;

        const row = target.closest<HTMLElement>("tr[data-task-id]");
        if (row === null) return;
        // Touch drags start on the grip only, so a swipe still scrolls the list.
        if (
            event.pointerType === "touch" &&
            target.closest('[data-slot="task-tree-drag-handle"]') === null
        ) {
            return;
        }

        const id = Number(row.dataset.taskId);
        const depth = depthById.get(id);
        if (depth === undefined) return;

        // The press belongs to the list: stop the browser from starting a text selection that would
        // follow the pointer instead of the row. Clicks still fire, so a plain click still opens the task.
        event.preventDefault();

        gestureRef.current = {
            id,
            startX: event.clientX,
            startY: event.clientY,
            depth,
            hiddenIds: collectSubtreeIds(computationRows, id),
            started: false,
        };
    }, [computationRows, depthById, reorderDisabled]);

    useEffect(() => {
        const finish = (commit: boolean) => {
            const gesture = gestureRef.current;
            if (gesture === null) return;
            const payload = payloadRef.current;
            const moved = commit && gesture.started ? payload : null;
            reset();
            if (moved === null) return;
            onMove?.(gesture.id, moved);
            requestAnimationFrame(() => {
                document.querySelector<HTMLElement>(`tr[data-task-id="${gesture.id}"]`)?.focus();
            });
        };

        const handleMove = (event: PointerEvent) => {
            const gesture = gestureRef.current;
            if (gesture === null) return;
            // A held pointer reports `button === -1` on every move (no button changed state), so the
            // held state has to be read from `buttons`. `button` is only meaningful on pointerdown.
            if (event.buttons === 0) {
                finish(false);
                return;
            }

            if (!gesture.started) {
                const travelled = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
                if (travelled < DRAG_THRESHOLD_PX) return;
                gesture.started = true;
                setActiveId(gesture.id);
            }

            pointerRef.current = { x: event.clientX, y: event.clientY };
            resolveAt(event.clientX, event.clientY);
        };

        const handlePointerUp = () => finish(true);
        const handlePointerCancel = () => finish(false);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && gestureRef.current !== null) finish(false);
        };

        const handleScroll = () => {
            const pointer = pointerRef.current;
            if (pointer === null || gestureRef.current === null) return;
            resolveAt(pointer.x, pointer.y);
        };

        window.addEventListener("pointermove", handleMove);
        window.addEventListener("scroll", handleScroll, true);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerCancel);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("scroll", handleScroll, true);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerCancel);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [reset, resolveAt, onMove]);

    const contextValue = useMemo<TreeDndContextValue>(
        () => ({
            activeId,
            line,
            hiddenIds,
            isReorderDisabled: reorderDisabled,
            rows: computationRows,
        }),
        [
            activeId,
            line,
            hiddenIds,
            reorderDisabled,
            computationRows,
        ],
    );

    const activeNode = activeId === null ? null : (nodesById.get(activeId) ?? null);

    /** What the drop would do right now, in the mockup's words. `null` while dragging is disabled. */
    const hint =
        activeId === null
            ? reorderDisabled
                ? null
                : "Drag a row to reorder. Drag right to nest, left to move out."
            : hintParentId === null
              ? "Will be a top-level task"
              : `Will become a subtask of "${nodesById.get(hintParentId)?.title ?? "another task"}"`;

    return (
        <div
            ref={containerRef}
            onPointerDown={handlePointerDown}
            data-slot="task-tree-dnd"
            className="relative"
        >
            <TreeDndContext.Provider value={contextValue}>
                {children}
                {line === null ? null : (
                    <span
                        aria-hidden="true"
                        data-slot="task-drop-line"
                        style={{ top: line.top, left: line.left }}
                        className="pointer-events-none absolute right-0 z-20 h-0.5 rounded-full bg-primary transition-[left] duration-100"
                    >
                        <span className="absolute -top-[3px] -left-1 size-2 rounded-full border-2 border-primary bg-background" />
                    </span>
                )}
                {hint === null ? null : (
                    <p
                        data-slot="task-dnd-hint"
                        aria-live="polite"
                        className="mt-1 px-3 pb-2 text-xs text-muted-foreground"
                    >
                        {hint}
                    </p>
                )}
            </TreeDndContext.Provider>

            {chip === null || activeNode === null || typeof document === "undefined"
                ? null
                : createPortal(
                      <div
                          data-slot="task-drag-overlay"
                          style={{ left: chip.x, top: chip.y }}
                          className="pointer-events-none fixed z-50 flex max-w-[240px] items-center gap-1.5 rounded-md border border-border/60 bg-card px-2.5 py-1.5 shadow-lg"
                      >
                          {renderOverlay?.(activeNode) ?? <TaskDragCard node={activeNode} />}
                      </div>,
                      document.body,
                  )}
        </div>
    );
}

function TaskDragCard({ node }: { node: TreeNode<TaskRowView> }) {
    return (
        <>
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-sm font-medium">{node.title}</span>
        </>
    );
}
