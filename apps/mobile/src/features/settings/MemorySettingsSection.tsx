import { useState } from "react";
import { Pressable, View } from "react-native";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { ThreadId, type MemoryEntry, type MemorySettingsPatch } from "@t3tools/contracts";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useThreadShells, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildModelOptions } from "../../lib/modelOptions";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const SWITCHES = [
  ["enabled", "Enable memory"],
  ["useMemories", "Use memory"],
  ["generateMemories", "Learn from conversations"],
  ["dreaming", "Memory maintenance"],
] as const;

function Action({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className={disabled ? "p-3 opacity-40" : "p-3"}
    >
      <Text className="text-accent">{label}</Text>
    </Pressable>
  );
}

export function MemorySettingsSection() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.memory,
  );
  return (
    <SettingsSection title="Memory">
      <Text className="p-4 text-sm text-foreground-muted">
        Memory belongs to each environment. Background work uses the selected model and resumes
        after the server restarts.
      </Text>
      {supported.length === 0 ? (
        <Text className="p-4 text-foreground-muted">
          Connect to an environment with memory support to manage its memories.
        </Text>
      ) : (
        supported.map((environment) => (
          <EnvironmentMemorySettings key={environment.environmentId} environment={environment} />
        ))
      )}
    </SettingsSection>
  );
}

function EnvironmentMemorySettings({ environment }: { environment: EnvironmentPresentation }) {
  const navigation = useNavigation();
  const environmentId = environment.environmentId;
  const config = environment.serverConfig!;
  const memory = config.settings.memory;
  const [expanded, setExpanded] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const threads = useThreadShells().filter((thread) => thread.environmentId === environmentId);
  const query = useEnvironmentQuery(
    expanded
      ? serverEnvironment.memoryGetState({ environmentId, input: threadId ? { threadId } : {} })
      : null,
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const runNow = useAtomCommand(serverEnvironment.memoryRunNow, { reportFailure: true });
  const setPolicy = useAtomCommand(serverEnvironment.memorySetThreadPolicy, {
    reportFailure: true,
  });
  const upsert = useAtomCommand(serverEnvironment.memoryUpsert, { reportFailure: true });
  const forget = useAtomCommand(serverEnvironment.memoryForget, { reportFailure: true });
  const write = (patch: MemorySettingsPatch) =>
    void update({ environmentId, input: { patch: { memory: patch } } });
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      query.refresh();
    } finally {
      setBusy(false);
    }
  };
  const entries =
    query.data?.entries.filter((entry) =>
      `${entry.title} ${entry.text} ${entry.keywords.join(" ")}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) ?? [];
  return (
    <View className="border-t border-border">
      <Action
        label={`${environment.label} · ${expanded ? "Hide" : "Manage memory"}`}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <>
          {SWITCHES.map(([key, label]) => (
            <SettingsSwitchRow
              key={key}
              icon="brain"
              label={label}
              value={memory[key]}
              onValueChange={(value) => write({ [key]: value })}
            />
          ))}
          <Action
            label={`Memory model: ${memory.modelSelection.instanceId} / ${memory.modelSelection.model}`}
            onPress={() => setShowModels(!showModels)}
          />
          <Text className="px-4 text-sm text-foreground-muted">
            Extraction, daily consolidation, and weekly dreaming use this model. Processing waits
            when it is unavailable.
          </Text>
          {showModels
            ? buildModelOptions(config, memory.modelSelection).map((option) => (
                <Pressable
                  key={option.key}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked:
                      option.selection.instanceId === memory.modelSelection.instanceId &&
                      option.selection.model === memory.modelSelection.model,
                  }}
                  onPress={() => {
                    write({ modelSelection: option.selection });
                    setShowModels(false);
                  }}
                  className="p-4"
                >
                  <Text className="text-foreground">
                    {option.providerLabel} · {option.label}
                  </Text>
                </Pressable>
              ))
            : null}
          {(
            [
              ["idleMinutes", "Idle minutes before processing", 1, 1440],
              ["maxSourcesPerPass", "Conversations per pass", 1, 20],
              ["maxContextTokens", "Memory context token limit", 256, 8192],
            ] as const
          ).map(([key, label, min, max]) => (
            <View key={key} className="p-4">
              <Text className="text-foreground">{label}</Text>
              <TextInput
                key={memory[key]}
                accessibilityLabel={label}
                defaultValue={String(memory[key])}
                keyboardType="number-pad"
                className="rounded-lg border border-border p-3 text-foreground"
                onEndEditing={(event) => {
                  const value = Number(event.nativeEvent.text);
                  if (
                    Number.isInteger(value) &&
                    value >= min &&
                    value <= max &&
                    value !== memory[key]
                  )
                    write({ [key]: value });
                }}
              />
            </View>
          ))}
          <View className="flex-row">
            <Action
              label="Run maintenance now"
              disabled={busy || query.data?.status.running || !memory.enabled}
              onPress={() => void perform(() => runNow({ environmentId, input: {} }))}
            />
            <Action label="Refresh" onPress={query.refresh} />
          </View>
          <Text className="px-4 text-sm text-foreground-muted">
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
          </Text>
          {query.error || query.data?.status.lastError ? (
            <Text accessibilityRole="alert" className="p-4 text-destructive">
              {query.error ?? query.data?.status.lastError}
            </Text>
          ) : null}
          <Action
            label={
              threadId
                ? `Conversation: ${threads.find((thread) => thread.id === threadId)?.title ?? threadId}`
                : "Conversation controls"
            }
            onPress={() => setShowThreads(!showThreads)}
          />
          {showThreads ? (
            <>
              <Action
                label="All memories"
                onPress={() => {
                  setThreadId(null);
                  setShowThreads(false);
                }}
              />
              {threads.map((thread) => (
                <Action
                  key={thread.id}
                  label={thread.title}
                  onPress={() => {
                    setThreadId(thread.id);
                    setShowThreads(false);
                  }}
                />
              ))}
            </>
          ) : null}
          {threadId && query.data ? (
            <>
              {(["useMemories", "generateMemories"] as const).map((key) => (
                <SettingsSwitchRow
                  key={key}
                  icon="brain"
                  label={
                    key === "useMemories"
                      ? "Use memory in this conversation"
                      : "Learn from this conversation"
                  }
                  disabled={busy}
                  value={query.data!.threadPolicy[key]}
                  onValueChange={(value) =>
                    void perform(() =>
                      setPolicy({
                        environmentId,
                        input: { threadId, ...query.data!.threadPolicy, [key]: value },
                      }),
                    )
                  }
                />
              ))}
            </>
          ) : null}
          <TextInput
            accessibilityLabel="Search memories"
            placeholder="Search memories"
            value={filter}
            onChangeText={setFilter}
            className="m-4 rounded-lg border border-border p-3 text-foreground"
          />
          {entries.map((entry) => (
            <View key={entry.id} className="gap-2 border-t border-border p-4">
              <Text className="font-semibold text-foreground">{entry.title}</Text>
              <Text className="text-xs text-foreground-muted">
                {entry.projectId
                  ? (projects.find((project) => project.id === entry.projectId)?.title ?? "Project")
                  : "Personal"}
                {entry.pinned ? " · Pinned" : ""}
              </Text>
              {editing?.id === entry.id ? (
                <>
                  <TextInput
                    accessibilityLabel="Memory title"
                    maxLength={200}
                    value={title}
                    onChangeText={setTitle}
                    className="rounded border border-border p-3 text-foreground"
                  />
                  <TextInput
                    accessibilityLabel="Memory text"
                    maxLength={12000}
                    multiline
                    value={text}
                    onChangeText={setText}
                    className="rounded border border-border p-3 text-foreground"
                  />
                  <View className="flex-row">
                    <Action
                      label="Save"
                      disabled={busy || !title.trim() || !text.trim()}
                      onPress={() =>
                        void perform(async () => {
                          const result = await upsert({
                            environmentId,
                            input: { ...entry, title: title.trim(), text: text.trim() },
                          });
                          if (result._tag === "Success") setEditing(null);
                        })
                      }
                    />
                    <Action label="Cancel" onPress={() => setEditing(null)} />
                  </View>
                </>
              ) : (
                <Text className="text-foreground">{entry.text}</Text>
              )}
              {entry.sourceIds.map((sourceId) => (
                <Action
                  key={sourceId}
                  label={`Source: ${threads.find((thread) => thread.id === sourceId.split("/")[0])?.title ?? sourceId}`}
                  onPress={() =>
                    navigation.dispatch(
                      CommonActions.navigate("Thread", {
                        environmentId,
                        threadId: ThreadId.make(sourceId.split("/")[0]!),
                      }),
                    )
                  }
                />
              ))}
              <View className="flex-row">
                <Action
                  label="Edit"
                  disabled={busy}
                  onPress={() => {
                    setEditing(entry);
                    setTitle(entry.title);
                    setText(entry.text);
                  }}
                />
                <Action
                  label={entry.pinned ? "Unpin" : "Pin"}
                  disabled={busy}
                  onPress={() =>
                    void perform(() =>
                      upsert({ environmentId, input: { ...entry, pinned: !entry.pinned } }),
                    )
                  }
                />
                <Action
                  label="Forget"
                  disabled={busy}
                  onPress={() =>
                    void perform(() => forget({ environmentId, input: { id: entry.id } }))
                  }
                />
              </View>
            </View>
          ))}
          {entries.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              No memories found. Completed conversations will be processed when learning is enabled.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
