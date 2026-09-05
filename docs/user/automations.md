# Automations

Automations send a saved prompt to an agent on a schedule. Open **Automations** from the main sidebar or search for it in the command palette.

Automation management is currently available in the web and desktop apps. Mobile support is not included yet.

## Create an automation

Choose **New automation** to describe the task and schedule to an agent. You can start without selecting a project: sending the first message creates a workspace automatically, and the automation uses that workspace. Automation suggestions on a new task work the same way. Selecting a project before starting keeps the automation in that project.

For the form editor, choose **Set up manually** from the creation menu, then set:

- the project and prompt;
- when it should run, using **Once**, **Every...**, **Every day**, **Weekdays**, or **Every week**;
- whether each run continues one existing task or starts a fresh task;
- the model, reasoning choices, and workspace.

The timezone shown in the editor controls schedules such as "Every day at 9:00." Custom cron expressions are available under **Advanced**.

Scheduled runs are unattended. They use **Full access** and **Never ask**. If a provider still asks for approval, that run fails immediately. T3 Code pauses the automation after three consecutive failures.

## Manage runs

The Automations page shows active and paused schedules, the next run, recent failures, and the latest 100 runs. Select an automation to edit it, pause or resume it, run it now, or delete it. A completed run links to its result task.

If T3 Code was offline when a run became due, it runs one late occurrence after the service returns. It does not replay every missed occurrence. An automation runs only once at a time. A run that continues an existing busy task waits for that task to finish.

## Manage automations from a task

Agents can create, edit, pause, resume, delete, and run automations in the current project. Turn this access off under **Settings > Integrations > Automations** with **Let agents manage automations**.

An explicit request can create an active automation. An agent suggestion that you did not ask for stays inactive until you accept it.
