# Research: an approachable Work mode for agentic tasks

> Status: research only — this is a product/UX proposal, not an implementation plan.
> Sources: first-party product documentation, official OpenAI material, and W3C/USWDS guidance.
> Researched: 2026-08-23

## The product boundary to preserve

ChatGPT currently positions **Chat** as quick, conversational help, **Work** as longer multi-step work that produces finished deliverables, and **Codex** as the dedicated software-development experience. Work is selected as an experience on web/mobile, can operate in a project, and its cloud chats continue across web, mobile, and desktop. That is a useful precedent: _Work_ should be a distinct, durable experience—not merely a less technical label on the existing developer composer. [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275/)

The corresponding opportunity for T3 Code is an outcome-first layer on top of the same agent runtime. A person should be able to say “compare these options and give me a decision memo,” attach material, follow progress, approve consequential actions, and receive a usable file or link without having to understand providers, context windows, shell commands, or model identifiers. This is a design inference from the Work boundary above and from Work’s file-oriented workflow. [Creating and editing documents, spreadsheets, and presentations with ChatGPT Work](https://help.openai.com/en/articles/20001278)

## Recommended interaction model

### 1. Make Work and Developer peer experiences, with a durable way back

Use a named, top-level **Work / Developer** segmented choice in the navigation or new-task entry point—not a buried setting and not a mode that silently changes when a task begins. Keep the current selection visible in the composer and provide the same switch from an existing task’s overflow menu. This follows the precedent that Work is explicitly selected as an experience, while projects and synced chats make continuing multi-step work important. [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275/)

Persist the last chosen experience per user/device, but store the mode on each task as well. The former lowers repeat friction; the latter prevents a task from changing personality when opened on another surface. This is a proposed product rule, motivated by the documented cross-surface continuity of Work chats rather than a claim about an existing T3 implementation. [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275/)

Do not make Work a dead end. Developer exposes the technical controls, rawer activity, provider diagnostics, and source/project concepts; Work exposes an **Open in Developer** escape hatch. Switching should retain the task, artifacts, approvals, and history, then explain what extra controls became visible. The experience switch should not silently raise permission scope.

For a narrow two-way choice, use a native radio group or a correctly implemented segmented control—not a slider. W3C defines a radio group as mutually exclusive choices and specifies its keyboard behavior; USWDS says segmented groups suit categorically related controls, should use short labels, and must make the current state unambiguous. [W3C Radio Group Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) · [USWDS segmented button group](https://designsystem.digital.gov/button-group/button-group--segmented/)

### 2. Turn model/effort into an outcome promise, not a technical choice

OpenAI describes GPT-5.6 as three capability tiers (Sol, Terra, Luna) and says ChatGPT Work/Codex users can choose tiers and effort; `max` gives more time for deep reasoning, while `ultra` coordinates multiple agents for demanding work. Those are real runtime controls, but their names are not the user’s job to understand. [GPT-5.6 announcement](https://openai.com/index/gpt-5-6/) · [GPT-5.6 Sol preview](https://openai.com/index/previewing-gpt-5-6-sol/)

In Work, offer three discrete **task complexity** choices, each written as a promise:

| Work control               | User-facing promise                                          | Product policy behind it                                                                |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Quick answer**           | “A focused first result with light checking.”                | Choose the fastest suitable provider/effort and restrict the plan to a short pass.      |
| **Careful work** (default) | “Research, create, and check the result.”                    | Use the normal capability/effort policy; show sources and assumptions where relevant.   |
| **Deep project**           | “Take more time for a multi-step result and a final review.” | Permit the higher-effort/multi-step policy; show a plan before consequential execution. |

This mapping is deliberately a proposed policy, not a fixed mapping from labels to GPT-5.6 model IDs. It should be provider-neutral and may change as availability, cost, or quality changes. The configuration panel in Developer may reveal the selected provider and effort for advanced users; Work should show the chosen promise, estimated waiting/cost impact if meaningful, and an upgrade/downgrade action instead of an opaque model code. The reason to use discrete choices rather than a continuous “intelligence” slider is that GPT-5.6 exposes categorical tiers/effort settings, while the user’s decision is categorical too. [GPT-5.6 announcement](https://openai.com/index/gpt-5-6/)

If a slider is nevertheless tested, make it an accessible discrete slider: announce a meaningful `aria-valuetext` such as “Careful work,” support arrows, Home/End, and test with touch assistive technology. W3C explicitly warns that touch assistive technologies can have difficulty operating sliders. [W3C Slider Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/)

### 3. Show progress in layers; never expose raw chain-of-thought as the default

The default activity surface should be a compact, human-readable timeline: **Understanding your request → Gathering sources → Preparing the spreadsheet → Ready for review**. It should expose only milestones, current blocker/approval, elapsed time, and the next thing the person can do. A short, stable checklist gives confidence without requiring users to interpret tool names or command output. OpenAI notes that complex Codex work tracks progress with a to-do list and that tool calls/diffs are formatted to be easier to follow. [Introducing upgrades to Codex](https://openai.com/index/introducing-upgrades-to-codex/)

Put a single **View activity** disclosure behind that timeline. It can reveal the user-safe action record: what was read or changed, which source/system was used, inputs and outputs at an appropriate redaction level, generated files, and error/retry summaries. Put provider logs, terminal output, full diffs, and diagnostics one layer deeper in Developer. This is a design recommendation supported by the fact that Claude Code exposes turn-by-turn output as a `--verbose` debugging option rather than the only interaction level. [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)

Do not label a polished activity summary “reasoning,” and do not make hidden chain-of-thought a Work feature. OpenAI says unrestricted chain-of-thought can be unfit to show end users and suggests a separate summarizer or sanitizer when a policy-compliant user-facing explanation is required. Offer a brief **Why I did this** explanation and a source/action trail instead. [OpenAI on chain-of-thought monitoring](https://openai.com/index/chain-of-thought-monitoring/)

### 4. Structure task intake and delivery around artifacts

The Work composer should ask for the outcome in approachable terms: **What do you want to end up with?**, **What should I use?**, and optionally **What must stay unchanged?** Let users attach files and select a destination/format only when that matters. This mirrors OpenAI’s documented Work sequence: describe the desired file and use, attach source material, name format/destination, and identify constraints. [Creating and editing documents, spreadsheets, and presentations with ChatGPT Work](https://help.openai.com/en/articles/20001278)

Finish every task with a delivery card, not merely a chat paragraph:

- a clear artifact title and direct **Open** / **Download** / **Share** action;
- a three-to-five item “What changed / what I found” summary;
- source links, assumptions, and any unresolved decision;
- a **Refine this** action that reopens the same brief; and
- for edits, a before/after summary and a path back to review.

This is a proposed delivery pattern. It is grounded in Work’s support for creating/editing documents, spreadsheets, presentations, reports, and analyses, and in its guidance to review a generated file before sharing or relying on it. ChatGPT Library also establishes that created/uploaded files benefit from a dedicated place where they can later be found and reused. [Creating and editing documents, spreadsheets, and presentations with ChatGPT Work](https://help.openai.com/en/articles/20001278) · [File storage and Library in ChatGPT](https://help.openai.com/en/articles/20001052-library-for-chatgpt)

Make artifacts and task briefs durable first-class objects: recent Work tasks should show their latest output, and a “My work” view should filter by document, spreadsheet, presentation, report, and link. Retention/location must be explicit—OpenAI distinguishes cloud files that may appear in Library from local desktop outputs that remain in local projects/folders. [Creating and editing documents, spreadsheets, and presentations with ChatGPT Work](https://help.openai.com/en/articles/20001278)

### 5. Default to reviewable authority, then grant trust at a useful scope

Set Work’s default to **Ask before changes or external actions**. Allow safe, read-only inspection and local drafting in a task workspace; ask before overwriting an existing file, sending/publishing, changing a connected system, accessing a new external source, or widening file/network scope. This is a recommendation, with the same high-level-versus-fine-grained separation documented by VS Code: a session permission level sits above per-tool, URL, terminal, and sandbox controls. [VS Code: manage approvals and permissions](https://code.visualstudio.com/docs/agents/run/approvals)

An approval card should say, in plain language: **what will happen**, **where**, **why it is needed**, and **what changes if allowed**. Provide `Allow once`, `Allow for this task`, and `Cancel`; reserve broad or permanent trust for an explicit settings flow with a clear warning and a visible way to revoke it. VS Code’s confirmation UX supports single-use, session, workspace, and future scopes, and its documentation warns before bypassing approvals; that is a strong precedent for keeping the default bounded. [VS Code: manage approvals and permissions](https://code.visualstudio.com/docs/agents/run/approvals)

For big edits, offer **Show the plan first** as the friendly default rather than forcing users to formulate a technical “plan mode” request. OpenAI’s spreadsheet guidance likewise recommends requesting an exact outline of the tabs/ranges before large edits and reviewing formulas, citations, and changed cells before relying on the result. [ChatGPT for Excel and Google Sheets](https://help.openai.com/en/articles/20001063)

After a user enables automatic action, show a non-intrusive but persistent status such as “Auto-approval: files in this task only,” with a one-click **Manage** action. Visibility matters: VS Code explicitly notifies users when a tool/terminal command was automatically approved and links to the setting that enabled it. [VS Code AI security](https://code.visualstudio.com/docs/agents/run/security)

### 6. Accessibility and small-control decisions are product decisions

Use semantic native controls where possible. A Work/Developer choice needs a visible group label, visible selected state that is not color-only, a programmatic name/description, keyboard operation, and focus that remains visible. W3C’s radio guidance specifies Tab, Space, and arrow-key behavior plus `radiogroup`, `radio`, and `aria-checked` semantics; its keyboard guidance explains why composite controls need predictable focus management. [W3C Radio Group Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) · [W3C keyboard interface practice](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)

Keep segmented groups to short labels and a small number of choices. USWDS advises considering another control for more than three buttons and cautions against ambiguous current state. For more than three complexity levels, use a labelled radio list or select; for Work/Developer, two clearly labelled options are appropriate. [USWDS segmented button group](https://designsystem.digital.gov/button-group/button-group--segmented/)

## A minimum coherent Work experience

1. The user starts a task in **Work**, states a desired deliverable, attaches context, and picks **Quick answer**, **Careful work**, or **Deep project**.
2. The agent displays a concise plan and milestone timeline; detailed action evidence remains available through **View activity**.
3. Read-only work proceeds; an understandable approval interrupts only when authority must widen or something consequential will change.
4. The task ends on a delivery card with the artifact, a short outcome summary, sources/assumptions, and a refine/review action.
5. The same Work task and artifacts remain findable on the next surface; **Open in Developer** is always available for technical inspection without altering the task’s permission state.

This sequence combines the documented Work distinction and artifact workflow with the established agent patterns of plan/progress, scoped approvals, and accessible single-choice controls. It is intentionally small: build the mode boundary, outcome/complexity chooser, activity disclosure, approval cards, and delivery card before adding a broad template gallery, persistent automations, or provider-specific controls. [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275/) · [Introducing upgrades to Codex](https://openai.com/index/introducing-upgrades-to-codex/) · [VS Code: manage approvals and permissions](https://code.visualstudio.com/docs/agents/run/approvals)

## Questions to validate before committing to the design

- Does “Careful work” describe the promised outcome better than “Standard,” and do people understand when they should choose “Deep project” without reading helper text?
- Is a persisted last-used experience helpful, or does it produce costly mode mistakes when a person alternates personal Work and Developer tasks? Test the mode label in the task header and the switch’s discoverability.
- Which actions do Work users consider consequential: overwriting a local file, using web search, connecting an account, sending an email, or publishing a Site? Set initial approval boundaries from that evidence, not from engineering convenience.
- Can users accurately predict what will happen from the milestone timeline and approval cards? Test this with screen readers, keyboard-only use, zoom, reduced motion, and touch assistive technology—especially if a slider is retained. [W3C Slider Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/)
- Does the delivery card make the output easier to find, judge, and refine than a chat-only completion? Measure open/download/refine/review behavior and failure recovery, not just task completion.
