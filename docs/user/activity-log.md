# Activity log

On web and desktop, consecutive tool calls appear as an expandable summary. Open it to inspect
commands, tool inputs, status, and exit codes. Expand a tool call to see its output. A running
command's output updates live, and long output shows only its most recent part. Use **Open diff** on
a file change to review its contents.

Each changed file gets its own row that says **Created**, **Edited**, **Deleted** or **Moved**.
Line counts appear when the turn ends. A shell command that writes to a file says **Wrote** while
the turn runs, because the command alone does not show whether the file is new. When the turn ends,
the row says **Created** or **Edited**. Simple shell reads and searches show as **Read** and
**Searched** rows. A command that chains several steps stays one row, such as **Chained command with
1 file created, 2 files deleted**. Hover a row that names what a command did to see the command, or
expand it.

T3 Orchestrator summaries describe the actions taken, such as **Ran 2 commands and sent messages
to 3 threads**. Repeated messages to the same destinations show both counts: **Sent 5 messages to
2 threads**. Thread creation counts the threads returned by the tool, including batches.

A group's summary names each kind of action in the order it happened, such as **Inspected 2 files,
created 1 file, and ran 1 command**, with the number of steps beside it. File changes, deletions
and commits are highlighted, and a turn's commits also show on its changed files. While a turn
runs, its newest work stays open; earlier work folds into a summary when the agent replies. Expand
a summary for the full list.

Failed calls do not count as successful messages or creations. Waiting on a thread does not mean
it finished, and an interrupt or cancellation request does not mean the thread stopped. When tool
details are unavailable, summaries use a broader description instead of guessing how many threads
were affected.
