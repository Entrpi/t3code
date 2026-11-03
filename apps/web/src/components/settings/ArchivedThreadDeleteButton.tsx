import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";

/** Deletes on a second click in place: the first swaps the icon for a confirm button, with no dialog. */
export function ArchivedThreadDeleteButton(props: {
  readonly title: string;
  readonly onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="destructive-outline"
        size="icon-sm"
        aria-label={`Delete ${props.title}`}
        onClick={() => setConfirming(true)}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      autoFocus
      onBlur={() => setConfirming(false)}
      onPointerLeave={() => setConfirming(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setConfirming(false);
      }}
      onClick={() => {
        if (deleting) return;
        setDeleting(true);
        void props.onDelete().finally(() => setDeleting(false));
      }}
    >
      Confirm Permanent Delete
    </Button>
  );
}
