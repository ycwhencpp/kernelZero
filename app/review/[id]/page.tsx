import type { OrganicView } from "../../components/organic/app-shell";
import { WorkspacePage } from "../../workspace-page";

export const dynamic = "force-dynamic";

const reviewReturnViews = new Set<OrganicView>([
  "dashboard",
  "history",
  "published",
]);

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const from = typeof query.from === "string" ? query.from : "dashboard";
  const initialReviewReturnView = reviewReturnViews.has(from as OrganicView)
    ? (from as OrganicView)
    : "dashboard";

  return (
    <WorkspacePage
      initialView="review"
      initialEpisodeId={id}
      initialReviewReturnView={initialReviewReturnView}
    />
  );
}
