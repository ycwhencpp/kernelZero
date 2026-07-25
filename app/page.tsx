import { DashboardClient } from "./dashboard-client";
import { demoState } from "../lib/demo-data";

export const dynamic = "force-dynamic";

export default function Home() {
  return <DashboardClient initialState={demoState} />;
}
