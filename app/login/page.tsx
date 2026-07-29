import { redirect } from "next/navigation";
import { currentUser } from "../../lib/auth";
import { hasSupabaseAuthConfig } from "../../lib/supabase-server";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  if (await currentUser()) redirect("/dashboard");

  const query = await searchParams;
  const initialError =
    query.error === "confirmation_failed"
      ? "We could not verify that signup link. Request a new link or sign in if your account is already confirmed."
      : null;

  return (
    <LoginForm
      configured={hasSupabaseAuthConfig()}
      initialError={initialError}
    />
  );
}
