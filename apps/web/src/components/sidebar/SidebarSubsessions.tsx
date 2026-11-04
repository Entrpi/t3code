import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { BotIcon, CheckIcon, ChevronRightIcon } from "lucide-react";
import {
  useContext,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";
import { useDetachThread } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { readEnvironmentScope } from "../../state/session";
import { threadFamilies } from "../../state/threads";
import { useUiStateStore } from "../../uiStateStore";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import {
  activeSidebarSubagentCount,
  moreUrgentSubsessionState,
  sidebarSubsessionState,
  sidebarSubsessionTree,
  type SidebarSubsessionNode,
} from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RelativeTimeLabel, threadTimeTimestamp } from "./SidebarRelativeTime";

const stopRowEvent = (event: ReactMouseEvent | ReactKeyboardEvent) => event.stopPropagation();

/** How many of a session's subagents are working or waiting, beside that session. */
export function SidebarActiveSubagents(props: { readonly count: number }) {
  if (props.count === 0) return null;
  const label = `${props.count} ${props.count === 1 ? "subagent" : "subagents"} working`;
  return (
    <span
      role="img"
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-secondary-label"
    >
      <BotIcon aria-hidden className="size-3" />
      {props.count}
    </span>
  );
}

/** The caret on a thread's card that opens and closes its subsession list. */
export function SidebarSubsessionsToggle(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const label = `${props.expanded ? "Hide" : "Show"} ${props.count} ${
    props.count === 1 ? "subsession" : "subsessions"
  }`;
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      aria-label={label}
      className="relative -mx-1 inline-flex shrink-0 items-center rounded-sm px-1 text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      onDoubleClick={stopRowEvent}
      onKeyDown={stopRowEvent}
    >
      <ChevronRightIcon aria-hidden className={cn("size-3.5", props.expanded && "rotate-90")} />
    </button>
  );
}

// Deeper subsessions stop indenting so titles keep their width in a narrow sidebar.
const INDENTED_DEPTHS = 3;

const SUBSESSION_DOT = { waiting: "bg-warning", working: "bg-info" } as const;

const familyMisses = (
  nodes: ReadonlyArray<SidebarSubsessionNode>,
  parentId: ThreadId,
  expected: number,
): string[] => [
  ...(nodes.length === expected ? [] : [`${parentId}:${expected}`]),
  ...nodes.flatMap((node) =>
    familyMisses(
      node.children,
      node.thread.id,
      node.thread.subagentCounts?.appOwned ?? node.children.length,
    ),
  ),
];

/** A thread's open subsessions under its card, each with its own under a caret. */
export function SidebarSubsessionList(props: {
  readonly environmentId: EnvironmentId;
  readonly parentId: ThreadId;
  /** The shell's copies of this thread's subsessions at any depth; idle ones come from the family read. */
  readonly known: ReadonlyArray<SidebarThreadSummary>;
  readonly count: number;
  readonly onSettle: (threadRef: ScopedThreadRef) => void;
}) {
  const { environmentId, parentId, count } = props;
  const registry = useContext(RegistryContext);
  const family = useEnvironmentQuery(threadFamilies.familyAtom(environmentId, parentId));
  const tree = sidebarSubsessionTree(
    parentId,
    props.known,
    (family.data?.threads ?? []).map((shell) => presentThreadShell(environmentId, shell)),
  );
  const collapsedKeys = useUiStateStore((state) => state.collapsedSubsessionThreadKeys);
  const setSubsessionsCollapsed = useUiStateStore((state) => state.setSubsessionsCollapsed);
  const misses = familyMisses(tree, parentId, count).join(",");
  const readAgainFor = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a family read lasts the shell generation, so the server's counts say when it missed or kept a child
  useEffect(() => {
    if (family.data == null || misses === "" || readAgainFor.current === misses) return;
    readAgainFor.current = misses;
    threadFamilies.refresh(registry, environmentId, parentId);
  });
  const detachThread = useDetachThread();
  const openRowMenu = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readLocalApi();
    if (!api) return;
    const canOperate = readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
    void (async () => {
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "settle", label: "Settle thread", icon: "circle-check", disabled: !canOperate },
            { id: "detach", label: "Detach to top level", icon: "unlink", disabled: !canOperate },
          ],
          { x: event.clientX, y: event.clientY },
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value === "settle") props.onSettle(threadRef);
      if (clicked.value !== "detach") return;
      const result = await detachThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to detach thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const renderBranch = (nodes: ReadonlyArray<SidebarSubsessionNode>, depth: number) => (
    <ul
      className={cn(
        depth === 0 && "ms-4.5 mt-0.5 mb-1 border-s border-border ps-1.5",
        depth > 0 && depth < INDENTED_DEPTHS && "ms-3 border-s border-border ps-1.5",
      )}
    >
      {nodes.map(({ thread, children, descendantState }) => {
        const threadRef = scopeThreadRef(environmentId, thread.id);
        const threadKey = scopedThreadKey(threadRef);
        const collapsed = collapsedKeys.includes(threadKey);
        const ownState = sidebarSubsessionState(thread);
        const state =
          collapsed && children.length > 0
            ? moreUrgentSubsessionState(ownState, descendantState)
            : ownState;
        return (
          <li key={thread.id} className="list-none">
            <div
              onContextMenu={(event) => openRowMenu(event, threadRef)}
              className="group/subsession relative flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground has-[[data-status=active]]:bg-sidebar-row-active has-[[data-status=active]]:text-sidebar-foreground"
            >
              {state === null ? null : (
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", SUBSESSION_DOT[state])}
                />
              )}
              {/* The link's overlay makes the whole row clickable around the caret. */}
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(threadRef)}
                className="min-w-0 flex-1 truncate after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
              >
                {thread.title}
              </Link>
              {children.length > 0 ? (
                <SidebarSubsessionsToggle
                  count={children.length}
                  expanded={!collapsed}
                  onToggle={() => setSubsessionsCollapsed(threadKey, !collapsed)}
                />
              ) : null}
              <SidebarActiveSubagents count={activeSidebarSubagentCount(thread)} />
              <span className="shrink-0 tabular-nums group-hover/subsession:invisible">
                <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Settle thread"
                      onClick={() => props.onSettle(threadRef)}
                      className="pointer-events-none absolute inset-y-0 right-0 inline-flex items-center rounded-md px-2 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/subsession:pointer-events-auto group-hover/subsession:opacity-100"
                    />
                  }
                >
                  <CheckIcon aria-hidden className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Settle thread</TooltipPopup>
              </Tooltip>
            </div>
            {children.length > 0 && !collapsed ? renderBranch(children, depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );
  if (tree.length === 0) return null;
  return renderBranch(tree, 0);
}
