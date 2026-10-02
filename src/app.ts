import bolt from "@slack/bolt";
import type { Config } from "./config.js";
import type { createDatabase } from "./db/client.js";
import { registerHandlers } from "./slack/handlers.js";

const { App, HTTPReceiver } = bolt;
export function createApp(
  config: Config,
  database: ReturnType<typeof createDatabase>,
  slackApiUrl?: string,
) {
  const receiver = new HTTPReceiver({
    signingSecret: config.signingSecret,
    endpoints: "/slack/events",
    processBeforeResponse: false,
    bodyLimit: 512 * 1024,
    customRoutes: [
      {
        path: "/",
        method: "GET",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            `<html><body><h1>Proxin</h1><p>Owl is running! <a href="/health">Health</a> <a href="/ready">Ready</a></p></body></html>`,
          );
        },
      },
      {
        path: "/health",
        method: "GET",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              status: "healthy",
              proxin: true,
              uptime: Math.floor(process.uptime()),
            }),
          );
        },
      },
      {
        path: "/ready",
        method: "GET",
        handler: async (_req, res) => {
          try {
            // check grations
            await database.pool.query("SELECT id FROM confessions LIMIT 0");
            res.writeHead(200);
            res.end("ready");
          } catch {
            res.writeHead(503);
            res.end("database not ready");
          }
        },
      },
    ],
  });
  const app = new App({
    token: config.token,
    receiver,
    deferInitialization: true,
    convoStore: false,
    clientOptions: {
      slackApiUrl,
      timeout: 10_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    },
  });
  const active = new Set<Promise<void>>();
  app.use(async ({ next }) => {
    const work = next();
    active.add(work);
    try {
      await work;
    } finally {
      active.delete(work);
    }
  });
  async function drain() {
    while (active.size) await Promise.allSettled(active);
  }
  app.error(async () => {
    console.error("slack broke, check logs?");
  });
  registerHandlers(app, database.db, config);
  return { app, receiver, drain };
}
