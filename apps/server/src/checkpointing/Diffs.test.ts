import { describe, expect, it } from "vite-plus/test";

import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";

describe("parseTurnDiffFilesFromNumstat", () => {
  it("sorts files and preserves addition and deletion counts", () => {
    const numstat = ["0\t2\tsrc/b.ts", "2\t1\ta.txt", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 2 },
    ]);
  });

  it("preserves both paths for renames and copies", () => {
    const numstat = [
      "0\t0\t",
      "src/old.ts",
      "src/new.ts",
      "2\t1\t",
      "src/source.ts",
      "src/copied.ts",
      "1\t0\tother.ts",
      "",
    ].join("\0");

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "other.ts", additions: 1, deletions: 0 },
      { path: "src/copied.ts", previousPath: "src/source.ts", additions: 2, deletions: 1 },
      { path: "src/new.ts", previousPath: "src/old.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("marks binary files, whose line counts git does not report", () => {
    const numstat = ["-\t-\timage.png", "0\t0\tempty.txt", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "empty.txt", additions: 0, deletions: 0 },
      { path: "image.png", additions: 0, deletions: 0, binary: true },
    ]);
  });

  it("reads each file's change kind from raw records", () => {
    const output = [
      ":000000 100644 0000000 1111111 A",
      "src/added.ts",
      ":100644 000000 2222222 0000000 D",
      ":odd/deleted.ts",
      ":100644 100644 3333333 4444444 M",
      "src/edited.ts",
      ":100644 100644 5555555 5555555 R100",
      "src/old.ts",
      "src/new.ts",
      ":100644 100644 6666666 7777777 C075",
      "src/source.ts",
      "src/copied.ts",
      "3\t0\tsrc/added.ts",
      "0\t2\t:odd/deleted.ts",
      "1\t1\tsrc/edited.ts",
      "0\t0\t",
      "src/old.ts",
      "src/new.ts",
      "2\t1\t",
      "src/source.ts",
      "src/copied.ts",
      "",
    ].join("\0");

    expect(parseTurnDiffFilesFromNumstat(output)).toEqual([
      { path: ":odd/deleted.ts", kind: "deleted", additions: 0, deletions: 2 },
      { path: "src/added.ts", kind: "added", additions: 3, deletions: 0 },
      {
        path: "src/copied.ts",
        previousPath: "src/source.ts",
        kind: "added",
        additions: 2,
        deletions: 1,
      },
      { path: "src/edited.ts", kind: "modified", additions: 1, deletions: 1 },
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        kind: "renamed",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it("preserves Unicode, tabs, line endings, and spaces in paths", () => {
    const path = " café\tline\r\nname.txt ";
    const numstat = `3\t2\t\0old\tname\n.txt\0${path}\0`;

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path, previousPath: "old\tname\n.txt", additions: 3, deletions: 2 },
    ]);
    expect(parseTurnDiffFilesFromNumstat(`1\t0\t${path}\0`)).toEqual([
      { path, additions: 1, deletions: 0 },
    ]);
  });
});
