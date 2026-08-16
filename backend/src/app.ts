import express from "express";

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

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      // db: reported here once Postgres is wired up (blocked on Docker).
    });
  });

  return app;
}
