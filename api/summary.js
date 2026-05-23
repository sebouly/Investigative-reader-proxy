import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// OpenRouter model — change here to swap providers without touching the app.
// Examples:
//   'google/gemini-2.0-flash-001'   (cheap + fast, recommended)
//   'mistralai/mistral-small'        (EU, great FR)
//   'anthropic/claude-3.5-haiku'     (previous default via OpenRouter)
//   'openai/gpt-4o-mini'             (OpenAI option)
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { cacheKey, prompt } = req.body

  if (!cacheKey || !prompt) {
    return res.status(400).json({ error: 'Missing cacheKey or prompt' })
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured on server' })
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured on server' })
  }

  try {
    // 1. Check Supabase cache first — free and instant
    const { data: cached, error: cacheError } = await supabase
      .from('summaries')
      .select('summary')
      .eq('cache_key', cacheKey)
      .maybeSingle()

    if (cached?.summary) {
      return res.status(200).json({ summary: cached.summary, cached: true })
    }

    if (cacheError) {
      console.error('Supabase cache read error:', cacheError.message)
    }

    // 2. Cache miss — call OpenRouter (OpenAI-compatible API)
    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // Optional but recommended by OpenRouter for analytics / ranking
        'HTTP-Referer': 'https://openlensai.app',
        'X-Title': 'OpenLens AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!orRes.ok) {
      const errBody = await orRes.json().catch(() => ({}))
      return res.status(502).json({
        error: `OpenRouter API returned ${orRes.status}`,
        details: errBody,
      })
    }

    const data = await orRes.json()
    const summary = data.choices?.[0]?.message?.content

    if (!summary) {
      return res.status(502).json({ error: 'Empty response from OpenRouter', details: data })
    }

    // 3. Store in Supabase so all future users get it for free (best-effort)
    const { error: insertError } = await supabase
      .from('summaries')
      .insert({ cache_key: cacheKey, summary })

    if (insertError) {
      console.error('Supabase cache write error:', insertError.message)
    }

    return res.status(200).json({ summary, cached: false })

  } catch (error) {
    console.error('Summary handler error:', error)
    return res.status(500).json({ error: 'Server error', details: error.message })
  }
}
