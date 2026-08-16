import express from "express";
import { isDatabaseUp } from "./db.js";
import { devRouter } from "./dev.js";
import { roomsRouter } from "./rooms.js";

/**
 * The Express app, separated from the listening socket (src/index.ts).
 *
 * Same principle as HuddleCore never touching SwiftUI: the app is a pure
 * object that tests can call directly (supertest) without binding a port,
 * and later the ws upgrade handler attaches around it without changing it.
 */
export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    const dbUp = await isDatabaseUp();
    // 503 when a dependency is down: deploy platforms and load balancers
    // read the status code, not the body. "ok with a sad body" would keep
    // routing traffic to an instance that can't serve it.
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? "ok" : "degraded",
      db: dbUp ? "up" : "down",
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use(roomsRouter);
  app.use(devRouter);

  // Terminal error boundary: anything a route throws (or rejects with,
  // Express 5 forwards async rejections here) becomes a clean 500 instead
  // of a hung request. Log the cause, never leak it to the client.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response,
     _next: express.NextFunction) => {
      console.error("[error]", err);
      res.status(500).json({ error: "internal error" });
    },
  );

  return app;
}
