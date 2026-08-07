/**
 * MCP tool definitions and handlers for the Telegram channel.
 *
 * Exports: registerTools(mcp, opts) — registers all 5 tools on the server.
 *
 * Tools: reply, react, download_attachment, edit_message, set_mode.
 *
 * INVARIANT: no console.log — stdout is JSON-RPC (MCP transport).
 */

import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Bot, InlineKeyboard, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { statSync, writeFileSync, mkdirSync } from 'fs'
import { join, extname } from 'path'
import { homedir } from 'os'
import { chunk, DEFAULT_CHUNK_LIMIT, DEFAULT_CHUNK_MODE } from '../http.ts'
import type { McpChannelHooks } from './server.ts'

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const DEFAULT_INBOX = join(homedir(), '.claude', 'channels', 'telegram', 'inbox')

export interface ToolsOpts {
  bot: Bot
  botToken: string
  inboxDir?: string
  hooks: McpChannelHooks
  pluginState: { mode: 'active' | 'silent' }
}

export function registerTools(mcp: Server, opts: ToolsOpts): void {
  const { bot, botToken, pluginState } = opts
  const inboxDir = opts.inboxDir ?? DEFAULT_INBOX
  const hooks = opts.hooks

  const assertChat = hooks.assertAllowedChat ?? (() => {})
  const assertSendable = hooks.assertSendable ?? (() => {})
  const getChunks = hooks.getChunkSettings ?? (() => ({
    limit: DEFAULT_CHUNK_LIMIT,
    mode: DEFAULT_CHUNK_MODE as 'length' | 'newline',
    replyToMode: 'first' as const,
  }))

  // ── Tool definitions ────────────────────────────────────────────────────────

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string' },
            text: { type: 'string' },
            reply_to: { type: 'string', description: 'Message ID to thread under.' },
            files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach. Max 50MB each.' },
            format: { type: 'string', enum: ['text', 'markdownv2'], description: "Rendering mode. Default: 'text'." },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'react',
        description: 'Add an emoji reaction to a Telegram message.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            emoji: { type: 'string' },
          },
          required: ['chat_id', 'message_id', 'emoji'],
        },
      },
      {
        name: 'download_attachment',
        description: 'Download a file attachment from Telegram. Returns local path. Telegram caps at 20MB.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
          },
          required: ['file_id'],
        },
      },
      {
        name: 'edit_message',
        description: "Edit a previously sent bot message. Edits don't trigger push notifications.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            text: { type: 'string' },
            format: { type: 'string', enum: ['text', 'markdownv2'], description: "Rendering mode. Default: 'text'." },
          },
          required: ['chat_id', 'message_id', 'text'],
        },
      },
      {
        name: 'set_mode',
        description: 'Set notification mode. "silent" = only CRITICAL makes sound; "active" = normal.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            mode: { type: 'string', enum: ['silent', 'active'] },
          },
          required: ['mode'],
        },
      },
    ],
  }))

  // ── Tool handlers ───────────────────────────────────────────────────────────

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    try {
      switch (req.params.name) {
        case 'reply': {
          const chat_id = args.chat_id as string
          const text = args.text as string
          const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
          const files = (args.files as string[] | undefined) ?? []
          const format = (args.format as string | undefined) ?? 'text'
          const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined

          assertChat(chat_id)
          for (const f of files) {
            assertSendable(f)
            const st = statSync(f)
            if (st.size > MAX_ATTACHMENT_BYTES) {
              throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
            }
          }

          const { limit, mode, replyToMode } = getChunks()
          const chunks = chunk(text, limit, mode)
          const sentIds: number[] = []

          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo = reply_to != null && replyToMode !== 'off' && (replyToMode === 'all' || i === 0)
            const sent = await bot.api.sendMessage(chat_id, chunks[i], {
              ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
              ...(parseMode ? { parse_mode: parseMode } : {}),
            })
            sentIds.push(sent.message_id)
          }

          for (const f of files) {
            const ext = extname(f).toLowerCase()
            const input = new InputFile(f)
            const replyOpts = reply_to != null && replyToMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : undefined
            if (PHOTO_EXTS.has(ext)) {
              const sent = await bot.api.sendPhoto(chat_id, input, replyOpts)
              sentIds.push(sent.message_id)
            } else {
              const sent = await bot.api.sendDocument(chat_id, input, replyOpts)
              sentIds.push(sent.message_id)
            }
          }

          const result = sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
          return { content: [{ type: 'text', text: result }] }
        }

        case 'react': {
          assertChat(args.chat_id as string)
          await bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
            { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
          ])
          return { content: [{ type: 'text', text: 'reacted' }] }
        }

        case 'download_attachment': {
          const file_id = args.file_id as string
          const file = await bot.api.getFile(file_id)
          if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
          const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
          const res = await fetch(url)
          if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
          const buf = Buffer.from(await res.arrayBuffer())
          const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
          const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
          const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
          const path = join(inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
          mkdirSync(inboxDir, { recursive: true })
          writeFileSync(path, buf)
          return { content: [{ type: 'text', text: path }] }
        }

        case 'edit_message': {
          assertChat(args.chat_id as string)
          const editFormat = (args.format as string | undefined) ?? 'text'
          const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
          const edited = await bot.api.editMessageText(
            args.chat_id as string,
            Number(args.message_id),
            args.text as string,
            ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
          )
          const id = typeof edited === 'object' ? edited.message_id : args.message_id
          return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
        }

        case 'set_mode': {
          const mode = args.mode as 'silent' | 'active'
          if (mode !== 'silent' && mode !== 'active') {
            return { content: [{ type: 'text', text: `invalid mode "${mode}"` }], isError: true }
          }
          pluginState.mode = mode
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, mode }) }] }
        }

        default:
          return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
    }
  })
}
