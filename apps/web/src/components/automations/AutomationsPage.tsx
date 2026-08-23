import { useAtomValue } from "@effect/atom-react";
import type {
  Automation,
  AutomationCreateInput,
  AutomationId,
  AutomationRun,
  AutomationUpdatePatch,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  AlertCircleIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  Clock3Icon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  setActiveEnvironmentId,
  useActiveEnvironmentId,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { readLocalApi } from "../../localApi";
import { useComposerDraftStore } from "../../composerDraftStore";
import { openCommandPalette } from "../../commandPaletteBus";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AutomationEditorDialog } from "./AutomationEditorDialog";
import { AUTOMATION_CHAT_STARTER_PROMPT } from "./automationCreation";
import {
  automationCanResume,
  automationNextRunLabel,
  automationPausedReasonLabel,
  automationRunLabel,
  automationScheduleLabel,
  filterAutomations,
  type AutomationFilter,
} from "./automationPresentation";

export interface AutomationsPageSearch {
  readonly create?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
}

interface AutomationsPageProps {
  readonly search: AutomationsPageSearch;
}

const LAST_SEEN_KEY = "t3code:automations:last-seen";
const LAST_SEEN_SCHEMA = Schema.Record(Schema.String, Schema.String);
const EMPTY_AUTOMATIONS: ReadonlyArray<Automation> = [];
const EMPTY_RUNS: ReadonlyArray<AutomationRun> = [];

function mutationError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The automation request failed.",
    }),
  );
}

function AutomationCreateActions(props: {
  readonly compact?: boolean;
  readonly disabled: boolean;
  readonly openingChat: boolean;
  readonly onCreateWithAgent: () => void;
  readonly onCreateManually: () => void;
}) {
  const buttonSize = props.compact ? "sm" : "default";
  const menuButtonSize = props.compact ? "icon-sm" : "icon";

  return (
    <div className="inline-flex items-center">
      <Button
        size={buttonSize}
        className="rounded-r-none"
        disabled={props.disabled || props.openingChat}
        onClick={props.onCreateWithAgent}
      >
        <PlusIcon />
        {props.openingChat ? "Opening task..." : "New automation"}
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size={menuButtonSize}
              className="rounded-l-none border-l-primary-foreground/20 px-1.5"
              aria-label="Automation creation options"
              disabled={props.disabled || props.openingChat}
            />
          }
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={props.onCreateManually}>
            <SlidersHorizontalIcon />
            Set up manually
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function statusBadge(automation: Automation) {
  if (automation.status === "active") {
    return (
      <Badge variant="success" size="sm">
        Active
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" size="sm">
      Paused
    </Badge>
  );
}

function runIcon(run: AutomationRun) {
  switch (run.status) {
    case "pending":
    case "waiting-for-thread":
      return <Clock3Icon className="size-4 text-muted-foreground" />;
    case "running":
      return <LoaderCircleIcon className="size-4 text-info" />;
    case "succeeded":
      return <CheckCircle2Icon className="size-4 text-success" />;
    case "failed":
      return <AlertCircleIcon className="size-4 text-destructive-foreground" />;
  }
}

function dateTimeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function AutomationsPage({ search: routeSearch }: AutomationsPageProps) {
  const navigate = useNavigate();
  const openNewThread = useNewThreadHandler();
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = routeSearch.environmentId ?? activeEnvironmentId ?? primaryEnvironmentId;
  const configByEnvironment = useAtomValue(environmentServerConfigsAtom);
  const config = environmentId ? (configByEnvironment.get(environmentId) ?? null) : null;
  const capabilities = config?.automationCapabilities ?? null;
  const allProjects = useProjects();
  const allThreads = useThreadShells();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const threads = useMemo(
    () => allThreads.filter((thread) => thread.environmentId === environmentId),
    [allThreads, environmentId],
  );
  const projectTitleById = useMemo(
    () => new Map(projects.map((project) => [project.id as string, project.title] as const)),
    [projects],
  );
  const threadTitleById = useMemo(
    () => new Map(threads.map((thread) => [thread.id as string, thread.title] as const)),
    [threads],
  );

  useEffect(() => {
    if (routeSearch.environmentId) setActiveEnvironmentId(routeSearch.environmentId);
  }, [routeSearch.environmentId]);

  const listTarget =
    environmentId && capabilities
      ? serverEnvironment.automationsList({ environmentId, input: {} })
      : null;
  const listQuery = useEnvironmentQuery(listTarget);
  const automations = listQuery.data?.automations ?? EMPTY_AUTOMATIONS;
  const [filter, setFilter] = useState<AutomationFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<AutomationId | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(null);
  const [openingChat, setOpeningChat] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastSeen, setLastSeen] = useLocalStorage(LAST_SEEN_KEY, {}, LAST_SEEN_SCHEMA);

  const visibleAutomations = useMemo(
    () => filterAutomations(automations, filter, query, projectTitleById),
    [automations, filter, projectTitleById, query],
  );
  const selectedAutomation =
    visibleAutomations.find((automation) => automation.automationId === selectedId) ??
    visibleAutomations[0] ??
    null;

  useEffect(() => {
    if (selectedAutomation && selectedAutomation.automationId !== selectedId) {
      setSelectedId(selectedAutomation.automationId);
    }
  }, [selectedAutomation, selectedId]);

  useEffect(() => {
    if (!selectedAutomation) return;
    const id = selectedAutomation.automationId as string;
    if (lastSeen[id] && lastSeen[id] >= selectedAutomation.updatedAt) return;
    setLastSeen((current) => ({ ...current, [id]: selectedAutomation.updatedAt }));
  }, [lastSeen, selectedAutomation, setLastSeen]);

  useEffect(() => {
    if (!routeSearch.create || !environmentId || projects.length === 0) return;
    setEditingAutomation(null);
    setEditorOpen(true);
  }, [environmentId, projects.length, routeSearch.create]);

  const runsTarget =
    environmentId && selectedAutomation
      ? serverEnvironment.automationsListRuns({
          environmentId,
          input: { automationId: selectedAutomation.automationId, limit: 100 },
        })
      : null;
  const runsQuery = useEnvironmentQuery(runsTarget);
  const runs = runsQuery.data?.runs ?? EMPTY_RUNS;

  const createAutomation = useAtomCommand(serverEnvironment.automationsCreate, {
    reportFailure: false,
  });
  const updateAutomation = useAtomCommand(serverEnvironment.automationsUpdate, {
    reportFailure: false,
  });
  const deleteAutomation = useAtomCommand(serverEnvironment.automationsDelete, {
    reportFailure: false,
  });
  const pauseAutomation = useAtomCommand(serverEnvironment.automationsPause, {
    reportFailure: false,
  });
  const resumeAutomation = useAtomCommand(serverEnvironment.automationsResume, {
    reportFailure: false,
  });
  const runAutomation = useAtomCommand(serverEnvironment.automationsRunNow, {
    reportFailure: false,
  });

  const refreshList = useCallback(() => {
    if (!environmentId) return;
    appAtomRegistry.refresh(serverEnvironment.automationsList({ environmentId, input: {} }));
  }, [environmentId]);
  const refreshRuns = useCallback(() => {
    if (!environmentId || !selectedAutomation) return;
    appAtomRegistry.refresh(
      serverEnvironment.automationsListRuns({
        environmentId,
        input: { automationId: selectedAutomation.automationId, limit: 100 },
      }),
    );
  }, [environmentId, selectedAutomation]);

  useEffect(() => {
    const id = window.setInterval(refreshList, 15_000);
    return () => window.clearInterval(id);
  }, [refreshList]);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    if (
      !runs.some(
        (run) =>
          run.status === "pending" ||
          run.status === "waiting-for-thread" ||
          run.status === "running",
      )
    ) {
      return;
    }
    const id = window.setTimeout(() => {
      refreshRuns();
      refreshList();
    }, 2_500);
    return () => window.clearTimeout(id);
  }, [refreshList, refreshRuns, runs]);

  const handleSave = async (value: {
    readonly create: AutomationCreateInput;
    readonly update: AutomationUpdatePatch;
  }) => {
    if (!environmentId) return;
    setSaving(true);
    const result = editingAutomation
      ? await updateAutomation({
          environmentId,
          input: { automationId: editingAutomation.automationId, patch: value.update },
        })
      : await createAutomation({ environmentId, input: value.create });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        mutationError(
          editingAutomation ? "Could not save automation" : "Could not create automation",
          squashAtomCommandFailure(result),
        );
      }
      return;
    }
    setSelectedId(result.value.automationId);
    setEditorOpen(false);
    setEditingAutomation(null);
    refreshList();
    toastManager.add({
      type: "success",
      title: editingAutomation ? "Automation saved" : "Automation created",
    });
    if (routeSearch.create) {
      void navigate({ to: "/automations", search: {}, replace: true });
    }
  };

  const changeStatus = async (automation: Automation) => {
    if (!environmentId) return;
    const resume = automation.status === "paused";
    setBusyAction(`${automation.automationId}:status`);
    const result = await (resume ? resumeAutomation : pauseAutomation)({
      environmentId,
      input: { automationId: automation.automationId },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        mutationError(
          resume ? "Could not resume automation" : "Could not pause automation",
          squashAtomCommandFailure(result),
        );
      }
      return;
    }
    refreshList();
  };

  const runNow = async (automation: Automation) => {
    if (!environmentId) return;
    setBusyAction(`${automation.automationId}:run`);
    const result = await runAutomation({
      environmentId,
      input: { automationId: automation.automationId },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        mutationError("Could not start automation", squashAtomCommandFailure(result));
      }
      return;
    }
    refreshRuns();
    refreshList();
    toastManager.add({
      type: "success",
      title:
        result.value.status === "waiting-for-thread"
          ? "Automation is waiting for the task"
          : "Automation started",
    });
  };

  const removeAutomation = async (automation: Automation) => {
    if (!environmentId) return;
    const api = readLocalApi();
    const confirmed = await api?.dialogs.confirm(
      [
        `Delete automation "${automation.name}"?`,
        "Its run history will also be deleted. Tasks created by earlier runs stay available.",
      ].join("\n\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusyAction(`${automation.automationId}:delete`);
    const result = await deleteAutomation({
      environmentId,
      input: { automationId: automation.automationId },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        mutationError("Could not delete automation", squashAtomCommandFailure(result));
      }
      return;
    }
    setSelectedId(null);
    refreshList();
    toastManager.add({ type: "success", title: "Automation deleted" });
  };

  const openCreate = () => {
    if (projects.length === 0) {
      openCommandPalette({ open: "add-project" });
      return;
    }
    setEditingAutomation(null);
    setEditorOpen(true);
  };
  const createWithAgent = async () => {
    const project =
      projects.find((candidate) => candidate.id === routeSearch.projectId) ?? projects[0] ?? null;
    if (!project) {
      openCommandPalette({ open: "add-project" });
      return;
    }
    if (openingChat) return;
    setOpeningChat(true);
    try {
      const draft = await openNewThread(scopeProjectRef(project.environmentId, project.id));
      if (!draft) {
        mutationError("Could not open a task", new Error("The project is not available."));
        return;
      }
      useComposerDraftStore.getState().setPrompt(draft.draftId, AUTOMATION_CHAT_STARTER_PROMPT);
    } catch (error) {
      mutationError("Could not open a task", error);
    } finally {
      setOpeningChat(false);
    }
  };
  const openEdit = (automation: Automation) => {
    setEditingAutomation(automation);
    setEditorOpen(true);
  };

  const filterCounts = {
    all: automations.length,
    active: automations.filter((automation) => automation.status === "active").length,
    paused: automations.filter((automation) => automation.status === "paused").length,
  };

  const topbar = (
    <div className="flex w-full min-w-0 items-center gap-3">
      <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb">
        <WorkspaceBreadcrumbItem current>
          <h1>Automations</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh automations"
          onClick={() => {
            refreshList();
            refreshRuns();
          }}
        >
          <RefreshCwIcon />
        </Button>
        <AutomationCreateActions
          compact
          disabled={!capabilities}
          openingChat={openingChat}
          onCreateWithAgent={() => void createWithAgent()}
          onCreateManually={openCreate}
        />
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>{topbar}</WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-4">
            {!environmentId ? (
              <AutomationEmptyState
                title="No environment connected"
                description="Connect to a T3 Code environment before creating automations."
              />
            ) : config && !capabilities ? (
              <AutomationEmptyState
                title="Automations are not available here"
                description="This T3 Code environment does not support scheduled prompts yet."
              />
            ) : listQuery.error ? (
              <AutomationEmptyState
                title="Could not load automations"
                description={listQuery.error}
                action={<Button onClick={listQuery.refresh}>Try again</Button>}
              />
            ) : listQuery.isPending && listQuery.data === null ? (
              <div className="flex min-h-72 items-center justify-center text-sm text-muted-foreground">
                Loading automations...
              </div>
            ) : projects.length === 0 ? (
              <AutomationEmptyState
                title="Create a project first"
                description="Automations need a project so the agent knows where to work. Create one before setting up an automation."
                action={
                  <Button onClick={() => openCommandPalette({ open: "add-project" })}>
                    <PlusIcon />
                    Create project
                  </Button>
                }
              />
            ) : automations.length === 0 ? (
              <AutomationEmptyState
                title="Run prompts on a schedule"
                description="Create an automation for daily checks, recurring project work, or a one-time reminder."
                action={
                  <AutomationCreateActions
                    disabled={false}
                    openingChat={openingChat}
                    onCreateWithAgent={() => void createWithAgent()}
                    onCreateManually={openCreate}
                  />
                }
              />
            ) : (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="relative min-w-0 flex-1 sm:max-w-sm">
                    <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.currentTarget.value)}
                      placeholder="Search automations"
                      aria-label="Search automations"
                      className="pl-8"
                    />
                  </div>
                  <ToggleGroup
                    variant="segmented"
                    value={[filter]}
                    onValueChange={(values) => {
                      const value = values[0];
                      if (value === "all" || value === "active" || value === "paused") {
                        setFilter(value);
                      }
                    }}
                    aria-label="Automation status"
                  >
                    {(["all", "active", "paused"] as const).map((value) => (
                      <Toggle key={value} value={value}>
                        {value === "all" ? "All" : value === "active" ? "Active" : "Paused"}
                        <span className="ml-1 text-[10px] text-muted-foreground tabular-nums">
                          {filterCounts[value]}
                        </span>
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>

                {visibleAutomations.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
                    No automations match this search.
                  </div>
                ) : (
                  <div className="grid min-h-[34rem] overflow-hidden rounded-2xl border border-border/70 bg-card lg:grid-cols-[19rem_minmax(0,1fr)]">
                    <div className="border-b border-border/70 lg:border-b-0 lg:border-r">
                      <div className="divide-y divide-border/60">
                        {visibleAutomations.map((automation) => {
                          const unread =
                            !lastSeen[automation.automationId] ||
                            lastSeen[automation.automationId]! < automation.updatedAt;
                          return (
                            <button
                              key={automation.automationId}
                              type="button"
                              className={cn(
                                "flex w-full min-w-0 gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/50",
                                selectedAutomation?.automationId === automation.automationId &&
                                  "bg-muted/65",
                              )}
                              onClick={() => setSelectedId(automation.automationId)}
                            >
                              <span className="mt-1.5 flex size-2 shrink-0 items-center justify-center">
                                {unread ? <span className="size-2 rounded-full bg-info" /> : null}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="truncate text-sm font-medium text-foreground">
                                    {automation.name}
                                  </span>
                                  {automation.consecutiveFailures > 0 ? (
                                    <Badge variant="error" size="sm">
                                      {automation.consecutiveFailures} failed
                                    </Badge>
                                  ) : null}
                                </span>
                                <span className="mt-1 block truncate text-xs text-muted-foreground">
                                  {automationScheduleLabel(automation.schedule)}
                                </span>
                                <span className="mt-1 block truncate text-[11px] text-muted-foreground/80">
                                  {automation.status === "active"
                                    ? automationNextRunLabel(automation.nextRunAt)
                                    : automationPausedReasonLabel(automation)}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {selectedAutomation ? (
                      <AutomationDetail
                        automation={selectedAutomation}
                        runs={runs}
                        runsPending={runsQuery.isPending}
                        runsError={runsQuery.error}
                        projectTitle={
                          projectTitleById.get(selectedAutomation.projectId) ?? "Unknown project"
                        }
                        threadTitleById={threadTitleById}
                        providerLabel={
                          deriveProviderInstanceEntries(config?.providers ?? []).find(
                            (entry) =>
                              entry.instanceId ===
                              selectedAutomation.execution.modelSelection.instanceId,
                          )?.displayName ?? selectedAutomation.execution.modelSelection.instanceId
                        }
                        busyAction={busyAction}
                        onEdit={() => openEdit(selectedAutomation)}
                        onRun={() => void runNow(selectedAutomation)}
                        onStatus={() => void changeStatus(selectedAutomation)}
                        onDelete={() => void removeAutomation(selectedAutomation)}
                        onRefreshRuns={refreshRuns}
                        onOpenThread={(threadId) => {
                          if (!environmentId) return;
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: { environmentId, threadId },
                          });
                        }}
                      />
                    ) : null}
                  </div>
                )}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>

      {environmentId ? (
        <AutomationEditorDialog
          open={editorOpen}
          automation={editingAutomation}
          environmentId={environmentId}
          projects={projects}
          threads={threads}
          initialProjectId={routeSearch.projectId ?? null}
          initialThreadId={routeSearch.threadId ?? null}
          saving={saving}
          onOpenChange={(open) => {
            setEditorOpen(open);
            if (!open) {
              setEditingAutomation(null);
              if (routeSearch.create) {
                void navigate({ to: "/automations", search: {}, replace: true });
              }
            }
          }}
          onSave={(value) => void handleSave(value)}
        />
      ) : null}
    </SidebarInset>
  );
}

function AutomationEmptyState(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <Empty className="min-h-[30rem] rounded-2xl border border-dashed border-border/70">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarClockIcon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.action ? <EmptyContent>{props.action}</EmptyContent> : null}
    </Empty>
  );
}

function AutomationDetail(props: {
  readonly automation: Automation;
  readonly runs: ReadonlyArray<AutomationRun>;
  readonly runsPending: boolean;
  readonly runsError: string | null;
  readonly projectTitle: string;
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly providerLabel: string;
  readonly busyAction: string | null;
  readonly onEdit: () => void;
  readonly onRun: () => void;
  readonly onStatus: () => void;
  readonly onDelete: () => void;
  readonly onRefreshRuns: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const automation = props.automation;
  const actionPrefix = automation.automationId as string;
  const scheduleTimezone =
    automation.schedule.kind === "cron" ? automation.schedule.timezone : null;
  const destinationLabel =
    automation.destination.kind === "same-thread"
      ? `Continue ${props.threadTitleById.get(automation.destination.threadId) ?? "an existing task"}`
      : "Start a fresh task every run";
  const workspaceLabel = automation.execution.worktreePath
    ? `Worktree ${automation.execution.worktreePath}`
    : "Project checkout";

  return (
    <div className="min-w-0 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-xl font-semibold text-foreground">{automation.name}</h2>
            {statusBadge(automation)}
            {automation.consecutiveFailures > 0 ? (
              <Badge variant="error">{automation.consecutiveFailures} failed runs</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {props.projectTitle} · {automationScheduleLabel(automation.schedule)}
            {scheduleTimezone ? ` · ${scheduleTimezone}` : ""}
          </p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label="Automation actions" />}
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={props.onEdit}>
              <PencilIcon /> Edit
            </MenuItem>
            <MenuItem onClick={props.onDelete} variant="destructive">
              <Trash2Icon /> Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={props.onRun}
          disabled={props.busyAction === `${actionPrefix}:run`}
        >
          <PlayIcon />
          {props.busyAction === `${actionPrefix}:run` ? "Starting..." : "Run now"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={props.onStatus}
          disabled={
            props.busyAction === `${actionPrefix}:status` ||
            (automation.status === "paused" && !automationCanResume(automation))
          }
        >
          {automation.status === "active" ? <PauseIcon /> : <PlayIcon />}
          {automation.status === "active" ? "Pause" : "Resume"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onEdit}>
          <PencilIcon /> Edit
        </Button>
      </div>

      <dl className="mt-6 grid gap-x-8 gap-y-4 border-y border-border/60 py-5 sm:grid-cols-2">
        <DetailItem
          label="Next run"
          value={automationNextRunLabel(automation.nextRunAt).replace(/^Next /u, "")}
        />
        <DetailItem label="Result" value={destinationLabel} />
        <DetailItem label="Workspace" value={workspaceLabel} />
        <DetailItem
          label="Agent"
          value={`${props.providerLabel} · ${automation.execution.modelSelection.model}`}
        />
        <DetailItem
          label="Agent mode"
          value={
            automation.execution.interactionMode === "plan" ? "Make a plan" : "Work on the task"
          }
        />
        <DetailItem label="Permissions" value="Full access · Never ask" />
      </dl>

      <section className="mt-6">
        <h3 className="text-sm font-medium text-foreground">Prompt</h3>
        <div className="mt-2 whitespace-pre-wrap rounded-xl border border-border/60 bg-muted/25 p-4 text-sm leading-relaxed text-foreground">
          {automation.prompt}
        </div>
      </section>

      <section className="mt-7">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">Recent runs</h3>
          <span className="text-xs text-muted-foreground">Latest 100</span>
          <Button
            size="icon-xs"
            variant="ghost"
            className="ml-auto"
            aria-label="Refresh run history"
            onClick={props.onRefreshRuns}
          >
            <RefreshCwIcon />
          </Button>
        </div>
        {props.runsError ? (
          <div className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive-foreground">
            {props.runsError}
          </div>
        ) : props.runsPending && props.runs.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">Loading run history...</p>
        ) : props.runs.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            This automation has not run yet.
          </div>
        ) : (
          <div className="mt-3 divide-y divide-border/60 rounded-xl border border-border/60">
            {props.runs.map((run) => (
              <div key={run.runId} className="flex min-w-0 items-start gap-3 px-3.5 py-3">
                <div className="mt-0.5 shrink-0">{runIcon(run)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium text-foreground">
                      {automationRunLabel(run)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {run.trigger === "manual"
                        ? "Run now"
                        : run.trigger === "remote"
                          ? "Kara wake-up"
                          : "Scheduled"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {dateTimeLabel(run.scheduledFor)}
                    {run.finishedAt ? ` · finished ${formatRelativeTimeLabel(run.finishedAt)}` : ""}
                  </p>
                  {run.failureReason ? (
                    <p className="mt-1.5 text-xs leading-relaxed text-destructive-foreground">
                      {run.failureReason}
                    </p>
                  ) : null}
                </div>
                {run.threadId ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Open result task"
                    onClick={() => props.onOpenThread(run.threadId!)}
                  >
                    <ExternalLinkIcon />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="mt-6 flex items-start gap-2 rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
        Runs fail immediately if the agent asks for approval. After three consecutive failures, T3
        Code pauses this automation.
      </div>
    </div>
  );
}

function DetailItem(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </dt>
      <dd className="mt-1 truncate text-sm text-foreground">{props.value}</dd>
    </div>
  );
}
