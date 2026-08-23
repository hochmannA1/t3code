import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdatePatch,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Project, ThreadShell } from "../../types";
import { mergeEnvironmentSettings, useClientSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import { environmentServerConfigsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import {
  createWorkModelSelection,
  DEFAULT_WORK_COMPLEXITY,
  resolveWorkCodexInstance,
} from "../../workExperience";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  automationScheduleDraft,
  buildAutomationSchedule,
  defaultAutomationScheduleDraft,
  type AutomationScheduleChoice,
  type AutomationScheduleDraft,
} from "./automationPresentation";

interface AutomationEditorValue {
  readonly create: AutomationCreateInput;
  readonly update: AutomationUpdatePatch;
}

interface AutomationEditorDialogProps {
  readonly open: boolean;
  readonly automation: Automation | null;
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly initialProjectId: ProjectId | null;
  readonly initialThreadId: ThreadId | null;
  readonly saving: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (value: AutomationEditorValue) => void;
}

const FRIENDLY_SCHEDULES: ReadonlyArray<{
  readonly value: Exclude<AutomationScheduleChoice, "custom">;
  readonly label: string;
}> = [
  { value: "once", label: "Once" },
  { value: "interval", label: "Every..." },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
];

const WEEKDAYS = [
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
  ["0", "Sunday"],
] as const;

function fieldClass(selected: boolean): string {
  return selected
    ? "border-primary/50 bg-primary/6 text-foreground ring-1 ring-primary/20"
    : "border-border/70 bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground";
}

function updateScheduleDraft<K extends keyof AutomationScheduleDraft>(
  draft: AutomationScheduleDraft,
  key: K,
  value: AutomationScheduleDraft[K],
): AutomationScheduleDraft {
  return { ...draft, [key]: value };
}

function initialSelection(input: {
  readonly automation: Automation | null;
  readonly project: Project | null;
  readonly initialThread: ThreadShell | null;
  readonly fallback: ModelSelection;
  readonly workFallback: ModelSelection | null;
  readonly providers: Parameters<typeof resolveDefaultProviderModelSelection>[0];
}): ModelSelection {
  return (
    input.automation?.execution.modelSelection ??
    input.initialThread?.modelSelection ??
    input.workFallback ??
    resolveDefaultProviderModelSelection(input.providers, input.project?.defaultModelSelection) ??
    input.fallback
  );
}

export function AutomationEditorDialog(props: AutomationEditorDialogProps) {
  const configByEnvironment = useAtomValue(environmentServerConfigsAtom);
  const config = configByEnvironment.get(props.environmentId) ?? null;
  const clientSettings = useClientSettings();
  const settings = useMemo(
    () => mergeEnvironmentSettings(config?.settings ?? DEFAULT_SERVER_SETTINGS, clientSettings),
    [clientSettings, config?.settings],
  );
  const appExperience = useUiStateStore((state) => state.appExperience);
  const providers = config?.providers ?? [];
  const entries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const fallbackModelSelection = useMemo(
    () => resolveAppModelSelectionState(settings, providers),
    [providers, settings],
  );
  const workFallbackModelSelection = useMemo(() => {
    if (appExperience !== "work") return null;
    const instance = resolveWorkCodexInstance(entries, fallbackModelSelection.instanceId);
    return instance ? createWorkModelSelection(DEFAULT_WORK_COMPLEXITY, instance.instanceId) : null;
  }, [appExperience, entries, fallbackModelSelection.instanceId]);

  const fallbackProject =
    props.projects.find((project) => project.id === props.initialProjectId) ??
    props.projects[0] ??
    null;
  const initialThread = props.threads.find((thread) => thread.id === props.initialThreadId) ?? null;

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(fallbackProject?.id ?? null);
  const [destinationKind, setDestinationKind] = useState<"same-thread" | "new-thread">(
    initialThread ? "same-thread" : "new-thread",
  );
  const [targetThreadId, setTargetThreadId] = useState<ThreadId | null>(initialThread?.id ?? null);
  const [workspaceThreadId, setWorkspaceThreadId] = useState<ThreadId | null>(null);
  const [schedule, setSchedule] = useState(() => defaultAutomationScheduleDraft());
  const [modelSelection, setModelSelection] = useState<ModelSelection>(() =>
    initialSelection({
      automation: props.automation,
      project: fallbackProject,
      initialThread,
      fallback: fallbackModelSelection,
      workFallback: workFallbackModelSelection,
      providers,
    }),
  );
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const automationProject =
      props.projects.find((project) => project.id === props.automation?.projectId) ??
      fallbackProject;
    const destinationThreadId =
      props.automation?.destination.kind === "same-thread"
        ? props.automation.destination.threadId
        : (initialThread?.id ?? null);
    const destinationThread =
      props.threads.find((thread) => thread.id === destinationThreadId) ?? null;
    const matchingWorkspaceThread = props.threads.find(
      (thread) =>
        thread.projectId === automationProject?.id &&
        (thread.worktreePath !== null || thread.branch !== null) &&
        thread.worktreePath === props.automation?.execution.worktreePath &&
        thread.branch === props.automation?.execution.branch,
    );
    setName(props.automation?.name ?? "");
    setPrompt(props.automation?.prompt ?? "");
    setProjectId(automationProject?.id ?? null);
    setDestinationKind(
      props.automation?.destination.kind ?? (initialThread ? "same-thread" : "new-thread"),
    );
    setTargetThreadId(destinationThreadId);
    setWorkspaceThreadId(
      matchingWorkspaceThread?.id ??
        (!props.automation && destinationThread ? destinationThread.id : null),
    );
    setSchedule(
      props.automation
        ? automationScheduleDraft(props.automation.schedule)
        : defaultAutomationScheduleDraft(),
    );
    setModelSelection(
      initialSelection({
        automation: props.automation,
        project: automationProject,
        initialThread: destinationThread,
        fallback: fallbackModelSelection,
        workFallback: workFallbackModelSelection,
        providers,
      }),
    );
    setInteractionMode(props.automation?.execution.interactionMode ?? "default");
    setAdvancedOpen(
      props.automation
        ? automationScheduleDraft(props.automation.schedule).choice === "custom"
        : false,
    );
    setError(null);
  }, [
    fallbackModelSelection,
    fallbackProject,
    initialThread,
    props.automation,
    props.open,
    props.projects,
    props.threads,
    providers,
    workFallbackModelSelection,
  ]);

  const selectedProject = props.projects.find((project) => project.id === projectId) ?? null;
  const projectThreads = props.threads.filter(
    (thread) => thread.projectId === projectId && thread.archivedAt === null,
  );
  const workspaceThreads = projectThreads.filter(
    (thread, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.worktreePath === thread.worktreePath && candidate.branch === thread.branch,
      ) === index,
  );
  const targetThread = projectThreads.find((thread) => thread.id === targetThreadId) ?? null;
  const workspaceThread =
    workspaceThreads.find((thread) => thread.id === workspaceThreadId) ?? null;
  const activeEntry =
    entries.find((entry) => entry.instanceId === modelSelection.instanceId) ?? null;

  const selectProject = (nextProjectId: ProjectId) => {
    const project = props.projects.find((candidate) => candidate.id === nextProjectId) ?? null;
    const firstThread = props.threads.find(
      (thread) => thread.projectId === nextProjectId && thread.archivedAt === null,
    );
    setProjectId(nextProjectId);
    setTargetThreadId(firstThread?.id ?? null);
    setWorkspaceThreadId(null);
    const nextSelection = resolveDefaultProviderModelSelection(
      providers,
      project?.defaultModelSelection,
    );
    if (nextSelection) setModelSelection(nextSelection);
  };

  const submit = () => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) {
      setError("Give this automation a name.");
      return;
    }
    if (!trimmedPrompt) {
      setError("Write the prompt the agent should run.");
      return;
    }
    if (!projectId || !selectedProject) {
      setError("Choose a project.");
      return;
    }
    if (destinationKind === "same-thread" && !targetThread) {
      setError("Choose the task this automation should continue.");
      return;
    }
    if (!activeEntry || !modelSelection.model.trim()) {
      setError("Choose an available model.");
      return;
    }
    const built = buildAutomationSchedule(schedule);
    if (!built.schedule) {
      setError(built.error);
      return;
    }

    const workspace = destinationKind === "same-thread" ? targetThread : workspaceThread;
    const destination =
      destinationKind === "same-thread"
        ? ({ kind: "same-thread", threadId: targetThread!.id } as const)
        : ({ kind: "new-thread" } as const);
    const execution = {
      modelSelection,
      runtimeMode: "full-access" as const,
      approvalPolicy: "never" as const,
      interactionMode,
      responseProfile: props.automation?.execution.responseProfile ?? appExperience,
      branch: workspace?.branch ?? null,
      worktreePath: workspace?.worktreePath ?? null,
    };
    props.onSave({
      create: {
        projectId,
        name: trimmedName,
        prompt: trimmedPrompt,
        schedule: built.schedule,
        destination,
        execution,
        enabled: true,
      },
      update: {
        name: trimmedName,
        prompt: trimmedPrompt,
        schedule: built.schedule,
        destination,
        execution,
      },
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-[min(46rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>{props.automation ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>
            T3 Code will send this prompt on schedule, even when you are not watching the task.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel>Name</FieldLabel>
              <Input
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="Morning project check"
                autoFocus
              />
            </Field>

            <Field>
              <FieldLabel>Project</FieldLabel>
              <Select
                value={projectId ?? undefined}
                disabled={props.automation !== null}
                onValueChange={(value) => {
                  if (value) selectProject(value as ProjectId);
                }}
              >
                <SelectTrigger>
                  <SelectValue>{selectedProject?.title ?? "Choose a project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {props.projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field>
              <FieldLabel>Agent mode</FieldLabel>
              <Select
                value={interactionMode}
                onValueChange={(value) => {
                  if (value === "default" || value === "plan") setInteractionMode(value);
                }}
              >
                <SelectTrigger>
                  <SelectValue>
                    {interactionMode === "plan" ? "Make a plan" : "Work on the task"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value="default">Work on the task</SelectItem>
                  <SelectItem value="plan">Make a plan</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel>Prompt</FieldLabel>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              placeholder="Check the latest project state and summarize what needs attention."
              className="min-h-28"
            />
            <FieldDescription>This is sent to the agent exactly as written.</FieldDescription>
          </Field>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-foreground">When it runs</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {FRIENDLY_SCHEDULES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`min-h-10 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${fieldClass(schedule.choice === option.value)}`}
                  onClick={() => setSchedule(updateScheduleDraft(schedule, "choice", option.value))}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {schedule.choice === "once" ? (
              <Field>
                <FieldLabel>Date and time</FieldLabel>
                <Input
                  nativeInput
                  type="datetime-local"
                  value={schedule.onceAt}
                  onChange={(event) =>
                    setSchedule(updateScheduleDraft(schedule, "onceAt", event.currentTarget.value))
                  }
                />
              </Field>
            ) : schedule.choice === "interval" ? (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Field>
                  <FieldLabel>Repeat every</FieldLabel>
                  <div className="grid grid-cols-[1fr_9rem] gap-2">
                    <Input
                      nativeInput
                      inputMode="numeric"
                      value={schedule.everyValue}
                      onChange={(event) =>
                        setSchedule(
                          updateScheduleDraft(schedule, "everyValue", event.currentTarget.value),
                        )
                      }
                    />
                    <Select
                      value={schedule.everyUnit}
                      onValueChange={(value) => {
                        if (value === "minutes" || value === "hours" || value === "days") {
                          setSchedule(updateScheduleDraft(schedule, "everyUnit", value));
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue>{schedule.everyUnit}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        <SelectItem value="minutes">minutes</SelectItem>
                        <SelectItem value="hours">hours</SelectItem>
                        <SelectItem value="days">days</SelectItem>
                      </SelectPopup>
                    </Select>
                  </div>
                </Field>
                <Field>
                  <FieldLabel>Starting</FieldLabel>
                  <Input
                    nativeInput
                    type="datetime-local"
                    value={schedule.startsAt}
                    onChange={(event) =>
                      setSchedule(
                        updateScheduleDraft(schedule, "startsAt", event.currentTarget.value),
                      )
                    }
                  />
                </Field>
              </div>
            ) : schedule.choice !== "custom" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {schedule.choice === "weekly" ? (
                  <Field>
                    <FieldLabel>Day</FieldLabel>
                    <Select
                      value={schedule.weekday}
                      onValueChange={(value) => {
                        if (value) setSchedule(updateScheduleDraft(schedule, "weekday", value));
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue>
                          {WEEKDAYS.find(([value]) => value === schedule.weekday)?.[1]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {WEEKDAYS.map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel>Time</FieldLabel>
                  <Input
                    nativeInput
                    type="time"
                    value={schedule.time}
                    onChange={(event) =>
                      setSchedule(updateScheduleDraft(schedule, "time", event.currentTarget.value))
                    }
                  />
                </Field>
              </div>
            ) : null}

            {schedule.choice !== "once" && schedule.choice !== "interval" ? (
              <Field>
                <FieldLabel>Timezone</FieldLabel>
                <Input
                  value={schedule.timezone}
                  onChange={(event) =>
                    setSchedule(
                      updateScheduleDraft(schedule, "timezone", event.currentTarget.value),
                    )
                  }
                  placeholder="Europe/Vienna"
                />
                <FieldDescription>Times above use this timezone.</FieldDescription>
              </Field>
            ) : null}

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronDownIcon
                  className={`size-3.5 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                />
                Advanced
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="mt-3 rounded-xl border border-border/60 bg-muted/20 p-4">
                  <button
                    type="button"
                    className={`mb-3 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${fieldClass(schedule.choice === "custom")}`}
                    onClick={() => setSchedule(updateScheduleDraft(schedule, "choice", "custom"))}
                  >
                    Custom schedule
                  </button>
                  {schedule.choice === "custom" ? (
                    <Field>
                      <FieldLabel>Schedule expression</FieldLabel>
                      <Input
                        value={schedule.cronExpression}
                        onChange={(event) =>
                          setSchedule(
                            updateScheduleDraft(
                              schedule,
                              "cronExpression",
                              event.currentTarget.value,
                            ),
                          )
                        }
                        placeholder="0 9 * * 1-5"
                        className="font-mono"
                      />
                      <FieldDescription>
                        Uses the standard five-part minute, hour, day, month, weekday format.
                      </FieldDescription>
                    </Field>
                  ) : null}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-foreground">Where the result goes</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                className={`rounded-xl border p-4 text-left transition-colors ${fieldClass(destinationKind === "same-thread")}`}
                onClick={() => setDestinationKind("same-thread")}
              >
                <span className="block text-sm font-medium">Continue an existing task</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Every run is added to the same task.
                </span>
              </button>
              <button
                type="button"
                className={`rounded-xl border p-4 text-left transition-colors ${fieldClass(destinationKind === "new-thread")}`}
                onClick={() => setDestinationKind("new-thread")}
              >
                <span className="block text-sm font-medium">Start a fresh task every run</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Each result gets its own task and history.
                </span>
              </button>
            </div>

            {destinationKind === "same-thread" ? (
              <Field>
                <FieldLabel>Task</FieldLabel>
                <Select
                  value={targetThreadId ?? undefined}
                  onValueChange={(value) => setTargetThreadId((value as ThreadId | null) ?? null)}
                >
                  <SelectTrigger>
                    <SelectValue>{targetThread?.title ?? "Choose a task"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {projectThreads.map((thread) => (
                      <SelectItem key={thread.id} value={thread.id}>
                        {thread.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            ) : (
              <Field>
                <FieldLabel>Workspace</FieldLabel>
                <Select
                  value={workspaceThreadId ?? "project"}
                  onValueChange={(value) =>
                    setWorkspaceThreadId(value && value !== "project" ? (value as ThreadId) : null)
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {workspaceThread?.worktreePath
                        ? `Worktree from ${workspaceThread.title}`
                        : "Project checkout"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value="project">Project checkout</SelectItem>
                    {workspaceThreads.map((thread) => (
                      <SelectItem key={thread.id} value={thread.id}>
                        {thread.worktreePath ? "Worktree" : "Project checkout"} from {thread.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldDescription>
                  T3 Code saves this choice instead of following future project defaults.
                </FieldDescription>
              </Field>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-foreground">Agent</legend>
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/20 p-3">
              {activeEntry ? (
                <>
                  <ProviderModelPicker
                    activeInstanceId={modelSelection.instanceId}
                    model={modelSelection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="outline"
                    triggerAriaLabel="Automation model"
                    onInstanceModelChange={(instanceId, model) =>
                      setModelSelection({
                        instanceId,
                        model,
                        ...(instanceId === modelSelection.instanceId
                          ? { options: modelSelection.options }
                          : {}),
                      })
                    }
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind}
                    instanceId={activeEntry.instanceId}
                    models={activeEntry.models}
                    model={modelSelection.model}
                    prompt={prompt}
                    onPromptChange={setPrompt}
                    modelOptions={modelSelection.options}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    triggerVariant="outline"
                    onModelOptionsChange={(options) =>
                      setModelSelection({
                        instanceId: modelSelection.instanceId,
                        model: modelSelection.model,
                        ...(options ? { options } : {}),
                      })
                    }
                  />
                </>
              ) : (
                <span className="text-sm text-destructive-foreground">
                  No available agent provider.
                </span>
              )}
            </div>
          </fieldset>

          <div className="flex items-start gap-3 rounded-xl border border-warning/25 bg-warning/6 p-4">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Full access, never ask</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Automations run unattended with full permissions. If an agent still asks for
                approval, the run fails immediately. Three failed runs pause the automation.
              </p>
            </div>
          </div>

          {error ? <FieldError>{error}</FieldError> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={props.saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={props.saving || props.projects.length === 0}>
            {props.saving ? "Saving..." : props.automation ? "Save changes" : "Create automation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
