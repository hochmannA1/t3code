"use client";

import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { WORK_COMPLEXITY_OPTIONS, type WorkComplexity } from "~/workExperience";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export interface WorkComplexityControlProps {
  value: WorkComplexity;
  onValueChange: (value: WorkComplexity) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

const SLIDER_POSITIONS = ["0.5rem", "50%", "calc(100% - 0.5rem)"] as const;

export function WorkComplexityControl({
  value,
  onValueChange,
  className,
  disabled,
  "aria-label": ariaLabel = "Task complexity",
}: WorkComplexityControlProps) {
  const selectedLabel =
    WORK_COMPLEXITY_OPTIONS.find((option) => option.value === value)?.label ?? "Normal work";
  const selectedIndex = Math.max(
    0,
    WORK_COMPLEXITY_OPTIONS.findIndex((option) => option.value === value),
  );
  const [previewIndex, setPreviewIndex] = useState(selectedIndex);
  const [dragging, setDragging] = useState(false);
  const previewOption = WORK_COMPLEXITY_OPTIONS[previewIndex] ?? WORK_COMPLEXITY_OPTIONS[1];
  const progress = (previewIndex / (WORK_COMPLEXITY_OPTIONS.length - 1)) * 100;

  useEffect(() => {
    if (!dragging) setPreviewIndex(selectedIndex);
  }, [dragging, selectedIndex]);

  const selectIndex = (nextIndex: number) => {
    const nextOption = WORK_COMPLEXITY_OPTIONS[nextIndex];
    if (!nextOption) return;
    setPreviewIndex(nextIndex);
    onValueChange(nextOption.value);
  };

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
        <div className="px-1 pt-1">
          <div className="relative h-9">
            <div
              aria-hidden
              className="absolute top-1/2 right-2 left-2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-border/80"
            >
              <span
                className={cn(
                  "block h-full rounded-full bg-foreground/80",
                  !dragging && "transition-[width] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
            {WORK_COMPLEXITY_OPTIONS.map((option, index) => (
              <span
                key={option.value}
                aria-hidden
                className={cn(
                  "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-popover transition-[background-color,scale] duration-200",
                  index <= previewIndex && "border-foreground/80 bg-foreground/80",
                )}
                style={{ left: SLIDER_POSITIONS[index] }}
              />
            ))}
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_1px_5px_rgb(0_0_0/0.3)]",
                dragging
                  ? "scale-110"
                  : "transition-[left,scale] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
              )}
              style={{ left: SLIDER_POSITIONS[previewIndex] }}
            />
            <input
              type="range"
              min={0}
              max={WORK_COMPLEXITY_OPTIONS.length - 1}
              step={1}
              value={previewIndex}
              disabled={disabled}
              aria-label={ariaLabel}
              aria-valuetext={previewOption?.label}
              className="absolute inset-0 z-10 h-full w-full cursor-grab opacity-0 active:cursor-grabbing disabled:cursor-not-allowed"
              onChange={(event) => selectIndex(Number(event.currentTarget.value))}
              onBlur={() => setDragging(false)}
              onPointerDown={() => setDragging(true)}
              onPointerUp={() => setDragging(false)}
              onPointerCancel={() => setDragging(false)}
              onLostPointerCapture={() => setDragging(false)}
            />
          </div>
          <div className="grid grid-cols-3 gap-1">
            {WORK_COMPLEXITY_OPTIONS.map((option, index) => (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                aria-pressed={index === previewIndex}
                className={cn(
                  "min-w-0 cursor-pointer rounded-md px-1 py-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64",
                  index === previewIndex && "text-foreground",
                )}
                onClick={() => selectIndex(index)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
