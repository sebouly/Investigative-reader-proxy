// ─────────────────────────────────────────────────────────────────────────
//  DISABLED scaffolding for premium server-side Text-to-Speech.
//
//  Companion to app/src/main/java/com/investigativereader/service/
//  OpenAiTtsService.kt — both are kept in the repo so the integration is
//  one flag flip away when we launch the Premium tier.
//
//  Activation checklist:
//   1. Flip ENABLED to true.
//   2. Add OPENAI_API_KEY to Vercel env vars (Production + Preview).
//   3. Optionally narrow CORS / add request-signing if abuse becomes an issue.
//   4. Add a new "tts_premium_per_day" column to public.usage_caps and the
//      matching counter in public.daily_usage; extend
//      check_and_increment_usage to accept 'tts' as the action.
//   5. (Optional) Add a Supabase Storage bucket "tts_cache" so identical
//      (text, voice) requests can serve a pre-rendered MP3 instead of paying
//      OpenAI again.
//
//  Pricing reminder (OpenAI TTS-1 standard):
//   - $15 per 1M input characters.
//   - 2-min article ≈ 1500 chars → ~$0.023 / article.
//   - 5-min digest ≈ 3750 chars → ~$0.056 / digest.
//   - At 1500 DAU with 5% Premium → ~$120 / month TTS spend.
// ─────────────────────────────────────────────────────────────────────────

const ENABLED = false

export default async function handler(req, res) {
  if (!ENABLED) {
    return res.status(503).json({
      error: 'tts_disabled',
      message: 'Premium TTS not enabled yet — see api/tts.js for activation steps.',
    })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { text, voice = 'onyx', deviceFingerprint, speed = 1.0 } = req.body || {}

  if (!text || !deviceFingerprint) {
    return res.status(400).json({ error: 'Missing text or deviceFingerprint' })
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' })
  }

  try {
    // TODO when activating:
    //  1. Call check_and_increment_usage(deviceFingerprint, 'tts') against
    //     a NEW tts_premium_per_day cap. Reject 429 if over.
    //  2. (Optional) Look up Supabase Storage for a pre-rendered MP3 keyed
    //     by sha1(text + voice + speed). Return it directly if found.
    //  3. Otherwise POST to OpenAI:
    //
    //       POST https://api.openai.com/v1/audio/speech
    //       Authorization: Bearer ${OPENAI_API_KEY}
    //       Content-Type: application/json
    //       { model: 'tts-1', input: text, voice, response_format: 'mp3', speed }
    //
    //     and stream the audio/mpeg response body back to the client with
    //     the same Content-Type so the Android MediaPlayer can play it
    //     directly from the HTTP response.
    //  4. After streaming, asynchronously write the MP3 to Supabase Storage
    //     so the next request hits the cache.

    return res.status(501).json({ error: 'Not implemented yet' })
  } catch (error) {
    console.error('TTS handler error:', error)
    return res.status(500).json({ error: 'Server error', details: error.message })
  }
}
