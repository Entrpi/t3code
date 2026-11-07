import {
  commandWithoutLeadingShellComments,
  splitFirstShellCommand,
  tokenizeShellCommand,
  withoutShellWrapper,
} from "../work-log/commandLabel.ts";
import type { ThreadStructureTurnItem } from "./models.ts";

const GIT_COMMIT = /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+commit\b/;
const GIT_PUSH = /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+push\b/;
const GH_WRITE =
  /\bgh\s+(?:pr|issue|release|repo|gist|workflow|run|label|secret|variable)\s+(?:create|merge|close|comment|edit|review|delete|reopen|run|ready|fork|rerun|cancel|set|upload|lock|transfer)\b|\bgh\s+api\b.*(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b/;
const PACKAGE_CHANGE =
  /\b(?:npm|pnpm|yarn|bun|vp)\s+(?:i|install|add|remove|rm|uninstall|update|upgrade)\b|\b(?:pip3?|uv\s+pip)\s+(?:install|uninstall)\b|\bbrew\s+(?:install|uninstall|upgrade|reinstall)\b|\b(?:cargo|go|gem)\s+install\b/;
// Programs that only read, or whose writes stay in the project when their paths do.
const KNOWN_PROGRAMS = new Set(
  "cat head tail nl wc sort uniq cut tr diff cmp file stat ls tree pwd echo printf grep rg find fd which type date true false test cd sed awk jq basename dirname realpath readlink du df printenv env id whoami uname hostname ps lsof export set unset command sleep touch rm mv cp mkdir rmdir ln chmod tee tsc eslint oxlint prettier pytest jest vitest".split(
    " ",
  ),
);
const KNOWN_SUBCOMMANDS: Partial<Record<string, RegExp>> = {
  git: /^(?:status|diff|log|show|blame|rev-parse|ls-files|grep|describe|shortlog|add|branch|worktree|stash|remote)$/,
  gh: /^(?:pr|issue|run|repo|release|api)$/,
  npm: /^(?:test|t|run)$/,
  pnpm: /^(?:test|t|run|typecheck|lint|build)$/,
  yarn: /^(?:test|run|typecheck|lint|build)$/,
  bun: /^(?:test|run)$/,
  vp: /^(?:test|check|lint|fmt|run)$/,
  cargo: /^(?:test|build|check|clippy|fmt)$/,
  go: /^(?:test|build|vet|fmt)$/,
};
// Package scripts named for checking or building; any other script is unknown.
const KNOWN_SCRIPT = /^(?:test|build|lint|typecheck|check|fmt|format)(?:[:-][\w:-]*)?$/;
const STREAM_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
// Their paths decide whether a change stays in the project; a `cd` out moves the rest of the chain.
const PATH_CHECKED = new Set("cd touch rm mv cp mkdir rmdir ln chmod sed tee".split(" "));
const REDIRECT_TARGET = /(?:^|[^<&\d])\d*(?:>>?|&>)\s*([^\s;&|<>()'"]+)/g;
const MAX_SEGMENTS = 64;

// Tools named for reading or waiting change nothing a rewind would miss.
const READ_ONLY_TOOL =
  /(?:^|[_.-])(?:read|list|get|search|find|status|snapshot|view|fetch|wait|query|describe|show|lookup|capabilities)(?:[_.-]|$)/i;
// Provider-native tools that only touch the workspace, which a checkpoint covers.
const WORKSPACE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS"]);

function displaySegment(segment: string): string {
  const oneLine = segment.trim().replace(/\s+/g, " ");
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}

function writesOutside(path: string, workspaceRoot: string | null): boolean {
  if (STREAM_PATHS.has(path)) return false;
  return path.startsWith("~") || outsidePath(path, workspaceRoot) !== null;
}

/** A command segment whose effects this check knows: a read, a check or build, or a file change inside the project. */
function isKnownSegment(segment: string, workspaceRoot: string | null): boolean {
  // A checkpoint restores only the project, so a write outside it is never known.
  for (const [, target] of segment.matchAll(REDIRECT_TARGET)) {
    if (writesOutside(target!, workspaceRoot)) return false;
  }
  const tokens = tokenizeShellCommand(segment);
  if (tokens === null) return false;
  const start = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const words = start === -1 ? [] : tokens.slice(start);
  const program = words[0]?.split("/").at(-1);
  const [, first, second] = words;
  if (program === undefined) return true;
  if (
    PATH_CHECKED.has(program) &&
    words.slice(1).some((word) => !word.startsWith("-") && writesOutside(word, workspaceRoot))
  ) {
    return false;
  }
  if (KNOWN_PROGRAMS.has(program)) return true;
  const subcommands = KNOWN_SUBCOMMANDS[program];
  if (subcommands === undefined || first === undefined || !subcommands.test(first)) return false;
  if (first === "run") return second !== undefined && KNOWN_SCRIPT.test(second);
  // These list by default and change something given an operand: `git branch x` creates one.
  if (first === "branch" || first === "worktree" || first === "stash" || first === "remote") {
    const operands = words.slice(2).filter((word) => !word.startsWith("-"));
    return operands.length === 0 || (first !== "branch" && operands[0] === "list");
  }
  return true;
}

function listed(names: ReadonlyArray<string>): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** Where a write outside the project lands; a relative path is taken from the project root. */
function outsidePath(path: string, workspaceRoot: string | null): string | null {
  if (workspaceRoot === null || !workspaceRoot.startsWith("/")) return null;
  const root = workspaceRoot.replace(/\/+$/, "");
  const segments: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `${root}/${path}`).split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  const resolved = `/${segments.join("/")}`;
  return resolved === root || resolved.startsWith(`${root}/`) ? null : resolved;
}

/**
 * What rewinding past these turn items leaves in place: a checkpoint restores the project's
 * files and the conversation, but not git history, remotes, installed packages, files outside
 * the project, other threads or what other tools did. Wording says "may" where it guesses.
 */
export function rewindLastingEffects(
  items: Iterable<ThreadStructureTurnItem>,
  workspaceRoot: string | null,
): ReadonlyArray<string> {
  let committed = false;
  let pushed = false;
  let github = false;
  let packages = false;
  let threads = 0;
  const outside = new Set<string>();
  const tools = new Set<string>();
  const unchecked = new Set<string>();

  for (const item of items) {
    switch (item.type) {
      case "command_execution": {
        let rest: string | null = withoutShellWrapper(item.input);
        for (let segments = 0; rest && segments < MAX_SEGMENTS; segments += 1) {
          rest = commandWithoutLeadingShellComments(rest);
          if (rest === null) break;
          const { firstCommand, remainingCommand } = splitFirstShellCommand(rest);
          rest = remainingCommand;
          if (GIT_COMMIT.test(firstCommand)) committed = true;
          else if (GIT_PUSH.test(firstCommand)) pushed = true;
          else if (GH_WRITE.test(firstCommand)) github = true;
          else if (PACKAGE_CHANGE.test(firstCommand)) packages = true;
          else if (!isKnownSegment(firstCommand, workspaceRoot)) {
            unchecked.add(displaySegment(firstCommand));
          }
        }
        break;
      }
      case "file_change": {
        if (item.status === "failed" || item.status === "cancelled") break;
        const paths = item.changes?.map((change) => change.path) ?? [item.fileName];
        for (const path of paths) {
          const resolved = outsidePath(path, workspaceRoot);
          if (resolved !== null) outside.add(resolved);
        }
        break;
      }
      case "thread_created":
        threads += 1;
        break;
      case "subagent":
        if (item.childThreadId !== null) threads += 1;
        break;
      case "dynamic_tool": {
        const name = item.toolName?.split("__").at(-1);
        if (name && !WORKSPACE_TOOLS.has(name) && !READ_ONLY_TOOL.test(name)) tools.add(name);
        break;
      }
    }
  }

  return [
    ...(committed ? ["Git commits, which stay in git history"] : []),
    ...(pushed ? ["A push to a remote"] : []),
    ...(github ? ["GitHub changes made with gh"] : []),
    ...(packages ? ["Package installs or removals"] : []),
    ...(outside.size === 0
      ? []
      : [`Changes to files outside the project: ${listed([...outside])}`]),
    ...(threads === 0
      ? []
      : [
          threads === 1
            ? "1 thread or subagent it started, which keeps its own history"
            : `${threads} threads or subagents it started, which keep their own history`,
        ]),
    ...(tools.size === 0
      ? []
      : [`Tool calls that may have acted outside this thread: ${listed([...tools])}`]),
    ...(unchecked.size === 0
      ? []
      : [
          `${unchecked.size} ${unchecked.size === 1 ? "command" : "commands"} the app can't check: ${listed([...unchecked])}`,
        ]),
  ];
}
