/**
 * SQLite persistence middleware for the Telegram Grammy bot.
 *
 * Saves every incoming message to a local DB before it reaches the orchestrator.
 * DB file: ${STATE_DIR}/messages.db
 *
 * Schema:
 *   messages(id, chat_id, tg_msg_id, user_id, ts, kind, text, file_id, file_path, raw_json)
 *
 * DB write failures are non-fatal — errors are logged to stderr and the
 * message continues to the next middleware unchanged.
 */

import { Database } from 'bun:sqlite'
import type { Context } from 'grammy'
import { join } from 'path'
import { mkdirSync } from 'fs'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  tg_msg_id  INTEGER,
  user_id    TEXT,
  ts         INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  text       TEXT,
  file_id    TEXT,
  file_path  TEXT,
  raw_json   TEXT
);
`

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, ts);
`

/**
 * Open (or create) the messages.db in stateDir, ensure the schema exists,
 * and return the Database handle.
 */
export function initDb(stateDir: string): Database {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const dbPath = join(stateDir, 'messages.db')
  const db = new Database(dbPath)
  db.exec(CREATE_TABLE_SQL)
  db.exec(CREATE_INDEX_SQL)
  return db
}

/**
 * Derive a kind string from the Grammy context.
 * Priority: text > voice > photo > everything else → 'file'
 */
function deriveKind(ctx: Context): string {
  const msg = ctx.message
  if (!msg) return 'file'
  if (msg.text) return 'text'
  if (msg.voice) return 'voice'
  if (msg.photo) return 'photo'
  return 'file'
}

/**
 * Derive the file_id from the Grammy context, if any.
 */
function deriveFileId(ctx: Context): string | null {
  const msg = ctx.message
  if (!msg) return null
  if (msg.voice) return msg.voice.file_id
  if (msg.photo) {
    // Largest size is last in the array
    const photos = msg.photo
    if (photos.length > 0) return photos[photos.length - 1].file_id
  }
  if (msg.document) return msg.document.file_id
  if (msg.audio) return msg.audio.file_id
  if (msg.video) return msg.video.file_id
  if (msg.video_note) return msg.video_note.file_id
  if (msg.sticker) return msg.sticker.file_id
  return null
}

const INSERT_SQL = `
INSERT INTO messages (chat_id, tg_msg_id, user_id, ts, kind, text, file_id, file_path, raw_json)
VALUES ($chat_id, $tg_msg_id, $user_id, $ts, $kind, $text, $file_id, $file_path, $raw_json)
`

/**
 * Persist an incoming Telegram message to the DB.
 * Non-fatal: any DB error is logged to stderr and swallowed.
 */
export function persistMessage(db: Database, ctx: Context): void {
  try {
    const msg = ctx.message
    const chat_id = String(ctx.chat?.id ?? '')
    const tg_msg_id = msg?.message_id ?? null
    const user_id = ctx.from ? String(ctx.from.id) : null
    // Telegram message date is Unix seconds; store as ms for consistency
    const ts = msg?.date != null ? msg.date * 1000 : Date.now()
    const kind = deriveKind(ctx)
    const text = msg?.text ?? msg?.caption ?? null
    const file_id = deriveFileId(ctx)
    const file_path: string | null = null // file downloads are out of scope
    let raw_json: string | null = null
    try {
      raw_json = msg ? JSON.stringify(msg) : null
    } catch {
      // If the message cannot be serialised, skip raw_json
    }

    const stmt = db.prepare(INSERT_SQL)
    stmt.run({
      $chat_id: chat_id,
      $tg_msg_id: tg_msg_id,
      $user_id: user_id,
      $ts: ts,
      $kind: kind,
      $text: text,
      $file_id: file_id,
      $file_path: file_path,
      $raw_json: raw_json,
    })
  } catch (err) {
    process.stderr.write(`telegram channel: persistence error (non-fatal): ${err}\n`)
  }
}
