import { redirect } from "next/navigation";
import { currentUser } from "../../lib/auth";
import { getPlatformDirectory } from "../../lib/platform-directory";
import { PlatformDirectoryShell } from "../components/organic/platform-directory-shell";
import { ExploreDirectory } from "./explore-directory";

export const dynamic = "force-dynamic";

function queryNumber(value: string | string[] | undefined): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) return undefined;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string | string[];
    pageSize?: string | string[];
  }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const query = await searchParams;
  const directory = await getPlatformDirectory({
    page: queryNumber(query.page),
    pageSize: queryNumber(query.pageSize),
  });

  return (
    <PlatformDirectoryShell user={user} pageTitle="Explore">
      <ExploreDirectory
        episodes={directory.episodes}
        creators={directory.creators}
        page={directory.page}
        pageSize={directory.pageSize}
        totalEpisodes={directory.totalEpisodes}
        totalPages={directory.totalPages}
      />
    </PlatformDirectoryShell>
  );
}
