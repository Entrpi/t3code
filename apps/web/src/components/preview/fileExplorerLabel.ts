import type {
  ExecutionEnvironmentPlatformOs,
  FileManagerRevealKind,
  ServerConfig,
} from "@t3tools/contracts";

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Reveal in Finder";
  if (normalized.includes("win")) return "Reveal in File Explorer";
  return "Reveal in Files";
}

export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return "Reveal in Finder";
  if (os === "windows") return "Reveal in File Explorer";
  return "Reveal in Files";
}

export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return "Reveal in Finder";
  if (kind === "file-explorer") return "Reveal in File Explorer";
  return "Reveal in Files";
}

/** The reveal action's label, or undefined when the environment cannot reveal files. */
export function revealInFileManagerLabelForConfig(config: ServerConfig | null) {
  if (config?.shellRevealInFileManager !== true) return undefined;
  if (!config.availableEditors.includes("file-manager")) return undefined;
  return config.shellRevealInFileManagerKind === undefined
    ? revealInFileExplorerLabelForOs(config.environment.platform.os)
    : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind);
}
