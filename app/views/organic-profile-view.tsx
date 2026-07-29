"use client";

import { useState } from "react";
import type { AppUser } from "../../lib/types";
import { getSupabaseBrowser } from "../../lib/supabase-browser";

export function OrganicProfileView({
  user,
  onUserUpdate,
  onNotify,
}: {
  user: AppUser;
  onUserUpdate: (user: AppUser) => void;
  onNotify: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notifications, setNotifications] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark" | "system">("light");
  const [busy, setBusy] = useState(false);

  const saveProfile = async () => {
    if (displayName.trim().length < 2) {
      onNotify("Enter a display name with at least two characters.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: displayName.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        user?: AppUser;
        error?: string;
      };
      if (!response.ok || !payload.user) {
        throw new Error(payload.error || "Unable to update profile.");
      }
      onUserUpdate(payload.user);
      setEditing(false);
      onNotify("Profile updated.");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Unable to update profile.");
    } finally {
      setBusy(false);
    }
  };

  const updatePassword = async () => {
    if (password.length < 8) {
      onNotify("Use at least eight characters for your new password.");
      return;
    }
    if (password !== confirmPassword) {
      onNotify("The password confirmation does not match.");
      return;
    }
    const supabase = getSupabaseBrowser();
    if (!supabase) {
      onNotify("Supabase Auth is not configured.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      onNotify(error.message);
      return;
    }
    setPassword("");
    setConfirmPassword("");
    setPasswordOpen(false);
    onNotify("Password updated.");
  };

  const roleCopy =
    user.role === "owner"
      ? "Full workspace control, including publishing and member roles."
      : user.role === "editor"
        ? "Can create, generate, and edit briefings. Publishing stays with the owner."
        : "Read-only access to workspace research, history, and published episodes.";

  return (
    <div className="organic-profile-page">
      <header className="organic-profile-heading">
        <div>
          <h1>Account Settings</h1>
          <p>From signal to insight.</p>
        </div>
        <div className="organic-profile-header-actions">
          <span className={`organic-role-badge role-${user.role}`}>
            {user.role.toUpperCase()}
          </span>
          <form action="/auth/signout" method="post">
            <button type="submit" className="organic-text-link">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="organic-profile-card">
        <div className="organic-profile-avatar">
          <img
            src={user.avatarUrl || "/user-placeholder.svg"}
            alt="User profile placeholder"
          />
          <button
            type="button"
            title="Edit profile"
            aria-label="Edit profile"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        </div>

        <div className="organic-profile-details">
          <div>
            <span>Full Name</span>
            {editing ? (
              <input
                className="organic-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={80}
              />
            ) : (
              <strong>{user.displayName}</strong>
            )}
          </div>
          <div>
            <span>Email Address</span>
            <p>{user.email}</p>
          </div>
          <div>
            <span>Production Role</span>
            <p className="organic-profile-role">
              <i>{user.role.toUpperCase()}</i>
              {user.role === "owner"
                ? "Workspace Owner"
                : user.role === "editor"
                  ? "Production Editor"
                  : "Workspace Viewer"}
            </p>
          </div>
        </div>

        <div className="organic-profile-edit-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="organic-btn organic-btn-dark"
                disabled={busy}
                onClick={() => void saveProfile()}
              >
                Save profile
              </button>
              <button
                type="button"
                className="organic-btn organic-btn-outline"
                disabled={busy}
                onClick={() => {
                  setDisplayName(user.displayName);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="organic-btn organic-btn-outline"
              onClick={() => setEditing(true)}
            >
              Edit Profile
            </button>
          )}
        </div>
      </section>

      <div className="organic-profile-bento">
        <section className="organic-profile-panel">
          <div className="organic-profile-panel-title">
            <span aria-hidden="true">S</span>
            <h2>Security</h2>
          </div>
          {!passwordOpen ? (
            <button
              type="button"
              className="organic-profile-row"
              onClick={() => setPasswordOpen(true)}
            >
              <span>
                <strong>Update Password</strong>
                <small>Choose a new password for this account</small>
              </span>
              <b aria-hidden="true">›</b>
            </button>
          ) : (
            <div className="organic-password-form">
              <label className="organic-field">
                <span>New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label className="organic-field">
                <span>Confirm password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              <div className="organic-inline-actions">
                <button
                  type="button"
                  className="organic-btn organic-btn-dark"
                  disabled={busy}
                  onClick={() => void updatePassword()}
                >
                  Update
                </button>
                <button
                  type="button"
                  className="organic-btn organic-btn-outline"
                  disabled={busy}
                  onClick={() => setPasswordOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="organic-profile-row static">
            <span>
              <strong>Secure session</strong>
              <small>Supabase Auth cookie protection is active</small>
            </span>
            <i className="organic-security-state">ON</i>
          </div>
        </section>

        <section className="organic-profile-panel">
          <div className="organic-profile-panel-title">
            <span aria-hidden="true">P</span>
            <h2>Preferences</h2>
          </div>
          <div className="organic-profile-row static">
            <strong>Briefing Status Notifications</strong>
            <button
              type="button"
              className={`organic-toggle ${notifications ? "is-on" : ""}`}
              aria-label="Briefing status notifications"
              aria-pressed={notifications}
              onClick={() => setNotifications((value) => !value)}
            >
              {notifications ? "ON" : "OFF"}
            </button>
          </div>
          <fieldset className="organic-theme-fieldset">
            <legend>Interface Theme</legend>
            <div>
              {(["light", "dark", "system"] as const).map((option) => (
                <button
                  type="button"
                  key={option}
                  className={theme === option ? "is-active" : ""}
                  onClick={() => {
                    setTheme(option);
                    onNotify(
                      option === "light"
                        ? "Light theme selected."
                        : "Additional themes are prepared for a future release.",
                    );
                  }}
                >
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
          </fieldset>
        </section>
      </div>

      <section className="organic-access-panel">
        <div>
          <p className="organic-eyebrow light">WORKSPACE ACCESS</p>
          <h2>
            {user.role === "owner"
              ? "Owner permissions"
              : user.role === "editor"
                ? "Editor permissions"
                : "Viewer permissions"}
          </h2>
          <p>{roleCopy}</p>
        </div>
        <dl>
          <div>
            <dt>Create &amp; edit</dt>
            <dd>{user.role === "viewer" ? "No" : "Yes"}</dd>
          </div>
          <div>
            <dt>Publish</dt>
            <dd>{user.role === "owner" ? "Owner only" : "No"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
