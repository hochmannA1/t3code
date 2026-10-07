import type { EnvironmentId, T3ProjectFileScript, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { PopoverCreateHandle } from "../ui/popover";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  threadAutomationsPanel: vi.fn(),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: (props: unknown) => {
    testState.threadAutomationsPanel(props);
    return null;
  },
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => React.ReactNode }) =>
    children("full"),
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

let renderer: ReactTestRenderer | null = null;

function createPanelProps(
  overrides: Partial<ThreadDetailsPanelProps> = {},
): ThreadDetailsPanelProps {
  return {
    anchor: { current: null },
    handle: PopoverCreateHandle(),
    onPresentationChange: vi.fn(),
    environmentId: "environment:thread-details" as EnvironmentId,
    threadId: "thread:thread-details" as ThreadId,
    activeProjectName: undefined,
    activeProjectScripts: [],
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    showOpenInPicker: false,
    gitCwd: null,
    isGitRepo: false,
    envLocked: false,
    availableEnvironments: [],
    onEnvironmentChange: vi.fn(),
    onEnvModeChange: vi.fn(),
    envMode: "local",
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    onComposerFocusRequest: vi.fn(),
    versionMismatch: null,
    onDismissVersionMismatch: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
    onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
    onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    ...overrides,
  };
}

function renderPanel(props: ThreadDetailsPanelProps) {
  act(() => {
    renderer = create(<ThreadDetailsPanel {...props} />);
  });
  return renderer!;
}

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
    testState.threadAutomationsPanel.mockReset();
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props = createPanelProps({ environmentId, gitCwd });

    renderPanel(props);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  it("omits automations when showAutomations is false", () => {
    renderPanel(createPanelProps({ showAutomations: false }));

    expect(testState.threadAutomationsPanel).not.toHaveBeenCalled();
  });

  it("shows automations when showAutomations is omitted", () => {
    renderPanel(createPanelProps());

    expect(testState.threadAutomationsPanel).toHaveBeenCalledWith({
      environmentId: "environment:thread-details",
      threadId: "thread:thread-details",
    });
  });
});
