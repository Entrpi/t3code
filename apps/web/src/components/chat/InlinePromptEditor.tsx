import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { dropRemovedAttachmentContext } from "@t3tools/shared/composerContextReferences";
import { useEffect, useRef, useState } from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  inheritComposerImageThumbnail,
  prepareImageForAttachment,
} from "../../lib/imageCompression";
import { releaseDraftAttachment } from "../../lib/attachmentUploadQueue";
import { randomUUID } from "~/lib/utils";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { Button } from "../ui/button";
import { ComposerAttachButton, ComposerQueuedAttachmentRow } from "./ComposerAttachmentStrip";
import {
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

export interface InlineEditAttachments {
  /** The message's own attachments the edit keeps. */
  readonly kept: ReadonlyArray<ChatAttachment>;
  readonly added: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
}

async function prepareAddedAttachment(
  file: File,
): Promise<ComposerImageAttachment | ComposerFileAttachment | string> {
  const kind = classifyComposerAttachmentFile(file);
  if (kind === "unsupported-image") {
    return `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
  }
  if (file.size <= 0) return `'${file.name}' is empty or could not be read.`;
  if (kind === "file") {
    return {
      type: "file",
      id: randomUUID(),
      name: file.name,
      mimeType: composerFileAttachmentMimeType(file),
      sizeBytes: file.size,
      file,
    };
  }
  const normalized = normalizeComposerImageFileMimeType(file);
  const prepared = await prepareImageForAttachment(
    normalized,
    PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ).catch(() => ({ ok: false, reason: "unreadable" }) as const);
  if (!prepared.ok) {
    return prepared.reason === "unreadable"
      ? `'${file.name}' could not be read as an image.`
      : `'${file.name}' is too large to attach, even after compression.`;
  }
  inheritComposerImageThumbnail(normalized, prepared.file);
  return {
    type: "image",
    id: randomUUID(),
    name: prepared.file.name,
    mimeType: prepared.file.type,
    sizeBytes: prepared.file.size,
    file: prepared.file,
    previewUrl: URL.createObjectURL(prepared.file),
  };
}

/** The latest prompt's bubble while it is being edited. Saving rewinds and sends the edit. */
export function InlinePromptEditor(props: {
  readonly initialText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context: OrchestrationMessageContext | undefined;
  readonly attachmentPreviewUrl: (attachmentId: string) => string | null;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly onCancel: () => void;
  readonly onSave: (text: string, attachments: InlineEditAttachments) => Promise<string | null>;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState(props.initialText);
  const [cursor, setCursor] = useState(props.initialText.length);
  const [kept, setKept] = useState(props.attachments);
  const [added, setAdded] = useState<
    ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>
  >([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Added files outlive React state: their preview URLs, and their uploads unless a save holds them.
  const [owned] = useState(
    () => new Map<string, ComposerImageAttachment | ComposerFileAttachment>(),
  );
  const savingRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases added files' preview URLs and uploads on close
  useEffect(
    () => () => {
      for (const attachment of owned.values()) {
        if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
        if (!savingRef.current) releaseDraftAttachment(attachment);
      }
    },
    [owned],
  );
  const attachmentCount = kept.length + added.length;
  const canSave = !saving && !adding && (attachmentCount > 0 || prompt.trim().length > 0);

  const addFiles = async (files: ReadonlyArray<File>) => {
    if (files.length === 0 || saving) return false;
    setError(null);
    setAdding(true);
    const room = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - attachmentCount;
    const next: Array<ComposerImageAttachment | ComposerFileAttachment> = [];
    let failure: string | null =
      files.length > room
        ? `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`
        : null;
    for (const file of files.slice(0, Math.max(0, room))) {
      const prepared = await prepareAddedAttachment(file);
      if (typeof prepared === "string") {
        failure = prepared;
        continue;
      }
      owned.set(prepared.id, prepared);
      next.push(prepared);
    }
    setAdded((current) => [...current, ...next]);
    setAdding(false);
    setError(failure);
    return false;
  };

  const remove = (attachmentId: string) => {
    const addedAttachment = owned.get(attachmentId);
    if (addedAttachment !== undefined) {
      owned.delete(attachmentId);
      if (addedAttachment.type === "image") URL.revokeObjectURL(addedAttachment.previewUrl);
      releaseDraftAttachment(addedAttachment);
      setAdded((current) => current.filter((attachment) => attachment.id !== attachmentId));
      return;
    }
    const nextKept = kept.filter((attachment) => attachment.id !== attachmentId);
    const nextPrompt = dropRemovedAttachmentContext(
      prompt,
      props.context,
      new Set(nextKept.map((attachment) => attachment.id)),
    ).text;
    setKept(nextKept);
    setPrompt(nextPrompt);
    setCursor(Math.min(cursor, nextPrompt.length));
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    savingRef.current = true;
    setError(null);
    // Null means the edit left this editor: it was sent, or it waits in the queue.
    const failure = await props.onSave(prompt, { kept, added });
    if (failure === null) {
      props.onCancel();
      return;
    }
    savingRef.current = false;
    setSaving(false);
    setError(failure);
  };

  return (
    <div
      className="flex flex-col gap-2"
      ref={(node) => {
        if (node) requestAnimationFrame(() => editorRef.current?.focusAtEnd());
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDropCapture={(event) => {
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void addFiles(files);
      }}
    >
      {attachmentCount > 0 ? (
        <ComposerQueuedAttachmentRow
          attachments={[
            ...kept.map((attachment) => ({
              attachment,
              url: attachment.type === "image" ? props.attachmentPreviewUrl(attachment.id) : null,
            })),
            ...added.map((attachment) => ({
              attachment,
              url: attachment.type === "image" ? attachment.previewUrl : null,
            })),
          ]}
          onRemove={remove}
        />
      ) : null}
      <ComposerPromptEditor
        ariaLabel="Edit message"
        editorRef={editorRef}
        value={prompt}
        cursor={cursor}
        contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
        skills={props.skills}
        disabled={saving}
        placeholder="Message"
        className="max-h-80"
        onChange={(nextValue, nextCursor) => {
          setPrompt(nextValue);
          setCursor(nextCursor);
        }}
        onCommandKeyDown={(key, event) => {
          if (key === "Escape") {
            if (!saving) props.onCancel();
            return true;
          }
          if (key === "Enter" && (event.metaKey || event.ctrlKey)) {
            void save();
            return true;
          }
          return false;
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (
            files.length === 0 ||
            !shouldHandleComposerAttachmentPaste({
              files,
              plainText: event.clipboardData.getData("text/plain"),
            })
          ) {
            return;
          }
          event.preventDefault();
          void addFiles(files);
        }}
      />
      {error === null ? null : <p className="text-destructive-foreground text-xs">{error}</p>}
      <div className="flex items-center gap-1">
        <ComposerAttachButton
          addComposerAttachments={addFiles}
          focusComposer={() => editorRef.current?.focusAtEnd()}
        />
        <div className="ms-auto flex gap-1">
          <Button size="compact" variant="ghost" disabled={saving} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="compact" disabled={!canSave} onClick={() => void save()}>
            {saving ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
