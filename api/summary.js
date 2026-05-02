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

  try {
    // 1. Check Supabase cache first — free and instant
    const { data: cached } = await supabase
      .from('summaries')
      .select('summary')
      .eq('cache_key', cacheKey)
      .maybeSingle()

    if (cached?.summary) {
      return res.status(200).json({ summary: cached.summary, cached: true })
    }

    // 2. Cache miss — call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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

    const data = await response.json()
    const summary = data.content?.[0]?.text

    if (!summary) {
      return res.status(500).json({ error: 'No summary from Claude', details: data })
    }

    // 3. Store in Supabase so all future users get it for free
    await supabase.from('summaries').insert({ cache_key: cacheKey, summary })

    return res.status(200).json({ summary, cached: false })

  } catch (error) {
    return res.status(500).json({ error: 'Server error', details: error.message })
  }
}
