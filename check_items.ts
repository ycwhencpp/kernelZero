import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");

function requireEnvValue(name: string): string {
  const value = env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}

const supabaseUrl = requireEnvValue("NEXT_PUBLIC_SUPABASE_URL");
const supabaseKey = requireEnvValue("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { count, error } = await supabase.from("content_items").select("*", { count: 'exact', head: true });
  if (error) throw error;
  console.log(`Total items in DB: ${count}`);
}
run();
