import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("can we test?", () => {
  expect(1 + 1).toBe(2);
});

test("can we test async?", async () => {
  const result = await new Promise((resolve) => setTimeout(() => resolve(67), 100));
  expect(result).toBe(67);
});

test("health reports total process uptime in whole seconds", () => {
  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { createApp } from "./src/app.ts";
        import { readConfig } from "./src/config.ts";
        import { createDatabase } from "./src/db/client.ts";
        const config = readConfig({
          DATABASE_URL: "postgres://localhost/prox3_test",
          SLACK_BOT_TOKEN: "xoxb-test",
          SLACK_SIGNING_SECRET: "test-secret",
          POST_CHANNEL: "post", META_CHANNEL: "meta",
          REVIEW_CHANNEL: "review", LOG_CHANNEL: "log",
        });
        const database = createDatabase(config.databaseUrl);
        const { receiver } = createApp(config, database);
        const originalUptime = process.uptime;
        try {
          const server = await receiver.start(0);
          const url = "http://127.0.0.1:" + server.address().port + "/health";
          process.uptime = () => 123.9;
          const response = await fetch(url);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("content-type"), "application/json");
          assert.deepEqual(await response.json(), {
            ok: true, status: "healthy", proxin: true, uptime: 123,
          });
          process.uptime = () => 125.1;
          assert.equal((await (await fetch(url)).json()).uptime, 125);
        } finally {
          process.uptime = originalUptime;
          await receiver.stop();
          await database.pool.end();
        }
      `,
    ],
    { encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
