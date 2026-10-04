# Owl

_hoot hoot!_

a simple Slack bot for anonymous confessions, replies, and reactions. built to be fast, secure, and not fancy. it should stand the test of time, and not be a burden to maintain. best deployed to Coolify via the [`Dockerfile`](Dockerfile). database is managed by drizzle and migrations are handled by `bun run db:migrate`.

## local setup

```sh
bun install --frozen-lockfile
cp .env.example .env
# set Slack creds and channel IDs now
docker compose up -d --wait
bun run db:migrate
bun run dev
```

we also use [oxc](https://oxc.rs/) tooling for formatting and linting, so pls run `bun fmt` and `bun lint` before committing!

## cmds

| what it is              | what it do                                            |
| ----------------------- | ----------------------------------------------------- |
| `/owl [message]`        | open the confession form                              |
| `/owl-self-reject <id>` | //undo your confession when provided a id             |
| `/owl-revive`           | useful for reviewers to check the backlog when needed |
| reply anon              | reply as the OP                                       |
| react anon              | react as the OP                                       |

the submission form lets you choose a salted account hash or a generated private reply key. neither mode stores your raw Slack user ID. the private key mode needs both the key and the original account for replies, reactions, and withdrawal. you gotta save the key when it is shown, if it is lost, then its gg.

account hashes recognize your account automatically. they are salted and peppered and run through scrypt, so a leaked database alone is useless and checking every Slack user ID against one post takes hours of CPU instead of instantly. someone with both the database and the pepper can still check a _specific_ guess quickly though, so use the private key if that matters to you. the owl bot running in Hack Club is hosted by trusted members of the community and less people have access to the owl database than the original prox2 database!

## credits

- [espcaa/djungelskog](https://github.com/espcaa/djungelskog) for private key system
- [anirudhb/prox2](https://github.com/anirudhb/prox2) for the original idea and much of the structure
- [hanaeatsplanes/prox3](https://github.com/hanaeatsplanes/prox3) for many improvements and QoL features
- [emojikitchen.dev](https://emojikitchen.dev/) for the pfp
