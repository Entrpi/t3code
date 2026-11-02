export type TurnDiffFileKind = "added" | "deleted" | "renamed" | "modified";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly previousPath?: string;
  /** Present when the diff output includes `--raw` records. */
  readonly kind?: TurnDiffFileKind;
  readonly additions: number;
  readonly deletions: number;
  /** Git reports no line counts for binary files, so both counts are 0. */
  readonly binary?: true;
}

// A copy is a new file at its path.
const RAW_STATUS_KINDS: Partial<Record<string, TurnDiffFileKind>> = {
  A: "added",
  C: "added",
  D: "deleted",
  R: "renamed",
};

/** Parses `--numstat -z` output, optionally preceded by `--raw` records. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];
  const kinds = new Map<string, TurnDiffFileKind>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith(":")) {
      // ":<modes> <object ids> <status>", then the path, or the source and destination paths.
      const status = record.slice(record.lastIndexOf(" ") + 1);
      index += status.startsWith("R") || status.startsWith("C") ? 2 : 1;
      const path = records[index];
      if (path) kinds.set(path, RAW_STATUS_KINDS[status.charAt(0)] ?? "modified");
      continue;
    }
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    let previousPath: string | undefined;
    if (path.length === 0) {
      previousPath = records[index + 1];
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;

    const binary = counts[1] === "-";
    files.push({
      path,
      ...(previousPath === undefined ? {} : { previousPath }),
      additions: binary ? 0 : Number(counts[1]),
      deletions: binary ? 0 : Number(counts[2]),
      ...(binary ? { binary } : {}),
    });
  }

  return files
    .map((file) => {
      const kind = kinds.get(file.path);
      return kind === undefined ? file : { ...file, kind };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export function isGitImport(
  file: TurnDiffFileSummary,
  authoredPaths: ReadonlySet<string> | null,
): boolean {
  return (
    authoredPaths !== null &&
    !authoredPaths.has(file.path) &&
    (file.previousPath === undefined || !authoredPaths.has(file.previousPath))
  );
}
