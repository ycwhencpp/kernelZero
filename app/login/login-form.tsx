"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthShell } from "../components/auth/auth-shell";
import { getSupabaseBrowser } from "../../lib/supabase-browser";

export function LoginForm({
  configured,
  initialError = null,
}: {
  configured: boolean;
  initialError?: string | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const supabase = getSupabaseBrowser();
    if (!supabase) {
      setError("Supabase Auth is not configured for this deployment.");
      return;
    }

    setBusy(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (signInError) {
      setError(
        signInError.message === "Invalid login credentials"
          ? "The email or password is incorrect."
          : signInError.message,
      );
      setBusy(false);
      return;
    }

    router.replace("/dashboard");
    router.refresh();
  };

  return (
    <AuthShell
      title="Sign in to KernelZero"
      intro="Use the account assigned to you by the workspace owner."
      footer={
        <>
          <p className="auth-switch">
            New to KernelZero? <Link href="/signup">Create an account</Link>
          </p>
          <p className="auth-access-note">
            Access and roles are assigned by the workspace owner.
          </p>
        </>
      }
    >
      <form className="auth-form" onSubmit={(event) => void signIn(event)}>
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
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
              disabled={busy || !configured}
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              title={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </label>

        {(error || !configured) && (
          <p className="auth-error" role="alert">
            {error ||
              "Add the Supabase URL and publishable key to enable sign in."}
          </p>
        )}

        <button
          type="submit"
          className="organic-btn organic-btn-lime auth-submit"
          disabled={busy || !configured}
        >
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}
