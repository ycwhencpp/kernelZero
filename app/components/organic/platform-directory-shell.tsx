"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AppUser } from "../../../lib/types";
import {
  OrganicAppShell,
  type OrganicView,
} from "./app-shell";

const routes: Record<string, string> = {
  dashboard: "/dashboard",
  history: "/history",
  published: "/published",
  explore: "/explore",
  sources: "/sources",
  settings: "/settings",
  profile: "/profile",
  create: "/create",
};

export function PlatformDirectoryShell({
  user,
  pageTitle,
  children,
}: {
  user: AppUser;
  pageTitle: string;
  children: ReactNode;
}) {
  const router = useRouter();

  const navigate = (view: OrganicView) => {
    router.push(routes[view] || "/dashboard");
  };

  return (
    <OrganicAppShell
      view="explore"
      onNavigate={navigate}
      onNewBriefing={() => router.push("/create")}
      pageTitle={pageTitle}
      showFab={false}
      footerYear={new Date().getFullYear()}
      user={user}
      canCreate={user.role !== "viewer"}
    >
      {children}
    </OrganicAppShell>
  );
}
