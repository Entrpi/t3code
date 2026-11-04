import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  subsessionState,
  subsessionTree,
  threadSubsessionState,
} from "@t3tools/client-runtime/state/subsessions";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useSubsessions, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { threadFamilies } from "../../state/threads";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/**
 * A subsession's parent session, and the thread's own open subsessions. Mobile has no Lineage
 * panel, so this is where a delegated session links back to the thread that started it.
 */
export function ThreadSubsessionsRow(props: { readonly thread: EnvironmentThreadShell }) {
  const { thread } = props;
  const known = useSubsessions({ environmentId: thread.environmentId, threadId: thread.id });
  const parentId =
    threadSubsessionState(thread.source) === "attached" ? thread.lineage.parentThreadId : null;
  const parentShell = useThreadShell(
    parentId === null ? null : { environmentId: thread.environmentId, threadId: parentId },
  );
  // Idle subsessions, a parent subsession included, are left out of the shell; the family has them.
  const family = useEnvironmentQuery(
    parentId !== null || (thread.subagentCounts?.appOwned ?? 0) > 0
      ? threadFamilies.familyAtom(thread.environmentId, thread.id)
      : null,
  );
  const familyThreads = family.data?.threads ?? [];
  const parentTitle =
    parentShell?.title ?? familyThreads.find((member) => member.id === parentId)?.title ?? null;
  const openLinkedThread = useOpenLinkedThread();
  const children = subsessionTree(
    thread.id,
    known,
    familyThreads.map((shell) => presentThreadShell(thread.environmentId, shell)),
  );
  if (parentId === null && children.length === 0) return null;
  const open = (threadId: ThreadId) =>
    openLinkedThread({ environmentId: thread.environmentId, threadId });
  return (
    <View className="flex-row items-center gap-2 pb-2 pl-4">
      <SymbolView
        name="arrow.triangle.branch"
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <View className="flex-row items-center gap-1 pr-4">
          {parentId === null ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open parent session ${parentTitle ?? ""}`.trim()}
              className="max-w-48 flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1"
              onPress={() => open(parentId)}
            >
              <SymbolView
                name="arrow.turn.left.up"
                size={11}
                tintColorClassName="accent-foreground-muted"
              />
              <Text className="shrink text-xs text-foreground" numberOfLines={1}>
                {parentTitle ?? "Parent session"}
              </Text>
            </Pressable>
          )}
          {children.length === 0 ? null : (
            <Text className="pl-1 text-xs text-foreground-muted">Subsessions</Text>
          )}
          {children.map(({ thread: child }) => {
            const state = subsessionState(child);
            return (
              <Pressable
                key={child.id}
                accessibilityRole="button"
                accessibilityLabel={`Open subsession ${child.title}${
                  state === "waiting" ? ", needs you" : state === "working" ? ", working" : ""
                }`}
                className="max-w-48 flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1"
                onPress={() => open(child.id)}
              >
                {state === null ? null : (
                  <View
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      state === "waiting" ? "bg-warning-foreground" : "bg-adaptive-sky-600-400",
                    )}
                  />
                )}
                <Text className="shrink text-xs text-foreground" numberOfLines={1}>
                  {child.title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
