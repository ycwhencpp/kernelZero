"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthShell } from "../components/auth/auth-shell";
import { getSupabaseBrowser } from "../../lib/supabase-browser";

export function SignupForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signUp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (password !== passwordConfirmation) {
      setError("The passwords do not match.");
      return;
    }

    const supabase = getSupabaseBrowser();
    if (!supabase) {
      setError("Supabase Auth is not configured for this deployment.");
      return;
    }

    setBusy(true);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { full_name: displayName.trim() },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setBusy(false);
      return;
    }

    if (data.session) {
      router.replace("/dashboard");
      router.refresh();
      return;
    }

    setConfirmationSent(true);
    setBusy(false);
  };

  if (confirmationSent) {
    return (
      <AuthShell
        eyebrow="EMAIL VERIFICATION"
        title="Check your inbox"
        intro="Your account is almost ready."
        footer={
          <p className="auth-switch">
            Already confirmed? <Link href="/login">Sign in</Link>
          </p>
        }
      >
        <div className="auth-form auth-confirmation" role="status">
          <strong>Confirm your email address</strong>
          <p>
            Follow the verification link sent to <span>{email.trim()}</span>.
            The link will return you to your workspace.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      intro="Join the private workspace with your verified email address."
      footer={
        <>
          <p className="auth-switch">
            Already have an account? <Link href="/login">Sign in</Link>
          </p>
          <p className="auth-access-note">
            New accounts begin as viewers. The owner assigns elevated roles.
          </p>
        </>
      }
    >
      <form className="auth-form" onSubmit={(event) => void signUp(event)}>
        <label className="organic-field">
          <span>Display name</span>
          <input
            type="text"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Your name"
            required
            maxLength={80}
            disabled={busy || !configured}
          />
        </label>
        <label className="organic-field">
          <span>Email address</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            required
            disabled={busy || !configured}
          />
        </label>
        <label className="organic-field">
          <span>Password</span>
          <div className="auth-password-field">
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              disabled={busy || !configured}
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide passwords" : "Show passwords"}
              title={showPassword ? "Hide passwords" : "Show passwords"}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        <label className="organic-field">
          <span>Confirm password</span>
          <input
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={passwordConfirmation}
            onChange={(event) => setPasswordConfirmation(event.target.value)}
            required
            minLength={8}
            disabled={busy || !configured}
          />
        </label>

        {(error || !configured) && (
          <p className="auth-error" role="alert">
            {error ||
              "Add the Supabase URL and publishable key to enable signup."}
          </p>
        )}

        <button
          type="submit"
          className="organic-btn organic-btn-lime auth-submit"
          disabled={busy || !configured}
        >
          {busy ? "Creating account..." : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}
