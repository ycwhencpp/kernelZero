import { redirect } from "next/navigation";
import { currentUser } from "../lib/auth";
import { getDashboardState } from "../lib/store";
import type { OrganicView } from "./components/organic/app-shell";
import { DashboardClient } from "./dashboard-client";

export async function WorkspacePage({
  initialView,
  initialEpisodeId = null,
  initialReviewReturnView = "dashboard",
}: {
  initialView: OrganicView;
  initialEpisodeId?: string | null;
  initialReviewReturnView?: OrganicView;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");

  if (initialView === "settings" && user.role !== "owner") {
    redirect("/dashboard");
  }
  if (initialView === "create" && user.role === "viewer") {
    redirect("/dashboard");
  }

  const state = await getDashboardState(user.workspaceOwnerId);
  if (
    initialView === "review" &&
    !state.episodes.some((episode) => episode.id === initialEpisodeId)
  ) {
    redirect("/history");
  }

  return (
    <DashboardClient
      key={`${initialView}:${initialEpisodeId ?? ""}:${initialReviewReturnView}`}
      initialState={state}
      user={user}
      initialView={initialView}
      initialEpisodeId={initialEpisodeId}
      initialReviewReturnView={initialReviewReturnView}
    />
  );
}
