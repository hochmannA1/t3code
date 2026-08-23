# Work experience

Work is the default T3 Code experience for people who want to complete business tasks without choosing developer-oriented settings. Use the experience menu in the top-left corner to switch between Work and Code. The selection applies to the next message, including in an existing thread.

## Starting work

You can start a thread without choosing a project. T3 Code creates a separate workspace for it under:

```text
~/t3work/projects/YYYY-MM-DD/<request-summary>
```

Every new projectless thread gets its own directory. To keep several threads in one workspace, choose **Create project** instead. Entering a title creates `~/t3work/projects/<title>`, or you can open an existing folder.

## Task complexity

Work replaces provider and model details with three choices:

- **Simple tasks** for quick, focused requests
- **Normal work** for most analysis and deliverables
- **Hard work** for demanding or ambiguous work

The selected complexity changes the model and reasoning effort without exposing those details in the composer.

## Answers and activity

Work asks Codex to write in plain language for business roles such as analysts, requirements specialists, and managers. Straightforward answers are concise by default, but an explicit request for detail, multiple steps, tool calls, or visible reasoning summaries takes precedence.

Reasoning summaries remain visible in the conversation. Technical tool activity is grouped behind **Worked for ...** and can be expanded when needed. Work also hides developer-only Terminal, Diff, and pull-request panels; files, browser previews, and agents remain available.
