import type { ScopedProjectRef } from "@t3tools/contracts";
import { CheckIcon, FolderIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export interface ProjectPickerOption {
  readonly ref: ScopedProjectRef;
  readonly value: string;
  readonly label: string;
}

export function filterProjectPickerOptions(
  options: readonly ProjectPickerOption[],
  query: string,
): readonly ProjectPickerOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery));
}

export function ProjectPickerMenu({
  activeValue,
  options,
  trigger,
  onSelect,
}: {
  readonly activeValue: string | null;
  readonly options: readonly ProjectPickerOption[];
  readonly trigger: ReactElement;
  readonly onSelect: (projectRef: ScopedProjectRef | null) => void;
}) {
  const [query, setQuery] = useState("");
  const filteredOptions = useMemo(
    () => filterProjectPickerOptions(options, query),
    [options, query],
  );

  return (
    <Menu onOpenChange={(open) => !open && setQuery("")}>
      <MenuTrigger render={trigger} />
      <MenuPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="relative mb-1 px-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            nativeInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Search projects"
            aria-label="Search projects"
            size="sm"
            className="border-0 bg-transparent ps-7 shadow-none has-focus-visible:ring-0"
          />
        </div>
        <div className="max-h-56 overflow-y-auto">
          <MenuRadioGroup
            value={activeValue ?? "__no_project__"}
            onValueChange={(value) => {
              const selected = options.find((option) => option.value === value);
              if (selected) onSelect(selected.ref);
            }}
          >
            {filteredOptions.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.value === activeValue ? (
                    <CheckIcon className="size-4 shrink-0 text-foreground" />
                  ) : null}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-4 text-center text-muted-foreground text-sm">
              No projects found
            </div>
          ) : null}
        </div>
        <MenuSeparator />
        <MenuItem onClick={() => openCommandPalette({ open: "add-project" })}>
          <PlusIcon />
          New project
        </MenuItem>
        <MenuItem onClick={() => onSelect(null)}>
          <XIcon />
          Don't work in a project
          {activeValue === null ? <CheckIcon className="ms-auto" /> : null}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
