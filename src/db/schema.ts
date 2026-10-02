import {
  pgTable,
  integer,
  text,
  jsonb,
  timestamp,
  pgEnum,
  uniqueIndex,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { RichTextBlock } from "@slack/web-api";
import { sql } from "drizzle-orm";

export const confessionStatus = pgEnum("confession_status", [
  "pending",
  "publishing",
  "accepted",
  "withdrawing",
  "rejected",
]);
export const confessions = pgTable(
  "confessions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity({ startWith: 40442 }),
    submissionId: text("submission_id").notNull().unique(),
    text: text("text").notNull(),
    content: jsonb("content").$type<RichTextBlock>(),
    replyKeyHash: text("reply_key_hash").unique(),
    authorSalt: text("author_salt"),
    authorHash: text("author_hash"),
    postChannel: text("post_channel").notNull(),
    reviewTs: text("review_ts"),
    postTs: text("post_ts"),
    warning: text("warning"),
    contentTs: text("content_ts"),
    status: confessionStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("confessions_published_message_idx").on(table.postChannel, table.postTs),
    check(
      "confessions_ownership_check",
      sql`(${table.replyKeyHash} IS NOT NULL AND ${table.authorSalt} IS NULL AND ${table.authorHash} IS NULL) OR (${table.replyKeyHash} IS NULL AND ${table.authorSalt} IS NOT NULL AND ${table.authorHash} IS NOT NULL) OR ${table.status} = 'rejected'`,
    ),
  ],
);
export const replies = pgTable(
  "replies",
  {
    confessionId: integer("confession_id")
      .notNull()
      .references(() => confessions.id),
    ts: text("ts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.confessionId, table.ts] })],
);
