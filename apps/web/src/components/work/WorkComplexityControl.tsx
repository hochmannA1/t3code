"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { isWorkComplexity, WORK_COMPLEXITY_OPTIONS, type WorkComplexity } from "~/workExperience";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RadioGroup } from "../ui/radio-group";

export interface WorkComplexityControlProps {
  value: WorkComplexity;
  onValueChange: (value: WorkComplexity) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

const TRACK_PROGRESS_CLASS: Readonly<Record<WorkComplexity, string>> = {
  simple: "w-0",
  normal: "w-1/2",
  hard: "w-full",
};

export function WorkComplexityControl({
  value,
  onValueChange,
  className,
  disabled,
  "aria-label": ariaLabel = "Task complexity",
}: WorkComplexityControlProps) {
  const selectedLabel =
    WORK_COMPLEXITY_OPTIONS.find((option) => option.value === value)?.label ?? "Normal work";

  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`${ariaLabel}: ${selectedLabel}`}
        className={cn(
          "group -ms-2 inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-secondary-label outline-none transition-colors hover:bg-input/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64",
          className,
        )}
      >
        <span>{selectedLabel}</span>
        <ChevronDownIcon className="size-4 transition-transform group-data-popup-open:rotate-180" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 rounded-2xl"
        viewportClassName="p-4"
      >
        <RadioGroup
          value={value}
          onValueChange={(nextValue) => {
            if (isWorkComplexity(nextValue)) {
              onValueChange(nextValue);
            }
          }}
          disabled={disabled}
          aria-label={ariaLabel}
          className="relative grid grid-cols-3 gap-0 pt-1"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute top-[0.875rem] right-[16.667%] left-[16.667%] h-1 -translate-y-1/2 overflow-hidden rounded-full bg-border/80"
          >
            <span
              className={cn(
                "block h-full rounded-full bg-foreground/75 transition-[width] duration-200",
                TRACK_PROGRESS_CLASS[value],
              )}
            />
          </span>
          {WORK_COMPLEXITY_OPTIONS.map((option) => (
            <RadioPrimitive.Root
              key={option.value}
              value={option.value}
              className="group/option relative z-10 flex min-w-0 cursor-pointer flex-col items-center gap-3 rounded-lg px-1 py-1 text-center text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-64"
            >
              <span
                aria-hidden
                className="size-3 rounded-full border border-border bg-muted-foreground shadow-sm transition-[background-color,border-color,scale] in-[[data-checked]]:scale-[1.75] in-[[data-checked]]:border-background in-[[data-checked]]:bg-foreground"
              />
              <span className="leading-tight">{option.label}</span>
            </RadioPrimitive.Root>
          ))}
        </RadioGroup>
      </PopoverPopup>
    </Popover>
  );
}
