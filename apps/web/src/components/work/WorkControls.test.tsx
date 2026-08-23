import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { WORK_COMPLEXITY_OPTIONS } from "../../workExperience";

import { ExperienceSwitch } from "./ExperienceSwitch";
import { WorkComplexityControl } from "./WorkComplexityControl";

describe("Work controls", () => {
  it("renders the active experience as an accessible menu trigger", () => {
    const workMarkup = renderToStaticMarkup(
      <ExperienceSwitch value="work" onValueChange={vi.fn()} />,
    );
    const codeMarkup = renderToStaticMarkup(
      <ExperienceSwitch value="code" onValueChange={vi.fn()} />,
    );

    expect(workMarkup).toContain('aria-haspopup="menu"');
    expect(workMarkup).toContain('aria-label="Switch app experience"');
    expect(workMarkup).toContain(">Work<");
    expect(codeMarkup).toContain(">Code<");
  });

  it("renders each complexity as a compact popover trigger without model details", () => {
    const markups = WORK_COMPLEXITY_OPTIONS.map(({ value }) =>
      renderToStaticMarkup(<WorkComplexityControl value={value} onValueChange={vi.fn()} />),
    );

    for (const [index, { label }] of WORK_COMPLEXITY_OPTIONS.entries()) {
      expect(markups[index]).toContain('aria-haspopup="dialog"');
      expect(markups[index]).toContain(`aria-label="Task complexity: ${label}"`);
      expect(markups[index]).toContain(`>${label}<`);
    }
    expect(markups.join(" ")).not.toContain("gpt-5.6");
    expect(markups.join(" ")).not.toContain("Luna");
    expect(markups.join(" ")).not.toContain("Sol");
  });
});
