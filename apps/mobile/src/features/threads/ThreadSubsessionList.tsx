import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  activeSubagentCount,
  moreUrgentSubsessionState,
  subsessionCountMisses,
  subsessionState,
  subsessionTree,
  threadSubsessionState,
  type SubsessionNode,
} from "@t3tools/client-runtime/state/subsessions";
import type { MenuAction } from "@react-native-menu/menu";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { threadFamilies } from "../../state/threads";
import { isSubsessionAction, organizeSubsession, subsessionMenuActions } from "./subsessionActions";

// Deeper subsessions stop indenting so titles keep their width on a phone.
const INDENTED_DEPTHS = 3;

const STATE_DOT = { waiting: "bg-warning-foreground", working: "bg-adaptive-sky-600-400" } as const;

const SETTLE_ACTION: MenuAction = { id: "settle", title: "Settle", image: "checkmark" };

const NO_KEYS: ReadonlyArray<string> = [];

function useCollapsedSubsessionThreads() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const collapsed = loaded ? (preferences.value.collapsedSubsessionThreads ?? NO_KEYS) : NO_KEYS;
  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggle = (key: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const keys = current.collapsedSubsessionThreads ?? NO_KEYS;
        return {
          collapsedSubsessionThreads: keys.includes(key)
            ? keys.filter((candidate) => candidate !== key)
            : [...keys, key],
        };
      },
    });
  };
  return { collapsed, toggle };
}

/** Whether a thread's subsession list is open, and the caret that opens and closes it. */
export function useSubsessionsExpanded(thread: EnvironmentThreadShell) {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const { collapsed, toggle } = useCollapsedSubsessionThreads();
  return { expanded: !collapsed.includes(key), toggle: () => toggle(key) };
}

export function SubsessionCaret(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly tintClassName?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      accessibilityLabel={`${props.expanded ? "Hide" : "Show"} ${props.count} ${
        props.count === 1 ? "subsession" : "subsessions"
      }`}
      hitSlop={10}
      onPress={props.onToggle}
      onLongPress={() => undefined}
    >
      <SymbolView
        name={props.expanded ? "chevron.down" : "chevron.right"}
        size={11}
        tintColorClassName={props.tintClassName ?? "accent-foreground-muted"}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

/** How many of a thread's own subagents are working, beside it. */
export function ActiveSubagentCount(props: { readonly thread: EnvironmentThreadShell }) {
  const count = activeSubagentCount(props.thread);
  if (count === 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={`${count} ${count === 1 ? "subagent" : "subagents"} working`}
      className="flex-row items-center gap-0.5"
    >
      <SymbolView name="person.2" size={11} tintColorClassName="accent-foreground-muted" />
      <Text className="text-xs tabular-nums text-foreground-muted">{count}</Text>
    </View>
  );
}

/** A thread's open subsessions under its row, each with its own under a caret. */
export function ThreadSubsessionList(props: {
  readonly parent: EnvironmentThreadShell;
  /** The shell's copies of the parent's subsessions at any depth. */
  readonly known: ReadonlyArray<EnvironmentThreadShell>;
  readonly count: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => unknown;
}) {
  const { parent, count } = props;
  const family = useEnvironmentQuery(threadFamilies.familyAtom(parent.environmentId, parent.id));
  const tree = subsessionTree(
    parent.id,
    props.known,
    (family.data?.threads ?? []).map((shell) => presentThreadShell(parent.environmentId, shell)),
  );
  const { collapsed, toggle } = useCollapsedSubsessionThreads();
  const misses = subsessionCountMisses(tree, parent.id, count);
  const readAgainFor = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a family read lasts the shell generation, so the server's counts say when it missed or kept a child
  useEffect(() => {
    if (family.data == null || misses === "" || readAgainFor.current === misses) return;
    readAgainFor.current = misses;
    threadFamilies.refresh(appAtomRegistry, parent.environmentId, parent.id);
  });

  const renderBranch = (nodes: ReadonlyArray<SubsessionNode>, depth: number) => (
    <View
      className={cn(
        depth === 0 && "mb-1 ml-6 border-l border-border pl-1",
        depth > 0 && depth < INDENTED_DEPTHS && "ml-3 border-l border-border pl-1",
      )}
    >
      {nodes.map(({ thread, children, descendantState }) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const expanded = !collapsed.includes(key);
        const ownState = subsessionState(thread);
        const state =
          !expanded && children.length > 0
            ? moreUrgentSubsessionState(ownState, descendantState)
            : ownState;
        return (
          <View key={thread.id}>
            <Menu
              actions={[
                SETTLE_ACTION,
                ...subsessionMenuActions(threadSubsessionState(thread.source)),
              ]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "settle") void props.onSettleThread(thread);
                if (isSubsessionAction(nativeEvent.event)) {
                  void organizeSubsession(thread, nativeEvent.event);
                }
              }}
              shouldOpenOnLongPress
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open subsession ${thread.title}${
                  state === "waiting" ? ", needs you" : state === "working" ? ", working" : ""
                }`}
                className="min-h-9 flex-row items-center gap-2 rounded-lg px-3 py-1.5"
                onPress={() => props.onSelectThread(thread)}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                {state === null ? null : (
                  <View className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_DOT[state])} />
                )}
                <Text className="flex-1 text-sm text-foreground-muted" numberOfLines={1}>
                  {thread.title}
                </Text>
                {children.length > 0 ? (
                  <SubsessionCaret
                    count={children.length}
                    expanded={expanded}
                    onToggle={() => toggle(key)}
                  />
                ) : null}
                <ActiveSubagentCount thread={thread} />
                <Text className="text-xs tabular-nums text-foreground-tertiary">
                  <RelativeTime timestamp={thread.latestUserMessageAt ?? thread.updatedAt} />
                </Text>
              </Pressable>
            </Menu>
            {children.length > 0 && expanded ? renderBranch(children, depth + 1) : null}
          </View>
        );
      })}
    </View>
  );
  if (tree.length === 0) return null;
  return renderBranch(tree, 0);
}
