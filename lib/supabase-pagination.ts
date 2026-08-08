type PaginatedQueryError = {
  message: string;
};

type PaginatedQueryResult<T> = {
  data: T[] | null;
  error: PaginatedQueryError | null;
};

type PaginatedLoadResult<T> = {
  data: T[];
  error: PaginatedQueryError | null;
};

/**
 * Supabase/PostgREST commonly limits a response to 1,000 rows even when the
 * query itself has no explicit limit. Fetch consecutive ranges so callers do
 * not silently mistake the first page for the complete workspace state.
 */
export async function loadAllPaginatedRows<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<PaginatedQueryResult<T>>,
  pageSize = 1_000,
): Promise<PaginatedLoadResult<T>> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("Pagination page size must be a positive integer.");
  }

  const data: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    if (page.error) return { data, error: page.error };

    const rows = page.data ?? [];
    data.push(...rows);
    if (rows.length < pageSize) return { data, error: null };
  }
}
