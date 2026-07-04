import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./Layout";
import { TodayScreen } from "../screens/today/TodayScreen";
import { EdgeBoardScreen } from "../screens/edge-board/EdgeBoardScreen";
import { EdgeDetailScreen } from "../screens/edge-detail/EdgeDetailScreen";
import { DataHealthScreen } from "../screens/data-health/DataHealthScreen";

const rootRoute = createRootRoute({ component: Layout });

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: TodayScreen
});

// Research Readiness (docs/06 §7, 2026-07 design): Today's summary rows
// link here with `?readiness=STATE` so the Board opens pre-filtered to
// the state the user clicked (e.g. "今すぐ評価可能" -> readiness=READY).
export interface BoardSearch {
  readiness?: string | undefined;
}

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/board",
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    readiness: typeof search.readiness === "string" ? search.readiness : undefined
  }),
  component: EdgeBoardScreen
});

const edgeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/edges/$edgeId",
  component: EdgeDetailScreen
});

const dataHealthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data-health",
  component: DataHealthScreen
});

const routeTree = rootRoute.addChildren([todayRoute, boardRoute, edgeDetailRoute, dataHealthRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
