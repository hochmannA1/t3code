"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { type AppExperience } from "~/workExperience";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

const EXPERIENCE_COPY: Readonly<
  Record<AppExperience, { readonly label: string; readonly description: string }>
> = {
  work: { label: "Work", description: "Create, organize, and get things done" },
  code: { label: "Code", description: "Build, debug, and ship" },
};

export interface ExperienceSwitchProps {
  value: AppExperience;
  onValueChange: (value: AppExperience) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

export function ExperienceSwitch({
  value,
  onValueChange,
  className,
  disabled,
  "aria-label": ariaLabel = "Switch app experience",
}: ExperienceSwitchProps) {
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "group flex h-8 min-w-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-sidebar-control-surface focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64",
          className,
        )}
      >
        <span>{EXPERIENCE_COPY[value].label}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-popup-open:rotate-180" />
      </MenuTrigger>
      <MenuPopup align="start" sideOffset={6} className="w-72 rounded-xl">
        <MenuRadioGroup
          value={value}
          onValueChange={(nextValue) => onValueChange(nextValue as AppExperience)}
        >
          {(["work", "code"] as const).map((experience) => {
            const copy = EXPERIENCE_COPY[experience];
            const selected = experience === value;
            return (
              <MenuRadioItem
                key={experience}
                value={experience}
                closeOnClick
                className="min-h-16 items-start rounded-lg px-3 py-2.5 data-checked:not-data-highlighted:bg-transparent data-checked:not-data-highlighted:text-foreground"
              >
                <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_1rem] items-start gap-2">
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">{copy.label}</span>
                    <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">
                      {copy.description}
                    </span>
                  </span>
                  <CheckIcon
                    aria-hidden
                    className={cn("mt-1 size-4 text-foreground", !selected && "invisible")}
                  />
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
