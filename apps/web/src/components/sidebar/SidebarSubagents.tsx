import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { RegistryContext } from "@effect/atom-react";
import {
  useContext,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";
import { threadFamilies } from "../../state/threads";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { sidebarSubagentRows, type SidebarSubagentRow } from "../Sidebar.logic";

const STATE_DOT_CLASS_NAME = { running: "bg-info", waiting: "bg-warning" } as const;

const stopRowEvent = (event: ReactMouseEvent | ReactKeyboardEvent) => event.stopPropagation();

/** "N agents" on a parent's row; a toggle for its list when `expanded` is set. */
export function SidebarSubagentCount(props: {
  readonly count: number;
  readonly live: ReadonlyArray<SidebarSubagentRow>;
  readonly expanded: boolean | null;
  readonly onToggle: () => void;
}) {
  const label = `${props.count} ${props.count === 1 ? "agent" : "agents"}`;
  const dot = props.live.some((row) => row.state === "waiting")
    ? STATE_DOT_CLASS_NAME.waiting
    : props.live.length > 0
      ? STATE_DOT_CLASS_NAME.running
      : null;
  const content = (
    <>
      {props.expanded === null ? null : (
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0", props.expanded && "rotate-90")}
        />
      )}
      {label}
      {dot === null ? null : <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />}
    </>
  );
  const className = "inline-flex shrink-0 items-center gap-1 text-xs text-secondary-label";
  if (props.expanded === null) return <span className={className}>{content}</span>;
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      aria-label={`${props.expanded ? "Hide" : "Show"} ${label}`}
      className={cn(
        className,
        "-mx-1 rounded-sm px-1 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      onDoubleClick={stopRowEvent}
      onKeyDown={stopRowEvent}
    >
      {content}
    </button>
  );
}

/** A parent's subagents under its row: its live ones, or with `all`, every active one. */
export function SidebarSubagentList(props: {
  readonly environmentId: EnvironmentId;
  readonly parentId: ThreadId;
  readonly live: ReadonlyArray<SidebarSubagentRow>;
  readonly all: boolean;
  readonly count: number;
}) {
  const { environmentId, parentId, all, count } = props;
  const registry = useContext(RegistryContext);
  // Idle children are left out of the shell; the family read the Agents panel uses has them.
  const family = useEnvironmentQuery(
    all ? threadFamilies.familyAtom(environmentId, parentId) : null,
  );
  const rows = sidebarSubagentRows(parentId, props.live, family.data?.threads ?? []);
  const readAgainFor = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a family read lasts the shell generation, so the server's count says when it missed a child
  useEffect(() => {
    if (!all || family.data == null || rows.length >= count || readAgainFor.current === count) {
      return;
    }
    readAgainFor.current = count;
    threadFamilies.refresh(registry, environmentId, parentId);
  });
  if (rows.length === 0) return null;
  return (
    <ul className="ms-4.5 mt-0.5 mb-1 border-s border-border ps-1.5">
      {rows.map((thread) => {
        const dot = thread.state === null ? null : STATE_DOT_CLASS_NAME[thread.state];
        return (
          <li key={thread.id} className="list-none">
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(environmentId, thread.id))}
              className="flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[status=active]:bg-sidebar-row-active data-[status=active]:text-sidebar-foreground"
            >
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              {dot === null ? null : (
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
