// hashes are useless without this, so a short or missing one is a hard fucky wucky
function readPepper(env: NodeJS.ProcessEnv = process.env) {
  const value = env.OWL_PEPPER?.trim() ?? "";
  if (value.length < 32) throw new Error("yo i need OWL_PEPPER (try `openssl rand -hex 32`)");
  return value;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  function required(name: string) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`yo i need ${name}`);
    return value;
  }
  function integer(name: string, fallback: number) {
    const value = Number(env[name] ?? fallback);
    return value;
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    token: required("SLACK_BOT_TOKEN"),
    signingSecret: required("SLACK_SIGNING_SECRET"),
    pepper: readPepper(env),
    channels: {
      post: required("POST_CHANNEL"),
      meta: required("META_CHANNEL"),
      review: required("REVIEW_CHANNEL"),
      log: required("LOG_CHANNEL"),
    },
    port: integer("PORT", 8080),
    poolSize: integer("DB_POOL_SIZE", 10),
  };
}
export type Config = ReturnType<typeof readConfig>;
