import { notFound, redirect } from "next/navigation";
import { currentUser } from "../../../lib/auth";
import { getPlatformCreator } from "../../../lib/platform-directory";
import { PlatformDirectoryShell } from "../../components/organic/platform-directory-shell";
import { CreatorProfile } from "./creator-profile";

export const dynamic = "force-dynamic";

export default async function CreatorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [user, { id }] = await Promise.all([currentUser(), params]);
  if (!user) redirect("/login");

  const result = await getPlatformCreator(id);
  if (!result) notFound();
  if (
    result.episodes.length === 0 &&
    user.workspaceOwnerId !== result.creator.id
  ) {
    notFound();
  }

  return (
    <PlatformDirectoryShell
      user={user}
      pageTitle={result.creator.displayName}
    >
      <CreatorProfile
        creator={result.creator}
        episodes={result.episodes}
      />
    </PlatformDirectoryShell>
  );
}
