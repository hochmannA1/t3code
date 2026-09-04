# Agent thread tools

The `t3-code` MCP server exposes `thread_list`, `thread_search`, and `thread_read` alongside the
preview and automation toolkits. These tools query persisted conversation history without loading
full orchestration snapshots or dispatching commands.

## Access and provider routing

`ProviderService` grants the `threads` capability when preparing a provider session. Browser and
automation settings continue to control their own capabilities. A settings read failure withholds
all capabilities. The MCP HTTP middleware authenticates the existing provider-scoped bearer
credential, and each thread handler requires `threads` and resolves the caller's current project
from its authenticated thread ID.

The default `scope: "project"` filters results to that project. Explicit `scope: "environment"`
allows history from other projects in the same server database. This is result scoping, not project
isolation: a thread credential permits environment-wide history reads. Deleted projects and threads
are excluded in both scopes. Archived threads require `includeArchived: true`.

Codex, Claude, Cursor, Grok, and managed OpenCode sessions receive the existing MCP endpoint and
credential. Externally managed OpenCode servers retain their own MCP configuration. No client
broker or new WebSocket method is needed, so the tools work when the agent is controlled through
web, desktop, mobile, or a remote connection. They cannot query another environment's database.

## Query behavior

`thread_list` returns thread and project metadata, supports literal title filtering, and sorts by
update time, creation time, or title in either direction. Sorting never changes sidebar state.
`thread_search` searches literal substrings in titles, completed user messages, and canonical final
assistant replies. It returns one snippet per matching thread, newest updated first.
`thread_read` returns completed conversation messages in chronological order. It excludes tool
output, intermediate assistant messages, reasoning, and attachment contents.

Queries apply project, archive, and deletion filters before pagination. Responses bound both row
counts and message text. `nextOffset` continues through results; a message's `nextTextOffset`
continues its text by passing that value as `textOffset` with its `messageId` to `thread_read`.
Pages reflect current state rather than a frozen snapshot, so updating threads can move between
pages when ordered by update time. Historical text is returned as data;
tool descriptions tell agents not to treat instructions found in old conversations as current
instructions. None of these handlers write to the database or trigger provider work.

The toolkit schemas live in `packages/contracts/src/threadTools.ts`. Tool descriptions and
handlers live in `apps/server/src/mcp/toolkits/threads/`; registration lives in `McpHttpServer.ts`.
