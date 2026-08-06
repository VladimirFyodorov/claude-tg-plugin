import { writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import type { Context, NextFunction } from 'grammy'

export function makeSttMiddleware(config: { token: string; inboxDir: string; apiKey: string; language?: string }) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (!ctx.message?.voice) {
      await next()
      return
    }

    if (!config.apiKey) {
      process.stderr.write('stt: apiKey not set — skipping transcription\n')
      await next()
      return
    }

    const voice = ctx.message.voice
    const uniqueId = randomBytes(6).toString('hex')
    const base = `${Date.now()}-${uniqueId}`
    const ogaPath = join(config.inboxDir, `${base}.oga`)
    const mp3Path = join(config.inboxDir, `${base}.mp3`)

    try {
      // Download OGA
      const file = await ctx.api.getFile(voice.file_id)
      const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      mkdirSync(config.inboxDir, { recursive: true })
      writeFileSync(ogaPath, buf)

      // Convert OGA → MP3
      const proc = Bun.spawnSync(['ffmpeg', '-i', ogaPath, mp3Path, '-y'])
      if (proc.exitCode !== 0) {
        throw new Error(`ffmpeg exited with code ${proc.exitCode}`)
      }

      // Transcribe via OpenAI Whisper
      const form = new FormData()
      form.append('file', Bun.file(mp3Path))
      form.append('model', 'whisper-1')
      form.append('language', config.language ?? 'ru')

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: form,
      })

      if (!whisperRes.ok) {
        throw new Error(`Whisper API error: ${whisperRes.status} ${await whisperRes.text()}`)
      }

      const data = (await whisperRes.json()) as { text: string }
      ;(ctx as any)._stt = { text: data.text }

      // Cleanup
      try { unlinkSync(ogaPath) } catch {}
      try { unlinkSync(mp3Path) } catch {}
    } catch (err) {
      process.stderr.write(`stt: transcription failed — ${err}\n`)
      // Keep temp files for debugging, fall through to next()
    }

    await next()
  }
}
