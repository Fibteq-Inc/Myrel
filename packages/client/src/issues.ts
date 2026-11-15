/**
 * How the Issues tab's list stays current, on the web and on mobile. Issues change on GitHub, where
 * nothing tells Myrel: an agent or a person can open one at any moment. So every time the list comes
 * on screen it asks again, showing what it has meanwhile, and it asks once a minute while it stays
 * there. Each ask is one GitHub request per connected repository.
 */
export const ISSUE_LIST_FRESHNESS = { staleTime: 0, refetchInterval: 60_000 } as const;
