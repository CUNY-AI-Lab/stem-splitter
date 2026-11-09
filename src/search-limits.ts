// Song search is open to guests, and a search YouTube does not answer in time goes to the
// YouTube fetcher, which runs on one machine on an ordinary connection. These limits are a
// backstop against scripts, set above what people searching produce:
//
// - SEARCH_LIMIT: each person's searches, 120 a minute. The page searches as someone types,
//   so one title takes 5 to 15 requests. Past it, the search is refused with 429.
// - FETCHER_SEARCH_LIMIT: each person's searches that reach the fetcher, 10 a minute (the
//   owner's figure: a new song every 6 seconds). Searches cancelled while someone types end
//   before the fetcher is asked, so typing a title rarely counts more than once.
//
// The total that reaches YouTube is the fetcher's to keep (youtube-fetcher/fetcher.py): it
// alone sees Dev and production, searches and imports, and what its cache answers. It stays
// under YouTube's documented rate for one connection, because a bot check would also stop
// imports. Past a limit here or a refusal there, YouTube is left out of that one search; the
// other sources still answer. Counts here are kept per Cloudflare location.
type Limiter = { limit(input: { key: string }): Promise<{ success: boolean }> };
export type SearchLimits = { SEARCH_LIMIT?: Limiter; FETCHER_SEARCH_LIMIT?: Limiter };

/** Who is searching: the account or guest session, or, without one, the connection. */
export function searcherKey(subject: string | undefined, address: string | undefined): string {
  return subject ? `account:${subject}` : `address:${address || 'unknown'}`;
}

/** Whether this person may search now. A limiter that fails does not stop search. */
export async function searchAllowed(env: SearchLimits, searcher: string): Promise<boolean> {
  if (!env.SEARCH_LIMIT) return true;
  try { return (await env.SEARCH_LIMIT.limit({ key: `music-search:${searcher}` })).success; }
  catch { return true; }
}

/** Whether this person's search may go to the fetcher. A limiter that fails leaves YouTube
 *  out, because the fetcher, unlike search, cannot take an unbounded load. */
export async function fetcherSearchAllowed(env: SearchLimits, searcher: string): Promise<boolean> {
  if (!env.FETCHER_SEARCH_LIMIT) return true;
  try { return (await env.FETCHER_SEARCH_LIMIT.limit({ key: `fetcher-search:${searcher}` })).success; }
  catch { return false; }
}
