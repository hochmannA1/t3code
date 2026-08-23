# Work experience

Work is the default T3 Code experience for people who want to complete business tasks without choosing developer-oriented settings. Use the experience menu in the top-left corner to switch between Work and Code. Work always uses Codex. When an existing thread is tied to another provider, start a new task before sending in Work mode.

## Starting work

The bell in the sidebar switches between two views and remembers your choice:

- **Activity** shows tasks by status. The project selector below Search shows named projects and their task counts. Choose **All projects** to see activity across the whole environment, or choose one project to filter the list.
- **Projects** groups tasks below each named project. Tasks started without a named project appear under **Recents**. Both sections can be collapsed. Drag either section heading to place Projects or Recents first; T3 Code remembers the layout.

Drag anywhere on a named project row to set its order. Pin a whole project or a projectless task to move it into the fixed **Pinned** section above Projects and Recents. Hover a row to use its pin action, or use the same action in the right-click menu. Unpinning returns the item to its original section.

Each Recents heading has its own **New task** button. Completed tasks leave the active list and move into a quieter, collapsed **Completed** group inside their project. Expand that group to inspect a finished task, or use its archive action to archive every completed task in that project at once. Open a completed task and choose **Reopen** to make it active again.

Projects keep related tasks and files together.

To start a task in a specific project:

1. Choose the project in the sidebar.
2. Choose **New task**.

The new task uses the selected project. If **All projects** is selected, it uses the project of the task you are viewing. You can also choose **New task** while viewing a task to continue working in that project.

Choose **Create project** to make a project under `~/t3work/projects/<title>` or open an existing folder. You can still start a task without choosing a project. T3 Code creates a separate workspace for it under:

```text
~/t3work/projects/YYYY-MM-DD/<request-summary>
```

Every projectless task gets its own directory.

## Task complexity

Work replaces provider and model details with a three-step slider:

- **Simple tasks** for quick, focused requests
- **Normal work** for most analysis and deliverables
- **Hard work** for demanding or ambiguous work

Drag the slider or choose a label to change the model and reasoning effort without exposing those details in the composer.

## Answers and activity

Work asks Codex to write in plain language for business roles such as analysts, requirements specialists, and managers. Straightforward answers are concise by default, but an explicit request for detail, multiple steps, tool calls, or visible reasoning summaries takes precedence.

Intermediate reasoning summaries and technical activity are grouped behind **Worked for ...** after a task finishes and can be expanded when needed. Work also hides developer-only Terminal, Diff, and pull-request panels; files, browser previews, and agents remain available.

Completed tasks move to the **Completed** section. Choose **Reopen** to return one to the active list. Code mode keeps the original Settle terminology.
