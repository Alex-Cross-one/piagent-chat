CREATE TABLE bridge_sessions (id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX bridge_sessions_owner ON bridge_sessions (owner, updated_at);
--> statement-breakpoint
CREATE TABLE bridge_messages (id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES bridge_sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, reply_to TEXT REFERENCES bridge_messages(id) ON DELETE CASCADE, idempotency_key TEXT);
--> statement-breakpoint
CREATE UNIQUE INDEX bridge_reply_once ON bridge_messages (owner, reply_to);
--> statement-breakpoint
CREATE UNIQUE INDEX bridge_reply_key ON bridge_messages (owner, idempotency_key);
--> statement-breakpoint
CREATE INDEX bridge_messages_session ON bridge_messages (owner, session_id, created_at);
--> statement-breakpoint
CREATE TABLE bridge_subscriptions (id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, old_secret TEXT, rotation_until INTEGER, expires_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE INDEX bridge_subscriptions_owner ON bridge_subscriptions (owner, expires_at);
--> statement-breakpoint
CREATE TABLE bridge_outbox (id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, sub_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES bridge_sessions(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES bridge_messages(id) ON DELETE CASCADE, event_id TEXT NOT NULL, created_at INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT);
--> statement-breakpoint
CREATE INDEX bridge_outbox_due ON bridge_outbox (owner, status, next_at);
