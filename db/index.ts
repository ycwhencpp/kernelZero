import { getSupabase } from "../lib/supabase";

/** Compatibility entry point for server code that needs the configured database. */
export function getDb() {
  const db = getSupabase();
  if (!db) throw new Error("Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  return db;
}
