import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@t3tools/contracts";

/** Public display projection only; it never updates the owner's runtime settings. */
export function projectConfig(
  config: ServerConfig,
  project: { title: string; workspaceRoot: string },
  shareId: string,
): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make(`kara-share:${shareId}`),
      label: project.title,
      platform: { os: config.environment.platform.os, arch: config.environment.platform.arch },
      serverVersion: config.environment.serverVersion,
      ...(config.environment.orchestrationProtocolVersion === undefined
        ? {}
        : { orchestrationProtocolVersion: config.environment.orchestrationProtocolVersion }),
      capabilities: {
        repositoryIdentity: false,
        connectionProbe: true,
        attachmentUploads: false,
        questionAttachments: false,
        pullRequests: false,
        inlineMessageContext: false,
        requiredWorktreeBootstrap: false,
        memory: false,
        memoryRecommendations: false,
        environmentThemes: false,
        usageLimitSources: false,
        agentActivityPublishing: false,
        projectCloneTracking: false,
      },
    },
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "kara_agent_session",
    },
    cwd: project.workspaceRoot,
    keybindingsConfigPath: "/shared-project/keybindings-disabled",
    keybindings: [],
    issues: [],
    providers: config.providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      enabled: provider.enabled,
      installed: provider.installed,
      version: provider.version,
      status: provider.status,
      checkedAt: provider.checkedAt,
      auth: { status: provider.auth.status },
      models: provider.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        isCustom: model.isCustom,
        capabilities: model.capabilities,
        ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
      })),
      slashCommands: [],
      skills: [],
      setup: { canAuthenticate: false, canInstall: false },
    })),
    availableEditors: [],
    remoteOpenTargets: [],
    observability: {
      logsDirectoryPath: "/shared-project/observability-disabled",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" },
    ...(config.shellResumeCompletionMarker === undefined
      ? {}
      : { shellResumeCompletionMarker: config.shellResumeCompletionMarker }),
    ...(config.threadResumeCompletionMarker === undefined
      ? {}
      : { threadResumeCompletionMarker: config.threadResumeCompletionMarker }),
    ...(config.threadSnapshotPagination === undefined
      ? {}
      : { threadSnapshotPagination: config.threadSnapshotPagination }),
    ...(config.reasoningMessages === undefined
      ? {}
      : { reasoningMessages: config.reasoningMessages }),
  };
}
