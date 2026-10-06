export type ResolvedProviderName = "claude-code" | "codex" | "iflow" | "opencode" | "pi" | "codebuddy" | "workbuddy";
export type TitleGenerationCli = "codex" | "claude" | "opencode";
export type TitleGenerationCliSessionMode = "fixed" | "fresh";
export type PathKind = "file" | "directory";
export type EnvLike = Record<string, string | undefined>;
export type ProviderPathSource = "env" | "config" | "auto" | "default";

export interface ProviderPathConfig {
  storagePath?: string;
  stateDbPath?: string;
}

export interface AiConfig {
  titleGenerationCliPriority?: TitleGenerationCli[];
  titleGenerationCliSessionModes?: Partial<Record<TitleGenerationCli, TitleGenerationCliSessionMode>>;
  titleGenerationCliDisabled?: TitleGenerationCli[];
}

export interface AppConfig {
  providers?: Partial<Record<ResolvedProviderName, ProviderPathConfig>>;
  ai?: AiConfig;
}

export interface LoadedConfig {
  config: AppConfig;
  configDir: string;
}

export interface ResolvedProviderPaths {
  storagePath: string;
  storageExists: boolean;
  storageSource: ProviderPathSource;
  stateDbPath?: string;
  stateDbExists?: boolean;
  stateDbSource?: ProviderPathSource;
}

export interface ProviderPathMigrationSelection {
  storagePath?: boolean;
  stateDbPath?: boolean;
}

export interface ProviderPathMigrationResult {
  providerName: ResolvedProviderName;
  pathType: "storagePath" | "stateDbPath";
  fromPath: string;
  toPath: string;
  mode: "moved" | "merged";
  message: string;
  cleanupWarning?: string;
}

export interface UpdatedProviderConfigResult extends LoadedConfig {
  migrationResults: ProviderPathMigrationResult[];
}

export interface ResolveProviderPathsOptions {
  env?: EnvLike;
  homeDir?: string;
  config?: AppConfig;
  configDir?: string;
  pathExists?: (path: string, kind: PathKind) => boolean;
  openCodeDbPath?: string | null;
}

export interface UpdateProviderConfigsOptions {
  migrations?: Partial<Record<ResolvedProviderName, ProviderPathMigrationSelection>>;
  ai?: AiConfig;
}

export interface ResolvedPathResult {
  path: string;
  exists: boolean;
  source: ProviderPathSource;
}

export interface PreparedProviderPathMigration {
  result: ProviderPathMigrationResult;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
