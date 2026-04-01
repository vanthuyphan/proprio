import type { MetaHarness } from "./index.js";

interface Request {
  method: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  user?: { id?: string };
  headers?: Record<string, string | string[] | undefined>;
}

interface Response {
  statusCode?: number;
  on(event: string, cb: () => void): void;
}

interface MiddlewareOptions {
  actorFromRequest?: (req: Request) => string | undefined;
  excludeRoutes?: string[];
  trackRoutes?: boolean;
}

export default function metaHarnessMiddleware(
  harness: MetaHarness,
  options?: MiddlewareOptions,
) {
  const {
    actorFromRequest = (req) => req.user?.id ?? "anonymous",
    excludeRoutes = ["/health", "/healthz", "/metrics", "/favicon.ico"],
    trackRoutes = true,
  } = options ?? {};

  return (req: Request, res: Response, next: () => void) => {
    if (!trackRoutes) return next();

    const route = req.originalUrl ?? req.url ?? req.path ?? "/";
    if (excludeRoutes.some((r) => route.startsWith(r))) return next();

    const actor = actorFromRequest(req) ?? "anonymous";
    const startTime = Date.now();

    res.on("finish", () => {
      const durationMs = Date.now() - startTime;
      const statusCode = res.statusCode;
      harness.trackApiCall(route, req.method, actor, {
        ...(statusCode !== undefined ? { statusCode } : {}),
        durationMs,
      });
    });

    next();
  };
}
