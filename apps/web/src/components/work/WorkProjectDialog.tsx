"use client";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { newProjectId } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { createWorkModelSelection, workProjectDirectoryName } from "~/workExperience";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function WorkProjectDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChooseFolder: () => void;
}) {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const directoryName = workProjectDirectoryName(title);

  const close = () => {
    if (creating) return;
    setTitle("");
    props.onOpenChange(false);
  };

  const create = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !directoryName || primaryEnvironmentId === null || creating) return;
    setCreating(true);
    const projectId = newProjectId();
    const result = await createProject({
      environmentId: primaryEnvironmentId,
      input: {
        projectId,
        title: trimmedTitle,
        workspaceRoot: `~/t3work/projects/${directoryName}`,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: createWorkModelSelection("normal"),
      },
    });
    if (result._tag === "Failure") {
      setCreating(false);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn’t create the project",
            description:
              error instanceof Error ? error.message : "The project could not be created.",
          }),
        );
      }
      return;
    }

    const draft = await handleNewThread(scopeProjectRef(primaryEnvironmentId, projectId));
    setCreating(false);
    if (draft === null) {
      toastManager.add({
        type: "error",
        title: "The project was created, but its first task could not be opened.",
      });
      return;
    }
    setTitle("");
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create a project</DialogTitle>
          <DialogDescription>
            Give the project a name, or open a folder that already contains your work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="work-project-title">
            Project title
            <Input
              id="work-project-title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void create();
                }
              }}
              placeholder="Quarterly planning"
              disabled={creating}
            />
          </label>
          <p className="truncate text-xs text-muted-foreground">
            {directoryName
              ? `~/t3work/projects/${directoryName}`
              : "Projects are created in ~/t3work/projects"}
          </p>
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={creating}
            onClick={() => {
              setTitle("");
              props.onOpenChange(false);
              window.setTimeout(props.onChooseFolder, 0);
            }}
          >
            Open a folder
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" disabled={creating} onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                !title.trim() || !directoryName || primaryEnvironmentId === null || creating
              }
              onClick={() => void create()}
            >
              {creating ? "Creating…" : "Create project"}
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
