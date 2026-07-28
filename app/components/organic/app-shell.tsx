"use client";

import type { ReactNode } from "react";

export type OrganicView =
  | "dashboard"
  | "history"
  | "published"
  | "sources"
  | "settings"
  | "review"
  | "create";

const navItems: Array<{
  id: OrganicView;
  label: string;
  icon: string;
}> = [
  { id: "dashboard", label: "Dashboard", icon: "/figma/nav-dashboard.svg" },
  { id: "history", label: "History", icon: "/figma/nav-history.svg" },
  { id: "published", label: "Published", icon: "/figma/nav-published.svg" },
  { id: "sources", label: "Sources", icon: "/figma/nav-sources.svg" },
  { id: "settings", label: "Settings", icon: "/figma/nav-settings.svg" },
];

function NavIcon({ src, alt }: { src: string; alt: string }) {
  return (
    <span className="organic-nav-icon">
      <img src={src} alt={alt} width={18} height={18} />
    </span>
  );
}

export function OrganicAppShell({
  view,
  onNavigate,
  onNewBriefing,
  pageTitle,
  headerRight,
  children,
  showFab = true,
  onFabClick,
  onFooterAction,
  footerYear,
  immersive = false,
}: {
  view: OrganicView;
  onNavigate: (view: OrganicView) => void;
  onNewBriefing: () => void;
  pageTitle: string;
  headerRight?: ReactNode;
  children: ReactNode;
  showFab?: boolean;
  onFabClick?: () => void;
  onFooterAction?: (label: string) => void;
  footerYear: number;
  immersive?: boolean;
}) {
  return (
    <div className="organic-app">
      <aside className="organic-sidebar">
        <div className="organic-brand-block">
          <h1 className="organic-brand-title">KernelZero</h1>
          <p className="organic-brand-sub">AI Production Tool</p>
        </div>

        <nav className="organic-nav" aria-label="Main">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`organic-nav-link ${view === item.id ? "is-active" : ""}`}
              onClick={() => onNavigate(item.id)}
            >
              <NavIcon src={item.icon} alt="" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="organic-sidebar-foot">
          <button type="button" className="organic-btn-new" onClick={onNewBriefing}>
            <img src="/figma/icon-plus.svg" alt="" width={10} height={10} />
            New Briefing
          </button>
        </div>
      </aside>

      <div className="organic-main">
        {!immersive && (
          <header className="organic-topbar">
            <h2 className="organic-page-title">{pageTitle}</h2>
            {headerRight ?? (
              <div className="organic-avatar">
                <img src="/figma/avatar.jpg" alt="Profile" />
              </div>
            )}
          </header>
        )}

        <div className="organic-canvas">{children}</div>

        {!immersive && (
          <footer className="organic-footer">
            <span>© {footerYear} KernelZero AI Production</span>
            <div className="organic-footer-links">
              <button type="button" onClick={() => onFooterAction?.("Privacy Policy")}>Privacy Policy</button>
              <button type="button" onClick={() => onFooterAction?.("Terms of Service")}>Terms of Service</button>
              <button type="button" onClick={() => onFooterAction?.("Help Center")}>Help Center</button>
            </div>
          </footer>
        )}
      </div>

      {showFab && view === "dashboard" && (
        <button
          type="button"
          className="organic-fab"
          aria-label="Start recording"
          onClick={onFabClick}
        >
          <img src="/figma/icon-mic-fab.svg" alt="" width={14} height={19} />
        </button>
      )}
    </div>
  );
}
