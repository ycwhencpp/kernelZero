import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabaseServer } from "../../../lib/supabase-server";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const authCookieNames = cookieStore
    .getAll()
    .map(({ name }) => name)
    .filter((name) => name.startsWith("sb-") && name.includes("-auth-token"));
  const supabase = await getSupabaseServer();
  await supabase?.auth.signOut();
  const response = NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
  authCookieNames.forEach((name) => {
    response.cookies.set(name, "", {
      expires: new Date(0),
      maxAge: 0,
      path: "/",
      sameSite: "lax",
    });
  });
  return response;
}
