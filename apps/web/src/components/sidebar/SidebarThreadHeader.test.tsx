import { act, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { SidebarThreadHeaderProps } from "./SidebarThreadHeader";

vi.mock("../ui/sidebar", async () => {
  const React = await import("react");
  return {
    SidebarInput: ({
      nativeInput: _nativeInput,
      ...props
    }: ComponentProps<"input"> & {
      nativeInput?: boolean;
    }) => React.createElement("input", props),
    SidebarMenuButton: ({
      size: _size,
      ...props
    }: ComponentProps<"button"> & {
      size?: string;
    }) => React.createElement("button", props),
  };
});

vi.mock("../ui/tooltip", async () => {
  const React = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    TooltipTrigger: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
      React.cloneElement(render, undefined, children),
    TooltipPopup: () => null,
  };
});

import { SidebarThreadHeader } from "./SidebarThreadHeader";

let renderer: ReactTestRenderer | null = null;

function createProps(overrides: Partial<SidebarThreadHeaderProps> = {}): SidebarThreadHeaderProps {
  return {
    hasProjects: true,
    isWorkExperience: true,
    projectScope: null,
    onNewProject: vi.fn(),
    onNewThread: vi.fn(),
    newThreadDisabled: false,
    newThreadShortcutLabel: null,
    newThreadInProjectShortcutLabel: null,
    showNewThreadInProjectHint: false,
    searchInputRef: { current: null },
    searchQuery: "",
    onSearchQueryChange: vi.fn(),
    onSearchKeyDown: vi.fn(),
    isSearching: false,
    searchResultCount: 0,
    activeSearchResultIndex: 0,
    onClearSearch: vi.fn(),
    ...overrides,
  };
}

function renderHeader(props: SidebarThreadHeaderProps) {
  act(() => {
    renderer = create(<SidebarThreadHeader {...props} />);
  });
  return renderer!;
}

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

describe("SidebarThreadHeader", () => {
  it("disables project creation without disabling the new-task button", () => {
    const rendered = renderHeader(createProps({ newProjectDisabled: true }));

    expect(rendered.root.findByProps({ "aria-label": "Create project" }).props.disabled).toBe(true);
    expect(rendered.root.findByProps({ "aria-label": "New task" }).props.disabled).toBe(false);
  });

  it("disables the new-task button when requested", () => {
    const rendered = renderHeader(createProps({ newThreadDisabled: true }));

    expect(rendered.root.findByProps({ "aria-label": "New task" }).props.disabled).toBe(true);
    expect(rendered.root.findByProps({ "aria-label": "Create project" }).props.disabled).toBe(
      false,
    );
  });
});
