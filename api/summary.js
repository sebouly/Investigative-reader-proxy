import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { cacheKey, prompt } = req.body

  if (!cacheKey || !prompt) {
    return res.status(400).json({ error: 'Missing cacheKey or prompt' })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' })
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

    // Log cache miss reason (table missing, etc.) but continue to Claude
    if (cacheError) {
      console.error('Supabase cache read error:', cacheError.message)
    }

    // 2. Cache miss — call Claude API
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!claudeRes.ok) {
      const errBody = await claudeRes.json().catch(() => ({}))
      return res.status(502).json({
        error: `Claude API returned ${claudeRes.status}`,
        details: errBody,
      })
    }

    const data = await claudeRes.json()
    const summary = data.content?.[0]?.text

    if (!summary) {
      return res.status(502).json({ error: 'Empty response from Claude', details: data })
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
