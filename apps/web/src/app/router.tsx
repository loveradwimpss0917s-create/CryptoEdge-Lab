import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./Layout";
import { TodayScreen } from "../screens/today/TodayScreen";
import { EdgeBoardScreen } from "../screens/edge-board/EdgeBoardScreen";
import { EdgeDetailScreen } from "../screens/edge-detail/EdgeDetailScreen";

const rootRoute = createRootRoute({ component: Layout });

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: TodayScreen
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/board",
  component: EdgeBoardScreen
});

const edgeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/edges/$edgeId",
  component: EdgeDetailScreen
});

const routeTree = rootRoute.addChildren([todayRoute, boardRoute, edgeDetailRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
