# Memory

T3 Code can learn useful context from completed conversations and recall it in later work. Memory and background maintenance are enabled by default. Open **Settings → General → Memory** to configure each connected environment.

Memory stays with the environment that owns the conversations. Personal memories apply across that environment's projects; project memories apply to the project and its worktrees. Connecting from another device uses the same server-owned memory. Memory is not automatically copied between environments or shared with other users.

## Choose a model

The default memory model is **Codex · gpt-5.6-luna**. The memory model picker controls extraction, daily consolidation, and weekly dreaming independently of the model used in a conversation. It uses the selected provider's existing configuration and credentials.

Codex, Claude, and OpenCode support background memory generation. Cursor and Grok conversations can contribute to and use memory, but their models cannot currently perform background memory generation. Select a supported provider for the memory model. If that provider or model is unavailable, T3 shows an error and retains pending work. It does not silently choose another provider or model.

## Reading and learning

**Use memories** controls whether T3 supplies remembered context and memory tools to agents. **Learn from conversations** controls automatic extraction. Each conversation also has separate use and learning controls in the Memory settings section.

Agents receive a small overview and relevant entries, with guidance to search deeper only when the task benefits from past decisions, preferences, or project knowledge. Simple, self-contained tasks can skip deeper lookup. Memories include source conversation and turn references. They are historical evidence; current instructions and current repository facts take precedence.

Agents can search and read memory through dedicated tools. An explicit request such as “remember this for this project” can create a pinned memory. Remembering and forgetting through agent tools require an explicit user request.

The first time memory runs in an environment, it reviews each existing conversation from oldest to newest, including archived and settled conversations. Each job receives a bounded transcript through that conversation's latest eligible turn, rather than isolated messages without their earlier context. The backfill resumes from its saved queue and cursor after a server restart. A conversation that repeatedly produces invalid output is set aside after five attempts so the rest of the history can continue; **Run maintenance now** retries it. Deleted conversations and turns without both a completed user message and final assistant reply are excluded.

Automatic extraction uses completed user messages and final assistant replies. It does not copy full tool logs, reasoning, attachments, or every streaming update. Failed and interrupted turns with a final reply can also provide useful lessons. Long messages are bounded before extraction. Recognizable credentials are redacted; do not use memory to store secrets.

The idle setting delays processing until conversations have settled and the environment has no recent or active turns. Work is bounded per pass. Disabling learning for a conversation removes its queued work and skips its completed history while disabled. Re-enabling it allows newly discovered work to contribute; it does not replay history skipped while learning was off.

## Consolidation and dreaming

Daily consolidation merges duplicate or directly related memories and retains supported corrections and uncertainty. A deeper weekly dream revisits every eligible learned scope to synthesize durable patterns and remove obsolete claims. Both work on bounded batches and leave pinned memories alone. They do not perform repository tasks or publish information to other users.

Use **Run maintenance now** to queue both passes, including when automatic maintenance is paused. It still waits for interactive work to settle. Settings distinguish the first historical review from its current persisted queue, and show whether maintenance is running, the latest daily consolidation or weekly dream, and errors. Unchanged memory does not cause repeated model calls.

If the server stops, pending work survives. After restart, T3 serves the last complete memory version and continues processing when idle. A stopped server does no background work until it starts again. These rules also apply to automatically stopped remote workspaces.

## Review, edit, and forget

The Memory section lists entries, their scope, and source links. You can add or edit entries, pin or unpin them, and forget them. Pin memories you want to protect from automatic consolidation.

Forgetting a learned entry also removes other entries derived from the same source turns and suppresses those turns from future extraction. This prevents dreaming from recreating the forgotten information. Removing a source conversation or rewinding away a source turn removes that citation; memory with no remaining source is removed, while a multi-source memory remains supported by its other conversations. Turning off memory stops future recall and processing; it does not erase saved entries or context already sent to a provider.

The displayed memory directory contains a generated `MEMORY.md` index, `memory_summary.md`, and individual Markdown notes. Use Settings or the memory tools for edits so processing metadata and content stay consistent. Missing or modified note files cause an error instead of being silently replaced by automatic processing.
