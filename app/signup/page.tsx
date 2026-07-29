import { redirect } from "next/navigation";
import { currentUser } from "../../lib/auth";
import { hasSupabaseAuthConfig } from "../../lib/supabase-server";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  if (await currentUser()) redirect("/dashboard");

  return <SignupForm configured={hasSupabaseAuthConfig()} />;
}
