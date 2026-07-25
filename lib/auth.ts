import { headers } from "next/headers";
import { DEMO_OWNER_ID } from "./demo-data";

export async function currentOwner(): Promise<string> {
  const requestHeaders = await headers();
  const authenticatedEmail = requestHeaders.get("oai-authenticated-user-email");
  if (authenticatedEmail) return authenticatedEmail.toLowerCase();

  if (process.env.REQUIRE_AUTH === "true") {
    throw new Error("AUTH_REQUIRED");
  }
  return requestHeaders.get("x-signalcast-user")?.toLowerCase() || DEMO_OWNER_ID;
}

export function authErrorResponse(error: unknown): Response | null {
  if (error instanceof Error && error.message === "AUTH_REQUIRED") {
    return Response.json(
      { error: "Sign in is required for this operation." },
      { status: 401 },
    );
  }
  return null;
}
