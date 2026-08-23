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
import { ChevronDownIcon, SparklesIcon } from "lucide-react";
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
  resolveWorkComplexity,
  type WorkComplexity,
} from "../../workExperience";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { WorkComplexityControl } from "../work/WorkComplexityControl";
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
import { Field, FieldDescription, FieldLabel } from "../ui/field";
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
import {
  AUTOMATION_PROMPT_STARTERS,
  automationNameFromPrompt,
  automationTimezones,
} from "./automationCreation";

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
  const workCodexEntry = useMemo(
    () => resolveWorkCodexInstance(entries, fallbackModelSelection.instanceId),
    [entries, fallbackModelSelection.instanceId],
  );
  const workFallbackModelSelection = useMemo(
    () =>
      appExperience === "work" && workCodexEntry
        ? createWorkModelSelection(DEFAULT_WORK_COMPLEXITY, workCodexEntry.instanceId)
        : null,
    [appExperience, workCodexEntry],
  );

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
  const timezones = useMemo(() => automationTimezones(schedule.timezone), [schedule.timezone]);
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
  const workComplexity = workCodexEntry
    ? (resolveWorkComplexity(modelSelection, workCodexEntry.instanceId) ?? DEFAULT_WORK_COMPLEXITY)
    : DEFAULT_WORK_COMPLEXITY;

  const selectProject = (nextProjectId: ProjectId) => {
    const project = props.projects.find((candidate) => candidate.id === nextProjectId) ?? null;
    const firstThread = props.threads.find(
      (thread) => thread.projectId === nextProjectId && thread.archivedAt === null,
    );
    setProjectId(nextProjectId);
    setTargetThreadId(firstThread?.id ?? null);
    if (!firstThread) setDestinationKind("new-thread");
    setWorkspaceThreadId(null);
    const nextSelection = resolveDefaultProviderModelSelection(
      providers,
      project?.defaultModelSelection,
    );
    if (nextSelection) setModelSelection(nextSelection);
  };

  const selectPromptStarter = (starter: (typeof AUTOMATION_PROMPT_STARTERS)[number]) => {
    setPrompt(starter.prompt);
    if (!name.trim()) setName(starter.name);
  };

  const selectWorkComplexity = (complexity: WorkComplexity) => {
    if (!workCodexEntry) return;
    setModelSelection(createWorkModelSelection(complexity, workCodexEntry.instanceId));
  };

  const submit = () => {
    const trimmedPrompt = prompt.trim();
    const trimmedName = name.trim() || automationNameFromPrompt(trimmedPrompt);
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
    const preserveHiddenWorkspace = appExperience === "work" && props.automation !== null;
    const destination =
      destinationKind === "same-thread"
        ? ({ kind: "same-thread", threadId: targetThread!.id } as const)
        : ({ kind: "new-thread" } as const);
    const execution = {
      modelSelection,
      runtimeMode: "full-access" as const,
      approvalPolicy: "never" as const,
      interactionMode: appExperience === "work" ? ("default" as const) : interactionMode,
      responseProfile: props.automation?.execution.responseProfile ?? appExperience,
      branch:
        workspace?.branch ??
        (preserveHiddenWorkspace ? (props.automation?.execution.branch ?? null) : null),
      worktreePath:
        workspace?.worktreePath ??
        (preserveHiddenWorkspace ? (props.automation?.execution.worktreePath ?? null) : null),
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
      <DialogPopup className="w-[min(64rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>{props.automation ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>
            Describe the recurring work. The settings on the right control when and where it runs.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(17rem,0.85fr)]">
            <section className="min-w-0">
              <Field>
                <FieldLabel>What should happen?</FieldLabel>
                <Textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                  placeholder="Review the latest project state and tell me what needs attention."
                  className="min-h-64 resize-y text-base leading-relaxed"
                  autoFocus
                />
                <FieldDescription>
                  Write the instructions exactly as the agent should receive them.
                </FieldDescription>
              </Field>

              <div className="mt-4">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <SparklesIcon className="size-3.5" />
                  Start with an example
                </div>
                <div className="flex flex-wrap gap-2">
                  {AUTOMATION_PROMPT_STARTERS.map((starter) => (
                    <button
                      key={starter.label}
                      type="button"
                      className="rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                      onClick={() => selectPromptStarter(starter)}
                    >
                      {starter.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <aside className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
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

              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-foreground">Schedule</legend>
                <Select
                  value={schedule.choice}
                  onValueChange={(value) => {
                    if (
                      value === "once" ||
                      value === "interval" ||
                      value === "daily" ||
                      value === "weekdays" ||
                      value === "weekly" ||
                      value === "custom"
                    ) {
                      setSchedule(updateScheduleDraft(schedule, "choice", value));
                      if (value === "custom") setAdvancedOpen(true);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {schedule.choice === "custom"
                        ? "Custom schedule"
                        : FRIENDLY_SCHEDULES.find((option) => option.value === schedule.choice)
                            ?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {FRIENDLY_SCHEDULES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">Custom schedule</SelectItem>
                  </SelectPopup>
                </Select>

                {schedule.choice === "once" ? (
                  <Field>
                    <FieldLabel>Date and time</FieldLabel>
                    <Input
                      nativeInput
                      type="datetime-local"
                      value={schedule.onceAt}
                      onChange={(event) =>
                        setSchedule(
                          updateScheduleDraft(schedule, "onceAt", event.currentTarget.value),
                        )
                      }
                    />
                  </Field>
                ) : schedule.choice === "interval" ? (
                  <div className="flex flex-col gap-2">
                    <Field>
                      <FieldLabel>Repeat every</FieldLabel>
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,7.5rem)] gap-2">
                        <Input
                          nativeInput
                          inputMode="numeric"
                          value={schedule.everyValue}
                          onChange={(event) =>
                            setSchedule(
                              updateScheduleDraft(
                                schedule,
                                "everyValue",
                                event.currentTarget.value,
                              ),
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
                          <SelectTrigger className="min-w-0">
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
                  </div>
                ) : schedule.choice !== "custom" ? (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
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
                          setSchedule(
                            updateScheduleDraft(schedule, "time", event.currentTarget.value),
                          )
                        }
                      />
                    </Field>
                  </div>
                ) : null}
                {schedule.choice !== "once" && schedule.choice !== "interval" ? (
                  <Field>
                    <FieldLabel>Timezone</FieldLabel>
                    <Select
                      value={schedule.timezone}
                      onValueChange={(value) => {
                        if (value) {
                          setSchedule(updateScheduleDraft(schedule, "timezone", value));
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue>{schedule.timezone.replaceAll("_", " ")}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {timezones.map((timezone) => (
                          <SelectItem key={timezone} value={timezone}>
                            {timezone.replaceAll("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Field>
                ) : null}
              </fieldset>

              <Field>
                <FieldLabel>Results</FieldLabel>
                <Select
                  value={destinationKind}
                  onValueChange={(value) => {
                    if (
                      value === "new-thread" ||
                      (value === "same-thread" && projectThreads.length)
                    ) {
                      setDestinationKind(value);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {destinationKind === "same-thread"
                        ? "Continue one task"
                        : "New task each run"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value="new-thread">New task each run</SelectItem>
                    {projectThreads.length > 0 ? (
                      <SelectItem value="same-thread">Continue one task</SelectItem>
                    ) : null}
                  </SelectPopup>
                </Select>
                {destinationKind === "same-thread" && projectThreads.length > 0 ? (
                  <div className="mt-2">
                    <Select
                      value={targetThreadId ?? undefined}
                      onValueChange={(value) =>
                        setTargetThreadId((value as ThreadId | null) ?? null)
                      }
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
                  </div>
                ) : null}
              </Field>

              {appExperience === "work" ? (
                <Field>
                  <FieldLabel>Task complexity</FieldLabel>
                  <div className="flex h-9 items-center rounded-lg border border-input bg-popover px-2">
                    <WorkComplexityControl
                      value={workComplexity}
                      onValueChange={selectWorkComplexity}
                      disabled={!workCodexEntry}
                      className="ms-0"
                      aria-label="Automation task complexity"
                    />
                  </div>
                </Field>
              ) : (
                <Field>
                  <FieldLabel>Agent</FieldLabel>
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-input bg-popover p-2">
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
                </Field>
              )}

              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronDownIcon
                    className={`size-3.5 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                  />
                  Advanced
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="mt-3 flex flex-col gap-3 border-t border-border/60 pt-3">
                    <Field>
                      <FieldLabel>Name</FieldLabel>
                      <Input
                        value={name}
                        onChange={(event) => setName(event.currentTarget.value)}
                        placeholder={automationNameFromPrompt(prompt)}
                      />
                      <FieldDescription>
                        Optional. T3 Code can derive this from the prompt.
                      </FieldDescription>
                    </Field>

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
                        <FieldDescription>Minute, hour, day, month, weekday.</FieldDescription>
                      </Field>
                    ) : null}

                    {appExperience !== "work" ? (
                      <>
                        <Field>
                          <FieldLabel>Agent mode</FieldLabel>
                          <Select
                            value={interactionMode}
                            onValueChange={(value) => {
                              if (value === "default" || value === "plan") {
                                setInteractionMode(value);
                              }
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

                        {destinationKind === "new-thread" ? (
                          <Field>
                            <FieldLabel>Run in</FieldLabel>
                            <Select
                              value={workspaceThreadId ?? "project"}
                              onValueChange={(value) =>
                                setWorkspaceThreadId(
                                  value && value !== "project" ? (value as ThreadId) : null,
                                )
                              }
                            >
                              <SelectTrigger>
                                <SelectValue>
                                  {workspaceThread?.worktreePath
                                    ? `Existing worktree from ${workspaceThread.title}`
                                    : "Project checkout"}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectPopup alignItemWithTrigger={false}>
                                <SelectItem value="project">Project checkout</SelectItem>
                                {workspaceThreads.map((thread) => (
                                  <SelectItem key={thread.id} value={thread.id}>
                                    {thread.worktreePath ? "Existing worktree" : "Project checkout"}{" "}
                                    from {thread.title}
                                  </SelectItem>
                                ))}
                              </SelectPopup>
                            </Select>
                          </Field>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            </aside>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
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
