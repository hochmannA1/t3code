import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { isStandaloneProject } from "@t3tools/shared/projectContext";

const CHAT_WORKSPACE_CONTEXT =
  "<t3-chat-workspace>\nThis is a chat started without a user-selected project. The current directory is an automatically allocated folder for this chat and its files. Its generated name is not a factual project name or evidence of the user’s work, interests, or goals. Use the conversation to establish the task; do not infer a project or recommend project work from the storage folder. You may use this folder for requested deliverables and automations.\n</t3-chat-workspace>";

/** Clarifies automatic storage without changing the persisted message or exceeding turn bounds. */
export function withChatWorkspaceContext(
  input: string,
  project: { readonly title: string; readonly workspaceRoot: string } | undefined,
): string {
  if (!project || !isStandaloneProject(project)) return input;
  const combined = `${input}\n\n${CHAT_WORKSPACE_CONTEXT}`;
  return combined.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS ? combined : input;
}
