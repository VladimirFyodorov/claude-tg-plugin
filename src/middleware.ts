/**
 * Middleware composition utilities for claude-tg-plugin.
 *
 * Provides:
 *   - compose(middlewares): runs a pipeline in onion/koa style
 *   - normalizeGrammyCtx(ctx): converts a Grammy Context to MiddlewareCtx
 */

import type { Middleware, MiddlewareCtx, TgAttachment } from './types.ts'

/**
 * Compose an array of Middleware functions into a single middleware.
 *
 * Execution order follows the koa/onion model:
 *   - Middleware are called in array order (left to right) on the way in.
 *   - After the innermost next() resolves, control unwinds right to left.
 *
 * compose([]) returns a no-op that immediately resolves.
 */
export function compose(middlewares: Middleware[]): Middleware {
  return async function composedMiddleware(ctx: MiddlewareCtx, next: () => Promise<void>): Promise<void> {
    let index = -1

    async function dispatch(i: number): Promise<void> {
      if (i <= index) {
        throw new Error('next() called multiple times in the same middleware')
      }
      index = i

      const fn: Middleware | (() => Promise<void>) = i < middlewares.length ? middlewares[i]! : next

      await fn(ctx as any, () => dispatch(i + 1))
    }

    await dispatch(0)
  }
}

/**
 * Normalize a Grammy Context into a MiddlewareCtx for the plugin pipeline.
 *
 * Extracts text, attachment metadata, user info, and timestamps.
 * The raw Grammy context is preserved in `grammyCtx` for advanced use.
 */
export function normalizeGrammyCtx(grammyCtx: any): MiddlewareCtx {
  const msg = grammyCtx.message ?? grammyCtx.channelPost ?? {}
  const from = grammyCtx.from ?? {}

  // Resolve inbound text
  let text = ''
  if (msg.text) {
    text = msg.text
  } else if (msg.caption) {
    text = msg.caption
  } else if (msg.voice || msg.audio) {
    text = (grammyCtx._stt as { text: string } | undefined)?.text ?? '(voice)'
  } else if (msg.photo) {
    text = msg.caption ?? '(photo)'
  } else if (msg.document) {
    text = msg.caption ?? `(document: ${msg.document.file_name ?? 'file'})`
  } else if (msg.video) {
    text = msg.caption ?? '(video)'
  } else if (msg.video_note) {
    text = '(video note)'
  } else if (msg.sticker) {
    text = `(sticker${msg.sticker.emoji ? ` ${msg.sticker.emoji}` : ''})`
  }

  // Resolve attachment
  let attachment: TgAttachment | undefined
  if (msg.voice) {
    attachment = { kind: 'voice', file_id: msg.voice.file_id }
  } else if (msg.photo) {
    const best = msg.photo[msg.photo.length - 1]
    attachment = { kind: 'photo', file_id: best?.file_id ?? '' }
  } else if (msg.document) {
    attachment = { kind: 'document', file_id: msg.document.file_id }
  } else if (msg.audio) {
    attachment = { kind: 'audio', file_id: msg.audio.file_id }
  } else if (msg.video) {
    attachment = { kind: 'video', file_id: msg.video.file_id }
  } else if (msg.sticker) {
    attachment = { kind: 'sticker', file_id: msg.sticker.file_id }
  }

  return {
    text,
    textOut: '',
    chat_id: String(grammyCtx.chat?.id ?? ''),
    user: from.username ?? String(from.id ?? ''),
    user_id: String(from.id ?? ''),
    message_id: String(msg.message_id ?? ''),
    ts: new Date((msg.date ?? 0) * 1000).toISOString(),
    attachment,
    state: {},
    grammyCtx,
  }
}
