"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_AVATAR_BYTES } from "../../lib/profile-avatar";
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
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notifications, setNotifications] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark" | "system">("light");
  const [busy, setBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    },
    [avatarPreviewUrl],
  );

  const clearAvatarDraft = () => {
    setAvatarFile(null);
    setAvatarPreviewUrl(null);
    setRemoveAvatar(false);
    if (avatarInputRef.current) avatarInputRef.current.value = "";
  };

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
      let updatedUser = payload.user;

      if (avatarFile) {
        const avatarForm = new FormData();
        avatarForm.set("avatar", avatarFile);
        const avatarResponse = await fetch("/api/profile/avatar", {
          method: "POST",
          body: avatarForm,
        });
        const avatarPayload = (await avatarResponse.json().catch(() => ({}))) as {
          user?: AppUser;
          error?: string;
        };
        if (!avatarResponse.ok || !avatarPayload.user) {
          throw new Error(avatarPayload.error || "Unable to upload profile picture.");
        }
        updatedUser = avatarPayload.user;
      } else if (removeAvatar) {
        const avatarResponse = await fetch("/api/profile/avatar", {
          method: "DELETE",
        });
        const avatarPayload = (await avatarResponse.json().catch(() => ({}))) as {
          user?: AppUser;
          error?: string;
        };
        if (!avatarResponse.ok || !avatarPayload.user) {
          throw new Error(avatarPayload.error || "Unable to remove profile picture.");
        }
        updatedUser = avatarPayload.user;
      }

      onUserUpdate(updatedUser);
      clearAvatarDraft();
      setEditing(false);
      onNotify("Profile updated.");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Unable to update profile.");
    } finally {
      setBusy(false);
    }
  };

  const chooseAvatar = (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      onNotify("Profile pictures must be 3 MB or smaller.");
      if (avatarInputRef.current) avatarInputRef.current.value = "";
      return;
    }
    if (
      file.type &&
      !["image/jpeg", "image/png", "image/webp"].includes(file.type)
    ) {
      onNotify("Choose a JPEG, PNG, or WebP image.");
      if (avatarInputRef.current) avatarInputRef.current.value = "";
      return;
    }
    setAvatarFile(file);
    setAvatarPreviewUrl(URL.createObjectURL(file));
    setRemoveAvatar(false);
  };

  const markAvatarForRemoval = () => {
    setAvatarFile(null);
    setAvatarPreviewUrl(null);
    setRemoveAvatar(Boolean(user.avatarUrl));
    if (avatarInputRef.current) avatarInputRef.current.value = "";
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
      ? "Full control of this private workspace, including publishing."
      : user.role === "editor"
        ? "Can create, generate, and edit briefings. Publishing stays with the owner."
        : "Read-only access to workspace research, history, and published episodes.";
  const displayedAvatarUrl = editing
    ? avatarPreviewUrl || (removeAvatar ? null : user.avatarUrl)
    : user.avatarUrl;

  return (
    <div className="organic-profile-page">
      <header className="organic-profile-heading">
        <div>
          <h1>Account Settings</h1>
          <p>From signal to insight.</p>
        </div>
        <div className="organic-profile-header-actions">
          <a
            className="organic-text-link"
            href={`/creators/${encodeURIComponent(user.workspaceOwnerId)}`}
          >
            View public profile
          </a>
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
            src={displayedAvatarUrl || "/user-placeholder.svg"}
            alt={`${user.displayName} profile`}
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
            <span>Profile Picture</span>
            {editing ? (
              <div className="organic-avatar-upload">
                <input
                  ref={avatarInputRef}
                  className="organic-input"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={busy}
                  onChange={(event) =>
                    chooseAvatar(event.currentTarget.files?.[0] ?? null)
                  }
                />
                <small>JPEG, PNG, or WebP. Maximum 3 MB.</small>
                {avatarFile ? <small>Selected: {avatarFile.name}</small> : null}
                {(user.avatarUrl || avatarFile) && !removeAvatar ? (
                  <button
                    type="button"
                    className="organic-text-link"
                    disabled={busy}
                    onClick={markAvatarForRemoval}
                  >
                    Remove picture
                  </button>
                ) : null}
                {removeAvatar ? <small>Picture will be removed when saved.</small> : null}
              </div>
            ) : (
              <p>{user.avatarUrl ? "Custom picture" : "Default picture"}</p>
            )}
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
                {busy ? "Saving…" : "Save profile"}
              </button>
              <button
                type="button"
                className="organic-btn organic-btn-outline"
                disabled={busy}
                onClick={() => {
                  setDisplayName(user.displayName);
                  clearAvatarDraft();
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
