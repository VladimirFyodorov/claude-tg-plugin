export interface LintResult {
  rule: string
  severity: 'ERROR' | 'WARN'
  message: string
  match?: string
}

import type { LintRule } from './types.ts'

/**
 * Built-in lint rules expressed as LintRule objects.
 * These wrap the lintOutbound function and are used by createPlugin.
 */
export const builtinRules: LintRule[] = [
  {
    id: 'builtin',
    severity: 'WARN' as const,
    check(method: string, payload: Record<string, unknown>): LintResult[] {
      return lintOutbound(method, payload)
    },
  },
]

/**
 * Create a lint checker function from a set of rules.
 * Called per-message inside Grammy's API middleware.
 */
export function createLintChecker(
  rules: LintRule[],
  mode: 'soft' | 'hard' = 'soft',
  onViolation?: (violations: LintResult[], method: string) => void,
): (method: string, payload: Record<string, unknown>) => void {
  return (method: string, payload: Record<string, unknown>): void => {
    const violations: LintResult[] = []
    for (const rule of rules) {
      violations.push(...rule.check(method, payload))
    }
    if (violations.length === 0) return
    if (onViolation) {
      onViolation(violations, method)
    } else {
      for (const v of violations) {
        process.stderr.write(`tg-plugin linter [${v.severity}] ${v.rule}: ${v.message}\n`)
      }
    }
    if (mode === 'hard') {
      const errors = violations.filter(v => v.severity === 'ERROR')
      if (errors.length > 0) {
        throw new Error(`Linter blocked outbound call "${method}": ${errors.map(e => e.rule).join(', ')}`)
      }
    }
  }
}

// Caption-bearing methods per Telegram Bot API
const CAPTION_METHODS = new Set([
  'sendPhoto',
  'sendVideo',
  'sendDocument',
  'sendAudio',
  'sendAnimation',
  'sendVoice',
  'sendVideoNote',
])

// Text-bearing methods
const TEXT_METHODS = new Set([
  'sendMessage',
  'editMessageText',
])

// Supported HTML tags in Telegram Bot API HTML mode
const UNSUPPORTED_TAG_PATTERN =
  /<(br|div|p|h[1-6]|span(?!\s+class="tg-spoiler"))[^>]*>/gi

// MDV2 special characters that must be escaped outside formatting
const MDV2_SPECIAL_CHARS = /(?<!\\)[_*[\]()~`>#+=|{}.!\-]/g

// HTML tags that are valid in HTML mode but invalid in MarkdownV2
const HTML_TAG_PATTERN = /<\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|a|tg-spoiler|tg-emoji|blockquote)\b[^>]*>/gi

export function lintOutbound(method: string, payload: any): LintResult[] {
  const results: LintResult[] = []

  // Determine text content to lint
  const isTextMethod = TEXT_METHODS.has(method)
  const isCaptionMethod = CAPTION_METHODS.has(method)

  const text: string | undefined = isTextMethod ? payload?.text : undefined
  const caption: string | undefined = isCaptionMethod ? payload?.caption : undefined
  const parseMode: string | undefined = payload?.parse_mode

  // Combined content for CMD and GEN checks
  const textContent = text ?? caption

  // --- CMD rules: apply to any text regardless of parse mode ---
  if (textContent != null) {
    // Strip fenced code blocks (``` ... ```) and inline code (`...`) before CMD checks
    // to avoid false positives on code examples with slash commands.
    const textForCmdChecks = textContent
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`\n]*`/g, '')

    // CMD-1 (ERROR): slash command with dashes
    // Pattern: /commandname-with-dashes — dashes are not allowed in Telegram commands
    // Require slash to be at start-of-string or after whitespace to avoid flagging
    // path segments like "task/dw-child-nudge-ack" or "Bun/Elysia".
    // Also skip tappable commands with double-underscore separator (/word__slug-with-dashes).
    const cmd1Pattern = /(?:^|\s)(\/[a-zA-Z][a-zA-Z0-9_]*-[a-zA-Z0-9_-]*)/gm
    let match: RegExpExecArray | null
    // eslint-disable-next-line no-cond-assign
    while ((match = cmd1Pattern.exec(textForCmdChecks)) !== null) {
      const slashCmd = match[1]
      // Skip tappable commands: /word__slug-with-dashes
      if (/^\/[a-zA-Z][a-zA-Z0-9_]*__/.test(slashCmd)) continue
      results.push({
        rule: 'CMD-1',
        severity: 'ERROR',
        message: `Slash command with dash not allowed by Telegram API: "${slashCmd}" — use underscores instead`,
        match: slashCmd,
      })
    }

    // CMD-2 (WARN): slash command with uppercase letter
    // Skip compound Word/Word patterns where both sides of / are alphanumeric (e.g. Bun/Elysia).
    const cmd2Pattern = /(?:^|\s)(\/[a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*)/gm
    while ((match = cmd2Pattern.exec(textForCmdChecks)) !== null) {
      const slashCmd = match[1]
      // Skip compound noun patterns: the char before / must not be alphanumeric
      // (already handled by the leading whitespace/start anchor in the pattern)
      results.push({
        rule: 'CMD-2',
        severity: 'WARN',
        message: `Slash command with uppercase not recommended: "${slashCmd}" — Telegram convention is lowercase`,
        match: slashCmd,
      })
    }

    // CMD-3 (WARN): slash command name > 31 chars (after the /)
    const cmd3Pattern = /\/([a-zA-Z0-9_-]+)/g
    while ((match = cmd3Pattern.exec(textContent)) !== null) {
      const name = match[1]
      if (name.length > 31) {
        results.push({
          rule: 'CMD-3',
          severity: 'WARN',
          message: `Slash command name too long (${name.length} chars, max 31): "/${name}"`,
          match: match[0],
        })
      }
    }
  }

  // --- HTML mode rules ---
  if (parseMode === 'HTML' && textContent != null) {
    // HTML-1 (WARN): bracket-bold [text] pattern — likely intended as bold
    const html1Pattern = /\[[^\]]+\]/g
    let match: RegExpExecArray | null
    while ((match = html1Pattern.exec(textContent)) !== null) {
      results.push({
        rule: 'HTML-1',
        severity: 'WARN',
        message: `Bracket-bold pattern "${match[0]}" in HTML mode — use <b>text</b> for bold formatting`,
        match: match[0],
      })
    }

    // HTML-2 (WARN): *text* markdown bold in HTML mode
    const html2Pattern = /\*[^*\n]+\*/g
    while ((match = html2Pattern.exec(textContent)) !== null) {
      results.push({
        rule: 'HTML-2',
        severity: 'WARN',
        message: `Markdown bold "${match[0]}" in HTML mode — use <b>text</b> instead`,
        match: match[0],
      })
    }

    // HTML-3 (WARN): _text_ markdown italic in HTML mode
    const html3Pattern = /_[^_\n]+_/g
    while ((match = html3Pattern.exec(textContent)) !== null) {
      results.push({
        rule: 'HTML-3',
        severity: 'WARN',
        message: `Markdown italic "${match[0]}" in HTML mode — use <i>text</i> instead`,
        match: match[0],
      })
    }

    // HTML-4 (ERROR): unescaped & in HTML mode
    // Allow: &amp; &lt; &gt; and numeric entities like &#123; or &#x1F;
    const html4Pattern = /&(?!(amp|lt|gt|#x?[0-9a-fA-F]+);)/g
    while ((match = html4Pattern.exec(textContent)) !== null) {
      results.push({
        rule: 'HTML-4',
        severity: 'ERROR',
        message: `Unescaped "&" in HTML mode — use &amp; instead`,
        match: '&',
      })
    }

    // HTML-5 (WARN): unsupported HTML tags
    // Reset lastIndex since we reuse the global regex
    UNSUPPORTED_TAG_PATTERN.lastIndex = 0
    while ((match = UNSUPPORTED_TAG_PATTERN.exec(textContent)) !== null) {
      results.push({
        rule: 'HTML-5',
        severity: 'WARN',
        message: `Unsupported HTML tag "${match[0]}" in HTML mode — will be stripped or cause parse error`,
        match: match[0],
      })
    }

    // HTML-6 (WARN): ||text|| MarkdownV2 spoiler syntax in HTML mode
    const html6Pattern = /\|\|[^|]+\|\|/g
    while ((match = html6Pattern.exec(textContent)) !== null) {
      results.push({
        rule: 'HTML-6',
        severity: 'WARN',
        message: `MarkdownV2 spoiler "${match[0]}" in HTML mode — use <tg-spoiler>text</tg-spoiler> instead`,
        match: match[0],
      })
    }
  }

  // --- MarkdownV2 mode rules ---
  if (parseMode === 'MarkdownV2' && textContent != null) {
    // MDV2-1 (ERROR): unescaped special chars
    // Skip characters that are preceded by a backslash
    const mdv2Special = /(?<!\\)[_*[\]()~`>#+=|{}.!\-]/g
    let match: RegExpExecArray | null
    const mdv2Hits: string[] = []
    while ((match = mdv2Special.exec(textContent)) !== null) {
      mdv2Hits.push(match[0])
    }
    if (mdv2Hits.length > 0) {
      results.push({
        rule: 'MDV2-1',
        severity: 'ERROR',
        message: `Unescaped MarkdownV2 special characters: ${mdv2Hits.map(c => `"${c}"`).join(', ')} — escape with backslash`,
        match: mdv2Hits[0],
      })
    }

    // MDV2-2 (WARN): HTML tags in MarkdownV2 mode
    HTML_TAG_PATTERN.lastIndex = 0
    while ((match = HTML_TAG_PATTERN.exec(textContent)) !== null) {
      results.push({
        rule: 'MDV2-2',
        severity: 'WARN',
        message: `HTML tag "${match[0]}" in MarkdownV2 mode — HTML tags do not work in MarkdownV2`,
        match: match[0],
      })
    }
  }

  // --- General rules ---

  // GEN-1 (ERROR): text > 4096 chars for text-bearing methods
  if (text != null && text.length > 4096) {
    results.push({
      rule: 'GEN-1',
      severity: 'ERROR',
      message: `Message text too long: ${text.length} characters (max 4096) — split into multiple messages`,
    })
  }

  // GEN-2 (ERROR): caption > 1024 chars for caption-bearing methods
  if (caption != null && caption.length > 1024) {
    results.push({
      rule: 'GEN-2',
      severity: 'ERROR',
      message: `Caption too long: ${caption.length} characters (max 1024) — shorten or move text to message`,
    })
  }

  return results
}

const ARTIFACT_FILENAME_PATTERN = /((?:phase-\d+-(?:report|audit)|plan(?:-audit)?|context(?:-audit)?|roles|fix-report|brief|grill-status)\.md)/g

function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

export function transformOutbound(text: string, slug: string, baseUrl: string, parseMode?: string): string {
  if (!slug || slug === 'unknown') return text
  const alreadyLinked = text.includes('href=') || text.includes('](http')
  ARTIFACT_FILENAME_PATTERN.lastIndex = 0
  return text.replace(ARTIFACT_FILENAME_PATTERN, (filename) => {
    if (alreadyLinked) return filename
    const url = `${baseUrl}/artifacts/${slug}/implementation/${slug}/${filename}`
    if (parseMode === 'HTML') return `<a href="${url}">${filename}</a>`
    if (parseMode === 'MarkdownV2') return `[${escapeMarkdownV2(filename)}](${url})`
    return `[${filename}](${url})`
  })
}
