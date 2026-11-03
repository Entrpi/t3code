import type { ServerProviderSkill } from "@t3tools/contracts";
import { useRef, useState } from "react";

import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { Button } from "../ui/button";

function noop() {}

/** The latest prompt's bubble while it is being edited. Saving rewinds and sends the edit. */
export function InlinePromptEditor(props: {
  readonly initialText: string;
  /** A message with attachments may be sent without words. */
  readonly allowEmpty: boolean;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly onCancel: () => void;
  readonly onSave: (text: string) => Promise<string | null>;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState(props.initialText);
  const [cursor, setCursor] = useState(props.initialText.length);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = !saving && (props.allowEmpty || prompt.trim().length > 0);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    // On success the rewind removes this message, and this editor with it.
    const failure = await props.onSave(prompt);
    if (failure === null) return;
    setSaving(false);
    setError(failure);
  };

  return (
    <div
      className="flex flex-col gap-2"
      ref={(node) => {
        if (node) requestAnimationFrame(() => editorRef.current?.focusAtEnd());
      }}
    >
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
        onPaste={noop}
      />
      {error === null ? null : <p className="text-destructive-foreground text-xs">{error}</p>}
      <div className="flex justify-end gap-1">
        <Button size="compact" variant="ghost" disabled={saving} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="compact" disabled={!canSave} onClick={() => void save()}>
          {saving ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
