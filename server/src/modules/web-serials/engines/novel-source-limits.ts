import type { EngineConnection } from './web-serial-engine';

export interface NovelSourceLimits {
  /** Longest one source may take to answer a search. */
  sourceSearchMs: number;
  /** Whole-search deadline for catalog and source search over every source. */
  catalogSearchMs: number;
  /** Budget for the candidate search step of "Download from". */
  candidateSearchMs: number;
  /** Budget for opening the shortlisted novels of "Download from". */
  candidateLoadMs: number;
}

const DEFAULT_LIMITS: NovelSourceLimits = {
  sourceSearchMs: 12_000,
  catalogSearchMs: 30_000,
  candidateSearchMs: 15_000,
  candidateLoadMs: 30_000,
};

/** A FlareSolverr/Byparr solver solves a Cloudflare challenge on a site's first call, which takes 3 to 15 s. */
const SOLVER_LIMITS: NovelSourceLimits = {
  sourceSearchMs: 30_000,
  catalogSearchMs: 35_000,
  candidateSearchMs: 35_000,
  candidateLoadMs: 45_000,
};

export function novelSourceLimits(connection: Pick<EngineConnection, 'solver'>, solverFallback?: boolean): NovelSourceLimits {
  return (connection.solver ?? solverFallback) === true ? SOLVER_LIMITS : DEFAULT_LIMITS;
}

/**
 * The service's own deadline for loading one chapter list (60 s plus 3 s per page, capped at 31 min, which fits 600 pages
 * at its 1.5 s request spacing), plus a margin. Background work keeps asking until then.
 */
export const NOVEL_SOURCES_NOVEL_LOAD_CAP_MS = 31 * 60_000 + 30_000;

/**
 * How long BookOrbit waits for each novel-sources route. Each value sits just above that route's deadline in the service.
 * A chapter list still loading after the service's wait (45 s by default) comes back as 202 and is asked for again, so no
 * single novel request comes near undici's 5 minute header and body limits.
 */
export const NOVEL_SOURCES_ROUTE_TIMEOUTS_MS = {
  health: 10_000,
  list: 15_000,
  browse: 60_000,
  novel: 4 * 60_000 + 30_000,
  novelInteractive: 90_000,
  chapter: 60_000,
  install: 120_000,
} as const;

/** Margin over a search's own deadline, so the caller's deadline is the one that ends the call. */
export const NOVEL_SOURCES_SEARCH_MARGIN_MS = 2_000;
