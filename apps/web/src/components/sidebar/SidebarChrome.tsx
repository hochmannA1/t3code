import {
  ArrowLeftIcon,
  BellIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  GitPullRequestIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { useWorkSidebarView } from "../../hooks/useWorkSidebarView";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { ExperienceSwitch } from "../work/ExperienceSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden rounded-full px-1.5 text-muted-foreground @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
      <SidebarViewToggle onBackdrop={backdropVariant !== null} />
    </SidebarHeader>
  );
});

const SidebarViewToggle = memo(function SidebarViewToggle({ onBackdrop }: { onBackdrop: boolean }) {
  const [view, setView] = useWorkSidebarView();
  const activityVisible = view === "activity";
  const label = activityVisible ? "View projects" : "View activity";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={activityVisible}
            onClick={() => setView(activityVisible ? "projects" : "activity")}
            className={cn(
              "relative z-10 ml-auto mr-2 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
              activityVisible && "bg-sidebar-row-active text-sidebar-foreground",
              onBackdrop &&
                "text-white/75 hover:bg-white/15 hover:text-white focus-visible:ring-white/90",
              onBackdrop && activityVisible && "bg-white/15 text-white",
            )}
          />
        }
      >
        <BellIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  const appExperience = useUiStateStore((store) => store.appExperience);
  const setAppExperience = useUiStateStore((store) => store.setAppExperience);
  const handleExperienceChange = useCallback(
    (nextExperience: typeof appExperience) => {
      if (nextExperience === appExperience) return;
      setAppExperience(nextExperience);
      if (nextExperience === "work") {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Work mode uses Codex",
            description:
              "New tasks will run with Codex. If this task already uses another provider, start a new task to continue in Work mode.",
          }),
        );
      }
    },
    [appExperience, setAppExperience],
  );

  return (
    <div
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1 md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
    >
      <T3Wordmark aria-label="T3" className="h-2.5 w-auto shrink-0" />
      <ExperienceSwitch
        value={appExperience}
        onValueChange={handleExperienceChange}
        className={cn(onBackdrop && "text-white hover:bg-white/15 [&_svg]:text-white/70")}
      />
    </div>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
  fullWidth = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  fullWidth?: boolean;
}) {
  return (
    <SidebarMenuItem className={cn("shrink-0", fullWidth && "min-w-0 flex-1")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              onClick={onClick}
              size={fullWidth ? "default" : "icon"}
              className={cn(fullWidth && "w-full")}
            >
              {icon}
              {fullWidth ? <span>{label}</span> : null}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const appExperience = useUiStateStore((store) => store.appExperience);
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/automations"
            ? "automations"
            : location.pathname === "/usage"
              ? "usage"
              : location.pathname === "/pull-requests"
                ? "pull-requests"
                : null,
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const automationsSupported = environments.some(
    (environment) => environment.serverConfig?.automationCapabilities !== undefined,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/pull-requests", search: { involvement: "all", state: "open" } });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleAutomationsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/automations", search: {} });
  }, [closeMobileSidebar, navigate]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  return (
    <SidebarMenu className="flex-row flex-wrap items-center">
      {currentFooterPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {appExperience === "code" && pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<GitPullRequestIcon />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          {appExperience === "code" ? (
            <SidebarUtilityItem
              icon={<ChartNoAxesColumnIcon />}
              label="Usage"
              onClick={handleUsageClick}
            />
          ) : null}
          {automationsSupported ? (
            <SidebarUtilityItem
              icon={<CalendarClockIcon />}
              label="Automations"
              onClick={handleAutomationsClick}
              fullWidth
            />
          ) : null}
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const appExperience = useUiStateStore((store) => store.appExperience);
  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      {appExperience === "code" ? <SidebarProviderUpdatePill /> : null}
      {appExperience === "code" ? <SidebarUpdateArchitectureWarning /> : null}
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
