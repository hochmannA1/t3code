import { useClientSettings } from "../../hooks/useSettings";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ThreadId, type MemoryEntry, type MemorySettingsPatch } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const SWITCHES = [
  ["enabled", "Enable memory", "Keep personal and project knowledge on this environment."],
  ["useMemories", "Use memory", "Retrieve relevant knowledge when starting a turn."],
  [
    "generateMemories",
    "Learn from conversations",
    "Extract useful knowledge from completed conversations.",
  ],
  [
    "dreaming",
    "Memory maintenance",
    "Consolidate memories daily and run a deeper review weekly while the environment is idle.",
  ],
] as const;

export function MemorySettingsSection() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.memory,
  );
  return (
    <SettingsSection id="memory" title="Memory">
      <p className="mb-4 text-sm text-muted-foreground">
        Memory belongs to each environment. Background work uses the selected model and resumes
        after the server restarts.
      </p>
      {supported.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Connect to an environment with memory support to manage its memories.
        </p>
      ) : (
        supported.map((environment) => (
          <EnvironmentMemorySettings key={environment.environmentId} environment={environment} />
        ))
      )}
    </SettingsSection>
  );
}

function EnvironmentMemorySettings({ environment }: { environment: EnvironmentPresentation }) {
  const clientSettings = useClientSettings();
  const environmentId = environment.environmentId;
  const settings = environment.serverConfig!.settings;
  const memory = settings.memory;
  const providers = environment.serverConfig!.providers;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const threads = useThreadShells().filter((thread) => thread.environmentId === environmentId);
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const query = useEnvironmentQuery(
    serverEnvironment.memoryGetState({ environmentId, input: threadId ? { threadId } : {} }),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const runNow = useAtomCommand(serverEnvironment.memoryRunNow, { reportFailure: true });
  const setPolicy = useAtomCommand(serverEnvironment.memorySetThreadPolicy, {
    reportFailure: true,
  });
  const upsert = useAtomCommand(serverEnvironment.memoryUpsert, { reportFailure: true });
  const forget = useAtomCommand(serverEnvironment.memoryForget, { reportFailure: true });
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const write = (patch: MemorySettingsPatch) =>
    void update({ environmentId, input: { patch: { memory: patch } } });
  const entries =
    query.data?.entries.filter((entry) =>
      `${entry.title} ${entry.text} ${entry.keywords.join(" ")}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) ?? [];
  const projectTitle = (projectId: string | null) =>
    projectId === null
      ? "Personal"
      : (projects.find((project) => project.id === projectId)?.title ?? "Project");
  const selection = memory.modelSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    { ...clientSettings, ...settings },
    providers,
    selection.instanceId,
    selection.model,
  );
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      query.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-6 space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">{environment.label}</h3>
      {SWITCHES.map(([key, label, description]) => (
        <SettingsRow
          key={key}
          title={label}
          description={description}
          control={
            <Switch
              aria-label={`${label} on ${environment.label}`}
              checked={memory[key]}
              onCheckedChange={(value) => write({ [key]: Boolean(value) })}
            />
          }
        />
      ))}
      <SettingsRow
        title="Memory model"
        description="Used for extraction, daily consolidation, and weekly dreaming. If unavailable, processing waits until you choose an available model."
        control={
          <ProviderModelPicker
            activeInstanceId={selection.instanceId}
            model={selection.model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            triggerVariant="outline"
            triggerAriaLabel="Memory model"
            onInstanceModelChange={(instanceId, model) =>
              write({ modelSelection: createModelSelection(instanceId, model) })
            }
          />
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["idleMinutes", "Idle minutes before processing", 1, 1440],
            ["maxSourcesPerPass", "Conversations per pass", 1, 20],
            ["maxContextTokens", "Memory context token limit", 256, 8192],
          ] as const
        ).map(([key, label, min, max]) => (
          <label key={key} className="space-y-1 text-sm">
            {label}
            <Input
              type="number"
              key={memory[key]}
              defaultValue={memory[key]}
              min={min}
              max={max}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (
                  Number.isInteger(value) &&
                  value >= min &&
                  value <= max &&
                  value !== memory[key]
                )
                  write({ [key]: value });
              }}
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={busy || query.data?.status.running || !memory.enabled}
          onClick={() => void perform(() => runNow({ environmentId, input: {} }))}
        >
          Run maintenance now
        </Button>
        <Button variant="ghost" onClick={query.refresh}>
          Refresh
        </Button>
        <span className="text-sm text-muted-foreground">
          {query.data?.status.running
            ? "Processing memories"
            : query.data?.status.backfillCompletedAt
              ? `${query.data.status.pendingSources} conversations pending`
              : "Reviewing previous conversations"}
          {query.data?.status.lastConsolidatedAt
            ? ` · Daily consolidation ${new Date(query.data.status.lastConsolidatedAt).toLocaleString()}`
            : ""}
          {query.data?.status.lastDreamedAt
            ? ` · Weekly dream ${new Date(query.data.status.lastDreamedAt).toLocaleString()}`
            : ""}
          {query.data?.status.failedSources
            ? ` · ${query.data.status.failedSources} need retry`
            : ""}
        </span>
      </div>
      {query.error || query.data?.status.lastError ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error ?? query.data?.status.lastError}
        </p>
      ) : null}
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">Conversation controls</summary>
        <label className="block text-sm">
          Conversation
          <select
            className="mt-1 w-full rounded border bg-background p-2"
            value={threadId ?? ""}
            onChange={(event) =>
              setThreadId(event.target.value ? ThreadId.make(event.target.value) : null)
            }
          >
            <option value="">Choose a conversation</option>
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title}
              </option>
            ))}
          </select>
        </label>
        {threadId && query.data ? (
          <>
            {(["useMemories", "generateMemories"] as const).map((key) => (
              <SettingsRow
                key={key}
                title={
                  key === "useMemories"
                    ? "Use memory in this conversation"
                    : "Learn from this conversation"
                }
                control={
                  <Switch
                    disabled={busy}
                    checked={query.data!.threadPolicy[key]}
                    onCheckedChange={(value) =>
                      void perform(() =>
                        setPolicy({
                          environmentId,
                          input: { threadId, ...query.data!.threadPolicy, [key]: Boolean(value) },
                        }),
                      )
                    }
                  />
                }
              />
            ))}
          </>
        ) : null}
      </details>
      <Input
        aria-label="Search memories"
        placeholder="Search memories"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="max-h-[32rem] space-y-3 overflow-y-auto">
        {entries.map((entry) => (
          <article key={entry.id} className="space-y-2 rounded border p-3">
            <div className="flex justify-between gap-2">
              <h4 className="font-medium">{entry.title}</h4>
              <span className="text-xs text-muted-foreground">
                {projectTitle(entry.projectId)}
                {entry.pinned ? " · Pinned" : ""}
              </span>
            </div>
            {editing?.id === entry.id ? (
              <>
                <Input
                  aria-label="Memory title"
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <Textarea
                  aria-label="Memory text"
                  maxLength={12000}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
                <Button
                  disabled={busy || !title.trim() || !text.trim()}
                  onClick={() =>
                    void perform(async () => {
                      const result = await upsert({
                        environmentId,
                        input: { ...entry, title: title.trim(), text: text.trim() },
                      });
                      if (result._tag === "Success") setEditing(null);
                    })
                  }
                >
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <p className="whitespace-pre-wrap text-sm">{entry.text}</p>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Sources ({entry.sourceIds.length})
              </summary>
              <ul className="break-all text-xs text-muted-foreground">
                {entry.sourceIds.map((id) => (
                  <li key={id}>
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: ThreadId.make(id.split("/")[0]!) }}
                      className="underline"
                    >
                      {threads.find((thread) => thread.id === id.split("/")[0])?.title ?? id}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(entry);
                  setTitle(entry.title);
                  setText(entry.text);
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void perform(() =>
                    upsert({ environmentId, input: { ...entry, pinned: !entry.pinned } }),
                  )
                }
              >
                {entry.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void perform(() => forget({ environmentId, input: { id: entry.id } }))
                }
              >
                Forget
              </Button>
            </div>
          </article>
        ))}
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No memories found. Completed conversations will be processed when learning is enabled.
          </p>
        ) : null}
      </div>
      <p className="break-all text-xs text-muted-foreground">
        {query.data?.status.memoryDirectory}
      </p>
    </div>
  );
}
