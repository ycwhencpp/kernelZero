import { DashboardClient } from "./dashboard-client";
import { currentOwner } from "../lib/auth";
import { getDashboardState } from "../lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const state = await getDashboardState(await currentOwner());
  return <DashboardClient initialState={state} />;
}
