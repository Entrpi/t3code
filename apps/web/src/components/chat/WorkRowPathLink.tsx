import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { MouseEvent, ReactNode } from "react";

import { openInEditorMenuLabel } from "../../editorLabels";
import { useOpenInPreferredEditor, usePreferredEditor } from "../../editorPreferences";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { useRemoteOpenResolution } from "../../remoteOpen";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { revealInFileManagerLabelForConfig } from "../preview/fileExplorerLabel";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { canUseMarkdownFileShellActions } from "./MarkdownFileLink.logic";

const NO_EDITORS: ReadonlyArray<EditorId> = [];

const stopRowToggle = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** A path in a work row: click opens it, hover shows the full path, right-click offers path actions. */
export function WorkRowPathLink(props: {
  path: string;
  workspaceRoot: string | undefined;
  environmentId: EnvironmentId;
  /** False for a file that no longer exists, which keeps only the copy actions. */
  opens: boolean;
  tooltip: boolean;
  children: ReactNode;
}) {
  const { environmentId } = props;
  const absolutePath = props.workspaceRoot
    ? resolvePathLinkTarget(props.path, props.workspaceRoot)
    : props.path;
  const relativePath = workspaceRelativeFilePath(absolutePath, props.workspaceRoot);
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const availableEditors = serverConfig?.availableEditors ?? NO_EDITORS;
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const canUseShell =
    props.opens &&
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const revealLabel = canUseShell ? revealInFileManagerLabelForConfig(serverConfig) : undefined;

  const reportFailure = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    toastManager.add(stackedThreadToast({ type: "error", title, description: absolutePath }));
  };
  const open = () =>
    void openInPreferredEditor(absolutePath).then(reportFailure("Unable to open file"));
  const reveal = () =>
    void openInEditor({
      environmentId,
      input: { cwd: absolutePath, editor: "file-manager", reveal: true },
    }).then(reportFailure("Unable to reveal file"));
  const copy = (value: string, title: string) =>
    void writeTextToClipboard(value, title.toLowerCase()).then(
      () => toastManager.add({ type: "success", title: `${title} copied`, description: value }),
      () =>
        toastManager.add(
          stackedThreadToast({ type: "error", title: `Failed to copy ${title.toLowerCase()}` }),
        ),
    );

  const showMenu = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        ...(canUseShell ? [{ id: "open", label: openInEditorMenuLabel(preferredEditor) }] : []),
        ...(revealLabel ? [{ id: "reveal", label: revealLabel }] : []),
        ...(relativePath ? [{ id: "copy-relative", label: "Copy relative path" }] : []),
        { id: "copy-full", label: "Copy full path" },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "open") open();
    else if (clicked === "reveal") reveal();
    else if (clicked === "copy-relative" && relativePath) copy(relativePath, "Relative path");
    else if (clicked === "copy-full") copy(absolutePath, "Full path");
  };

  const link = canUseShell ? (
    <button
      type="button"
      data-work-row-path
      className="inline cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      onContextMenu={showMenu}
      onKeyDown={stopRowToggle}
    >
      {props.children}
    </button>
  ) : (
    <span data-work-row-path onContextMenu={showMenu}>
      {props.children}
    </span>
  );
  if (!props.tooltip) return link;
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipPopup side="top" variant="code" interactive>
        {absolutePath}
      </TooltipPopup>
    </Tooltip>
  );
}
