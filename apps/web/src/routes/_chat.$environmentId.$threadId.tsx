import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import * as Option from "effect/Option";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteRef, resolveThreadRouteRenderState } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  useEnvironmentThreadRefs,
  useThreadDetail,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const detailState = useEnvironmentThread(
    threadRef?.environmentId ?? null,
    threadRef?.threadId ?? null,
  );
  const detailError = Option.getOrNull(detailState.error);
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const renderState = resolveThreadRouteRenderState({
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    serverThreadDetailError: detailError !== null,
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!threadRef) {
      return;
    }

    if (renderState === "missing" && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [environmentHasAnyThreads, navigate, renderState, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
        />
      ) : (
        <Empty className="flex-1" role={renderState === "error" ? "alert" : "status"}>
          <EmptyHeader>
            <EmptyTitle>
              {renderState === "error"
                ? "Couldn’t load this task"
                : renderState === "missing"
                  ? "This task was deleted"
                  : "Loading task..."}
            </EmptyTitle>
            {renderState === "error" ? <EmptyDescription>{detailError}</EmptyDescription> : null}
          </EmptyHeader>
        </Empty>
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
