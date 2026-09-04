# Memory extraction, dreaming, and recall

T3 memory belongs to the server environment. It is independent of provider-native memory. Settings default to enabled, with Codex `gpt-5.6-luna` as a dedicated, configurable model. No global provider configuration or repository instruction files are rewritten.

## Read path

The public Codex memory read path was inspected at commit `89a4eec6dafce21486c5a56e6599095e7517c4b1`. Its extension combines a bounded summary with instructions that distinguish trivial requests from tasks requiring earlier decisions, repository conventions, or troubleshooting history. It recommends searching a memory index and following only the most relevant evidence links. Public source establishes the open runtime's behavior, not parity with every desktop release.

References: [read-path prompt](https://github.com/openai/codex/blob/89a4eec6dafce21486c5a56e6599095e7517c4b1/codex-rs/ext/memories/templates/memories/read_path.md), [summary loader](https://github.com/openai/codex/blob/89a4eec6dafce21486c5a56e6599095e7517c4b1/codex-rs/ext/memories/src/prompts.rs), [extension gating](https://github.com/openai/codex/blob/89a4eec6dafce21486c5a56e6599095e7517c4b1/codex-rs/ext/memories/src/extension.rs).

`MemoryContext` implements the corresponding T3 routing guidance, scoped ranking, and a hard character bound. The token setting is approximate, at four characters per token. Complete JSON records are included or skipped; notes are not cut in the middle of a fact. Serialized values escape prompt delimiters. Empty memory adds no context. Small budgets may include only abbreviated retrieval guidance.

`ProviderCommandReactor` requests context immediately before a turn. The separate `memoryContext` provider contract field is materialized at the common `ProviderService` adapter boundary. The persisted user message is unchanged. Current recall is supplied on each turn so resumption or provider compaction need not retain a previous memory fragment. This uses a bounded per-turn budget; provider history can still contain earlier recall fragments.

The credential-scoped MCP toolkit exposes `memory_search`, `memory_read`, `memory_remember`, and `memory_forget`. Each request derives its project from the authenticated thread, checks current memory settings and thread policy, and restricts access to personal and current-project entries. Search/read responses are bounded. Source IDs are `threadId/turnId`, allowing deeper investigation through thread-history tools. Retrieval is not evidence that a model actually relied on the result.

## New-task recommendations

The Work empty-draft view requests zero to two recommendations through `memory.getRecommendations`. A null project ID selects personal memory only. A concrete project ID selects personal memory plus entries for that exact project, after the server confirms that the project exists in the current environment.

Recommendation generation is a read-only `TextGeneration` operation. It uses the server's general text-generation model selection, which defaults to Codex `gpt-5.6-luna`, rather than the separate model used for memory extraction and maintenance. Codex, Claude, and OpenCode run it with the same isolated, tool-free controls as memory generation. Cursor and Grok return an explicit unsupported-operation error. Generation failures become a retryable empty result and do not block creating a task. The public read RPC cannot bypass the server cache.

The generation schema accepts only `task`, `automation`, and `page`. Server validation trims empty values, removes duplicates, and caps the result after filtering. IDs are derived from validated content. Icons come from the client-side type map; generated content cannot choose a component, URL, command, provider, project, or permission mode.

Results are persisted in the memory manifest under a freshness key derived from the prompt version, full scoped memory content, project identity, and model selection. A project-memory change therefore invalidates and removes only that project's derived result, while a personal-memory change removes every scope that includes it. Cache writes verify that their memory snapshot is still current, so forgotten content cannot be restored by an older in-flight generation. Missing results for the personal scope and up to six recently active projects are warmed after server activation, with at most two model calls running at once. Warmup runs in a background fiber and does not delay server readiness. Concurrent requests for the same fresh scope share one generation call. The persisted cache is capped at 64 results.

The web query cache is keyed by environment and project, so a response for one draft target cannot populate another target.

Selecting a recommendation copies its prompt into the current draft and focuses the composer. It does not send the prompt, create an automation, publish a page, or change the task's model or permissions. The user can edit the text before sending it through the normal turn path.

## Persistence and processing

`Fork_003_Memory` creates `t3_memory_state` in the existing SQLite database. Its manifest contains the discovery cursor, pending jobs and retry times, source references, per-thread policies, suppression records, entry metadata, and daily and weekly maintenance progress. A separate expiring lease coordinates maintenance processes. It contains no note bodies. Markdown bodies are immutable content-addressed files under `<stateDir>/memories/notes/`; the root Markdown files are generated navigation indexes.

Publication writes note bodies inside a short metadata transaction, then commits their references together with the source checkpoint. Model calls happen outside transactions. Readers see only committed references. Interrupted writes may leave unreferenced content files; index refresh removes them. A successful database commit followed by interrupted index refresh is repaired on restart. Corrupt manifests or content checksums fail closed rather than replacing memory with an empty store. Explicit Settings edits are the supported content mutation path.

Discovery reads existing projection tables without changing their schemas. A new memory store scans one latest eligible source per conversation from the oldest effective completion timestamp, including archived and settled threads, and persists explicit backfill start and completion times. Initial extraction receives a bounded transcript through that source turn. After backfill, discovery switches to newly completed individual turns. Both paths exclude streaming and deleted data and advance a timestamp/row-ID cursor together with queued work. Source revisions include message timestamps, lengths, outcome, and a content digest. A changed source is rechecked before activation. There is no production dependency on the test-only runtime receipt bus.

Sources with learning disabled are skipped while advancing discovery. Changing a thread policy removes that thread's queued or quarantined work. A source is quarantined after five failed model attempts so malformed evidence cannot block the rest of a historical backfill; manual maintenance requeues it. Metadata for sources no longer referenced by entries or jobs is pruned; explicit forgetting retains suppression IDs so replay cannot resurrect the material. Current source existence is checked before recall. Deletion or rewind trims invalid citations and removes a derived entry only when no source remains.

The worker starts after server activation and checks for work once a minute. It waits for the configured idle period and yields to active turns. Each model call has a 90-second limit; a maintenance pass has an eight-minute limit and a ten-minute lease. Both normal shutdown and lease expiry allow pending work to be retried. Publication checks ownership and optimistic manifest revision, preventing an old model result from overwriting a concurrent user edit or forget operation.

Extraction uses the configured `TextGeneration.generateMemory` operation. It consumes bounded supplied evidence and schema-validates candidates and their source IDs. Recognizable credentials are redacted before extraction and before automatic publication. Provider adapters isolate the working directory and restrict tool execution. Codex preserves configured credentials, including Azure configuration, while disabling native memory generation and inherited MCP servers for the maintenance invocation. Unsupported generation providers return an explicit error; no account or model fallback occurs.

Daily consolidation processes changed scopes in bounded batches of at most 32 entries and 80,000 source characters. A weekly dream performs a deeper review with the same evidence bounds. Both replace only the supplied batch, and persisted per-entry progress lets larger scopes continue across worker ticks and server restarts. Output source references are translated back to the original turn IDs. Pinned and manually created entries are excluded. Successful fingerprints prevent self-triggered loops; daily and weekly retry times are tracked separately from successful completion times.

Automatically learned memory is capped at 512 entries per personal or project scope. During a large first-run backfill, a full scope is consolidated in bounded batches before extraction continues. Manually created and pinned entries do not consume this automatic-processing allowance. This keeps recall for any one project bounded without letting one project stall the historical scan for the rest of the environment. A vector database is not required for the initial keyword-based search.

## Server lifecycle and clients

SQLite processing state and note files live under T3 home, so they survive ordinary server stops when T3 home is persistent. No model call is required during shutdown. Catch-up runs when the server next starts. The implementation does not require an always-on scheduler or attempt to wake stopped environments.

Memory settings and RPCs are server-owned and exposed consistently to web, desktop, and mobile. They are excluded from automatic cross-environment preference synchronization. The environment capability flag prevents older servers receiving unsupported memory RPCs.

Fork schema changes use `Fork_NNN_*` and `effect_sql_fork_migrations`. The compatibility bridge adopts recognized historical automation/repair migrations by both ID and name while preserving timestamps and data. Upstream migration IDs remain available for later upstream changes. See the migration convention in the root `AGENTS.md`.
