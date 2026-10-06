// provider-paths 聚合出口（原 utils/provider-paths.ts 拆分而来）：
// types —— 类型定义；config —— 配置加载/写入；title-cli —— 标题生成 CLI 配置；
// resolve —— 存储路径解析（含候选探测）；migration —— 路径迁移（staging/回滚）；
// update —— updateProviderConfigs 编排；path-style —— 跨平台路径风格工具。
export {
  clearProviderPathCache,
  getProviderPaths,
  resolveProviderPaths,
} from "./resolve.js";
export {
  getAppConfig,
  getProviderConfigPath,
} from "./config.js";
export {
  getTitleGenerationCliDisabled,
  getTitleGenerationCliPriority,
  getTitleGenerationCliSessionModes,
  getTitleGenerationCliSessionReuse,
  getRawTitleGenerationCliPriority,
  normalizeTitleGenerationCliPriority,
  normalizeTitleGenerationCliSessionModes,
} from "./title-cli.js";
export { updateProviderConfigs } from "./update.js";
export type {
  AiConfig,
  AppConfig,
  LoadedConfig,
  ProviderPathConfig,
  ProviderPathMigrationResult,
  ProviderPathMigrationSelection,
  ProviderPathSource,
  ResolvedProviderName,
  ResolvedProviderPaths,
  TitleGenerationCli,
  TitleGenerationCliSessionMode,
  UpdatedProviderConfigResult,
} from "./types.js";
