import { describe, expect, it } from "vite-plus/test";

import { classifyShellCommand } from "./shellCommandActions.ts";

describe("classifyShellCommand", () => {
  it.each([
    [
      "sed -n '1,120p' src/app.ts",
      [{ kind: "read", path: "src/app.ts", lines: { start: 1, end: 120 } }],
    ],
    [
      'sed -n "42p" src/app.ts',
      [{ kind: "read", path: "src/app.ts", lines: { start: 42, end: 42 } }],
    ],
    ["sed -n -e '5,9p' a.ts", [{ kind: "read", path: "a.ts", lines: { start: 5, end: 9 } }]],
    [
      "cat package.json README.md",
      [
        { kind: "read", path: "package.json" },
        { kind: "read", path: "README.md" },
      ],
    ],
    ["head -n 40 a.ts", [{ kind: "read", path: "a.ts", lines: { start: 1, end: 40 } }]],
    ["head -20 a.ts", [{ kind: "read", path: "a.ts", lines: { start: 1, end: 20 } }]],
    ["head a.ts", [{ kind: "read", path: "a.ts", lines: { start: 1, end: 10 } }]],
    ["tail -n +30 a.ts", [{ kind: "read", path: "a.ts", lines: { start: 30 } }]],
    ["tail -n 5 a.ts", [{ kind: "read", path: "a.ts" }]],
    ["nl -ba a.ts", [{ kind: "read", path: "a.ts" }]],
  ])("reads files, with the line range when the command names one: %s", (command, actions) => {
    expect(classifyShellCommand(command)).toEqual({ actions, other: false });
  });

  it.each([
    ["rg -n 'useEffect' apps/web", [{ kind: "search", query: "useEffect", path: "apps/web" }]],
    ["rg -g '*.ts' --max-count 3 TODO", [{ kind: "search", query: "TODO" }]],
    ["rg -e foo -e bar src", [{ kind: "search", query: "foo", path: "src" }]],
    ["rg --files apps/server", [{ kind: "search", path: "apps/server" }]],
    [
      "grep -rn -A 3 'export const' packages",
      [{ kind: "search", query: "export const", path: "packages" }],
    ],
    ["find . -name '*.test.ts'", [{ kind: "search", query: "*.test.ts", path: "." }]],
    ["rg --files | rg Diff", [{ kind: "search" }]],
  ])("finds searches and their query: %s", (command, actions) => {
    expect(classifyShellCommand(command)).toEqual({ actions, other: false });
  });

  it.each([
    [
      "rm -f a.txt && touch b.txt",
      [
        { kind: "delete", path: "a.txt" },
        { kind: "create", path: "b.txt" },
      ],
    ],
    ["rm -rf dist", [{ kind: "delete", path: "dist" }]],
    ["printf 'x\\n' > notes.md", [{ kind: "edit", path: "notes.md" }]],
    ["echo more >> notes.md", [{ kind: "edit", path: "notes.md" }]],
    ["mv old.ts new.ts", [{ kind: "move", path: "old.ts", toPath: "new.ts" }]],
    [
      "mv a.ts b.ts lib",
      [
        { kind: "move", path: "a.ts", toPath: "lib/a.ts" },
        { kind: "move", path: "b.ts", toPath: "lib/b.ts" },
      ],
    ],
    ["touch -d yesterday ./stamp", [{ kind: "create", path: "stamp" }]],
    ["cat > notes.md <<'EOF'\n# Notes\n> quoted\nEOF", [{ kind: "edit", path: "notes.md" }]],
    [
      `cat > big.md <<'EOF'\n${"a && b > c\n".repeat(2_000)}EOF\n`,
      [{ kind: "edit", path: "big.md" }],
    ],
    [
      "cat a.ts > b.ts",
      [
        { kind: "read", path: "a.ts" },
        { kind: "edit", path: "b.ts" },
      ],
    ],
    [
      "cd apps/web && rm old.ts && touch src/new.ts",
      [
        { kind: "delete", path: "apps/web/old.ts" },
        { kind: "create", path: "apps/web/src/new.ts" },
      ],
    ],
    [
      "/bin/zsh -lc 'rm stale.log && : > fresh.log'",
      [
        { kind: "delete", path: "stale.log" },
        { kind: "edit", path: "fresh.log" },
      ],
    ],
  ])("lists every file action in command order: %s", (command, actions) => {
    expect(classifyShellCommand(command)).toEqual({ actions, other: false });
  });

  it.each([
    ["git add . && git commit -m 'Ship it'", [{ kind: "commit" }], true],
    ["git -C repo commit --amend --no-edit", [{ kind: "commit" }], false],
    ["vp test run && git commit -am wip && git push", [{ kind: "commit" }], true],
  ])("counts a commit anywhere in a chain: %s", (command, actions, other) => {
    expect(classifyShellCommand(command)).toEqual({ actions, other });
  });

  it.each([
    ["vp test run 2>&1", []],
    ["grep '>' notes.md", [{ kind: "search", query: ">", path: "notes.md" }]],
    ['echo "a > b"', []],
    ["vp lint > /dev/null 2>&1", []],
  ])("does not read redirects to streams or quoted > as file edits: %s", (command, actions) => {
    expect(classifyShellCommand(command).actions).toEqual(actions);
  });

  it.each([
    "vp test run",
    "rm *.log",
    "rm $TARGET",
    "find . -name '*.tmp' -delete",
    "sed -i 's/a/b/' a.ts",
    "touch -c a.ts",
    "cd $HOME && rm a.txt",
    "if [ -f a ]; then rm a; fi",
    "for f in *.ts; do cat $f; done",
    'powershell -Command "Remove-Item a.txt"',
    "Remove-Item a.txt",
    "zsh -lc 'rm a.txt",
    `cat > big.md <<'EOF'\n${"line\n".repeat(4_000)}EOF\nrm big.md`,
    `zsh -lc 'cat > big.md <<EOF\n${"line\n".repeat(4_000)}EOF'`,
  ])("returns other when it cannot be sure what a command does: %s", (command) => {
    expect(classifyShellCommand(command)).toMatchObject({ other: true });
    expect(
      classifyShellCommand(command).actions.filter((action) => action.kind !== "search"),
    ).toEqual([]);
  });
});
