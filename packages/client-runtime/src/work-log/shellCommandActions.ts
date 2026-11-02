import type { ReadLineRange } from "@t3tools/shared/toolActivity";

import {
  commandWithoutLeadingShellComments,
  isPowerShellScript,
  isWhitespaceCharacter,
  splitFirstShellCommand,
  tokenizeShellCommand,
  withoutShellLineContinuations,
  withoutShellWrapper,
} from "./commandLabel.ts";

export type ShellCommandAction =
  | { readonly kind: "read"; readonly path: string; readonly lines?: ReadLineRange }
  | { readonly kind: "search"; readonly query?: string; readonly path?: string }
  | { readonly kind: "list"; readonly path?: string }
  | { readonly kind: "create" | "edit" | "delete"; readonly path: string }
  | { readonly kind: "move"; readonly path: string; readonly toPath: string }
  | { readonly kind: "commit" };

export interface ShellCommandClassification {
  readonly actions: ReadonlyArray<ShellCommandAction>;
  /** Some part of the command is not a read, search, file action or commit. */
  readonly other: boolean;
}

const MAX_SEGMENTS = 64;
const CONTROL_WORDS = new Set(
  "if then elif else fi for while until do done case esac select function { } [[".split(" "),
);
const STREAM_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const NO_OP_PROGRAMS = new Set([":", "true"]);
const SEARCH_PROGRAMS = new Set(["rg", "grep", "find"]);

const OPTIONS_WITH_VALUE: Partial<Record<string, ReadonlySet<string>>> = {
  rg: new Set(
    "-A -B -C -E -M -T -e -f -g -j -m -r -t --after-context --before-context --color --colors --context --encoding --engine --file --glob --iglob --max-columns --max-count --max-depth --max-filesize --pre --pre-glob --regexp --replace --sort --sortr --threads --type --type-add --type-not".split(
      " ",
    ),
  ),
  grep: new Set(
    "-A -B -C -D -d -e -f -m --after-context --before-context --context --exclude --exclude-dir --file --include --label --max-count --regexp".split(
      " ",
    ),
  ),
  head: new Set(["-c", "-n", "--bytes", "--lines"]),
  tail: new Set(["-c", "-n", "--bytes", "--lines"]),
  ls: new Set(
    "-I -T -w --block-size --format --hide --ignore --indicator-style --quoting-style --sort --tabsize --time --time-style --width".split(
      " ",
    ),
  ),
  nl: new Set(["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"]),
  sed: new Set(["-e", "--expression"]),
  touch: new Set(["-d", "-r", "-t", "--date", "--reference"]),
  git: new Set(["-C", "-c", "--git-dir", "--namespace", "--work-tree"]),
};
const MV_TARGET_OPTIONS = ["-S", "-T", "-b", "-t", "--backup", "--suffix", "--target-directory"];
const FIND_QUERY_OPTIONS = ["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"];
const FIND_ACTIONS_WITH_EFFECTS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);

// Only these programs and redirects produce actions; most commands skip the tokenizer.
const MAY_ACT = /\b(?:cat|nl|head|tail|sed|rg|grep|find|ls|touch|rm|mv|git)\b|>/;

// Tokenizing a 100 KB heredoc body costs far more than the label is worth.
const MAX_CLASSIFIED_LENGTH = 8_192;

/** A long command that is one heredoc ending the command: its first line says what it writes. */
function heredocHeader(command: string): string | null {
  const newline = command.indexOf("\n");
  if (newline === -1 || newline > MAX_CLASSIFIED_LENGTH) return null;
  const header = command.slice(0, newline);
  const delimiter = /<<-?\s*(['"]?)(\w+)\1\s*$/.exec(header)?.[2];
  const lastLine = command.trimEnd().slice(command.trimEnd().lastIndexOf("\n") + 1);
  return delimiter !== undefined && lastLine.trim() === delimiter ? header : null;
}

/**
 * Lists the reads, searches, file actions and commits of a shell command in
 * command order. A part it cannot be sure of sets `other` and adds no action.
 */
export function classifyShellCommand(command: string): ShellCommandClassification {
  const actions: ShellCommandAction[] = [];
  let other = false;
  let cwd = "";
  let pipedInput = false;
  if (!MAY_ACT.test(command)) return { actions, other: true };
  if (command.length > MAX_CLASSIFIED_LENGTH) {
    const header = heredocHeader(command);
    if (header === null) return { actions, other: true };
    command = header;
  }
  let rest: string | null = withoutShellWrapper(command);
  if (isPowerShellScript(rest)) return { actions, other: true };

  for (let segment = 0; rest && segment < MAX_SEGMENTS; segment += 1) {
    rest = commandWithoutLeadingShellComments(rest);
    if (rest === null) break;
    const { firstCommand, remainingCommand, separator } = splitFirstShellCommand(rest);
    const parsed = parseSegment(firstCommand);
    // Control flow decides which commands run, so nothing after it is certain.
    if (parsed === null || CONTROL_WORDS.has(parsed.tokens[0] ?? "")) {
      other = true;
      break;
    }
    const resolve = (path: string) =>
      normalizePath(path.startsWith("/") || cwd === "" ? path : `${cwd}/${path}`);
    const program = parsed.tokens[0]?.split("/").at(-1);
    const args = parsed.tokens.slice(1);

    if (program === "cd") {
      const target = args.length === 1 ? args[0]! : null;
      if (target === null || !isLiteralPath(target)) {
        other = true;
        break;
      }
      cwd = resolve(target);
    } else {
      const segmentActions = program === undefined ? [] : programActions(program, args, pipedInput);
      if (segmentActions !== null) {
        for (const action of segmentActions) actions.push(resolveAction(action, resolve));
      } else if (!(parsed.writes.length > 0 && (program === "echo" || program === "printf"))) {
        other = true;
      }
      for (const path of parsed.writes) {
        if (isLiteralPath(path)) actions.push({ kind: "edit", path: resolve(path) });
        else other = true;
      }
    }

    pipedInput = separator === "|" || separator === "|&";
    rest = remainingCommand;
  }

  return { actions, other };
}

function resolveAction(
  action: ShellCommandAction,
  resolve: (path: string) => string,
): ShellCommandAction {
  switch (action.kind) {
    case "commit":
      return action;
    case "search":
      return action.path === undefined ? action : { ...action, path: resolve(action.path) };
    case "list":
      return listAction(resolve(action.path ?? "."));
    case "move":
      return { ...action, path: resolve(action.path), toPath: resolve(action.toPath) };
    default:
      return { ...action, path: resolve(action.path) };
  }
}

/** Null when the program is not recognized, or its effect is not certain. */
function programActions(
  program: string,
  args: ReadonlyArray<string>,
  pipedInput: boolean,
): ShellCommandAction[] | null {
  if (NO_OP_PROGRAMS.has(program)) return [];
  const parsed = parseOptions(program, args);
  if (parsed === null) return null;
  const { options, operands } = parsed;
  if (!SEARCH_PROGRAMS.has(program) && !operands.every(isLiteralPath)) return null;
  const read = (path: string): ShellCommandAction => ({ kind: "read", path });

  switch (program) {
    // Readers without file operands pass their input through.
    case "cat":
    case "nl":
      return operands.filter((path) => path !== "-").map(read);
    case "head": {
      if (options.has("-c") || options.has("--bytes")) return operands.map(read);
      const count = Number(options.get("-n") ?? options.get("--lines") ?? 10);
      if (!Number.isInteger(count) || count <= 0) return null;
      return operands.map((path) => ({ kind: "read", path, lines: { start: 1, end: count } }));
    }
    case "tail": {
      const follows = ["-f", "-F", "--follow"].some((option) => options.has(option));
      const bytes = options.has("-c") || options.has("--bytes");
      const count = /^([+-]?)(\d+)$/.exec(options.get("-n") ?? options.get("--lines") ?? "10");
      if (follows || bytes || count === null || Number(count[2]) === 0) return operands.map(read);
      const lines = count[1] === "+" ? { start: Number(count[2]) } : { last: Number(count[2]) };
      return operands.map((path) => ({ kind: "read", path, lines }));
    }
    case "sed": {
      const scriptOption = options.get("-e") ?? options.get("--expression");
      const files = scriptOption === undefined ? operands.slice(1) : operands;
      if (options.has("-i") || options.has("--in-place")) return null;
      if (files.length === 0) return [];
      if (!["-n", "--quiet", "--silent"].some((option) => options.has(option))) return null;
      const range = /^(\d+)(?:,(\d+))?p$/.exec(scriptOption ?? operands[0] ?? "");
      if (range === null) return null;
      const lines = { start: Number(range[1]), end: Number(range[2] ?? range[1]) };
      return files.map((path) => ({ kind: "read", path, lines }));
    }
    case "ls":
      return operands.length === 0 ? [listAction(undefined)] : operands.map(listAction);
    case "rg":
    case "grep": {
      if (options.has("--files")) return [listAction(operands[0])];
      const patternOption = options.get("-e") ?? options.get("--regexp");
      const usesPatternOption = patternOption !== undefined || options.has("-f");
      const query = usesPatternOption ? patternOption : operands[0];
      const paths = usesPatternOption ? operands : operands.slice(1);
      if (pipedInput && paths.length === 0) return [];
      return [searchAction(query, paths[0])];
    }
    case "find": {
      const query = FIND_QUERY_OPTIONS.map((option) => options.get(option)).find(Boolean);
      return [searchAction(query, operands[0])];
    }
    case "touch":
      if (options.has("-c") || options.has("--no-create") || operands.length === 0) return null;
      return operands.map((path) => ({ kind: "create", path }));
    case "rm":
      if (operands.length === 0) return null;
      return operands.map((path) => ({ kind: "delete", path }));
    case "mv": {
      if (operands.length < 2 || MV_TARGET_OPTIONS.some((option) => options.has(option))) {
        return null;
      }
      const target = operands.at(-1)!;
      const sources = operands.slice(0, -1);
      if (sources.length === 1) return [{ kind: "move", path: sources[0]!, toPath: target }];
      return sources.map((path) => ({
        kind: "move",
        path,
        toPath: `${target}/${path.split("/").at(-1)}`,
      }));
    }
    case "git":
      return operands[0] === "commit" ? [{ kind: "commit" }] : null;
    default:
      return null;
  }
}

/** A listing of the working folder names no path. */
function listAction(path: string | undefined): ShellCommandAction {
  return path === undefined || path === "." ? { kind: "list" } : { kind: "list", path };
}

function searchAction(query: string | undefined, path: string | undefined): ShellCommandAction {
  return {
    kind: "search",
    ...(query === undefined ? {} : { query }),
    ...(path === undefined ? {} : { path }),
  };
}

/** Splits options from operands; an option's first value wins. */
function parseOptions(
  program: string,
  args: ReadonlyArray<string>,
): { readonly options: ReadonlyMap<string, string>; readonly operands: string[] } | null {
  const options = new Map<string, string>();
  const operands: string[] = [];
  const withValue = OPTIONS_WITH_VALUE[program] ?? new Set<string>();
  const setOption = (name: string, value: string) => {
    if (!options.has(name)) options.set(name, value);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (program === "git" && operands.length > 0) {
      operands.push(arg);
      continue;
    }
    if (program === "find") {
      if (FIND_ACTIONS_WITH_EFFECTS.has(arg)) return null;
      if (FIND_QUERY_OPTIONS.includes(arg)) {
        setOption(arg, args[index + 1] ?? "");
        index += 1;
      } else if (/^[-(!)]/.test(arg)) setOption(arg, "");
      else if (options.size === 0) operands.push(arg);
      continue;
    }
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
      continue;
    }
    if ((program === "head" || program === "tail") && /^-\d+$/.test(arg)) {
      setOption("-n", arg.slice(1));
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (equals !== -1) setOption(name, arg.slice(equals + 1));
      else if (!withValue.has(name)) setOption(name, "");
      else if (args[index + 1] === undefined) return null;
      else setOption(name, args[(index += 1)]!);
      continue;
    }
    // Short options can be grouped (`-rf`); a value option takes the rest of the word or the next word.
    for (let at = 1; at < arg.length; at += 1) {
      const name = `-${arg[at]}`;
      if (!withValue.has(name)) {
        setOption(name, "");
        continue;
      }
      const attached = arg.slice(at + 1);
      if (attached) setOption(name, attached);
      else if (args[index + 1] === undefined) return null;
      else setOption(name, args[(index += 1)]!);
      break;
    }
  }
  return { options, operands };
}

function parseSegment(
  segment: string,
): { readonly tokens: ReadonlyArray<string>; readonly writes: ReadonlyArray<string> } | null {
  const redirected = withoutRedirections(withoutShellLineContinuations(segment));
  if (redirected === null) return null;
  const tokens = tokenizeShellCommand(redirected.command);
  if (tokens === null) return null;
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(tokens[start]!)) start += 1;
  return { tokens: tokens.slice(start), writes: redirected.writes };
}

/**
 * Removes redirections and lists the files they write. Quoted text stays an
 * argument, so a quoted `>` is not a redirection. `splitFirstShellCommand`
 * has already split off heredoc bodies.
 */
function withoutRedirections(
  segment: string,
): { readonly command: string; readonly writes: ReadonlyArray<string> } | null {
  let command = "";
  let copied = 0;
  const writes: string[] = [];
  let quote: '"' | "'" | "`" | null = null;
  let escaping = false;
  let nesting = 0;

  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (escaping) {
      escaping = false;
    } else if (character === "\\" && quote !== "'") {
      escaping = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(" || character === "{") {
      nesting += 1;
    } else if ((character === ")" || character === "}") && nesting > 0) {
      nesting -= 1;
    } else if (
      nesting === 0 &&
      (character === ">" || character === "<" || (character === "&" && segment[index + 1] === ">"))
    ) {
      const operator = /^(?:&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/.exec(segment.slice(index))![0];
      if (segment[index + operator.length] === "(") return null;
      command += segment.slice(copied, index);
      // A file descriptor number belongs to the operator when it is a whole word.
      const descriptor = /(?:^|\s)(\d+)$/.exec(command)?.[1];
      if (descriptor) command = command.slice(0, -descriptor.length);
      const word = readWord(segment, index + operator.length);
      if (word === null) return null;
      index = word.end - 1;
      copied = word.end;
      command += " ";
      const writesFile = operator.startsWith(">") || operator.startsWith("&>") || operator === "<>";
      const duplicates = operator.endsWith("&") && /^(?:\d+|-)$/.test(word.value);
      if (writesFile && !duplicates && !STREAM_PATHS.has(word.value)) writes.push(word.value);
      continue;
    }
  }

  if (quote !== null || escaping || nesting > 0) return null;
  return { command: command + segment.slice(copied), writes };
}

function readWord(
  text: string,
  start: number,
): { readonly value: string; readonly end: number } | null {
  let index = start;
  while (text[index] === " " || text[index] === "\t") index += 1;
  let value = "";
  let quote: '"' | "'" | null = null;
  for (; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (isWhitespaceCharacter(character) || ";&|<>()".includes(character)) {
      break;
    } else {
      value += character;
    }
  }
  if (quote !== null || value === "") return null;
  return { value, end: index };
}

function isLiteralPath(path: string): boolean {
  return path !== "" && !/[*?[\]{}$`~]/.test(path);
}

function normalizePath(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (path.startsWith("/")) return `/${parts.join("/")}`;
  return parts.join("/") || ".";
}
