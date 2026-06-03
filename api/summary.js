import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// OpenRouter model + automatic fallback chain.
// We send the whole list as the `models` array so OpenRouter routes to the
// FIRST model that has a live endpoint. If a model gets delisted (the dreaded
// "No endpoints found for <model>" 404), routing silently falls through to the
// next one instead of failing the whole request.
//
// Override the primary with the OPENROUTER_MODEL env var on Vercel; the
// fallbacks always stay appended after it.
// NOTE: the old default 'google/gemini-2.0-flash-001' was DELISTED from
// OpenRouter (caused the "No endpoints found" 404). All slugs below were
// verified live on the OpenRouter /models catalog. Re-verify before changing.
//   'google/gemini-2.5-flash'        (cheap + fast, current default)
//   'openai/gpt-4o-mini'             (OpenAI option)
//   'mistralai/mistral-small-2603'   (EU, great FR)
//   'anthropic/claude-3.5-haiku'     (Anthropic option)
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash'

// De-duplicated chain: primary first, then resilient fallbacks. OpenRouter
// routes to the first slug with a live endpoint, so a single delisting (like
// the gemini-2.0 one above) no longer takes down summaries.
const OPENROUTER_MODELS = [...new Set([
  OPENROUTER_MODEL,
  'google/gemini-2.5-flash',
  'openai/gpt-4o-mini',
  'mistralai/mistral-small-2603',
  'anthropic/claude-3.5-haiku',
])]

/**
 * Map a cacheKey prefix to the action type used by the rate-limit function.
 *   "v2:..."        → summary
 *   "translate:..." → translation
 *   "digest:..."    → digest
 *   everything else → summary (safe default — never bypasses the cap)
 */
function actionFromCacheKey(cacheKey) {
  if (!cacheKey) return 'summary'
  if (cacheKey.startsWith('translate:')) return 'translation'
  if (cacheKey.startsWith('digest:'))    return 'digest'
  return 'summary'
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { cacheKey, prompt, deviceFingerprint } = req.body
  // Opt-in streaming: new clients send stream:true to receive the summary as
  // Server-Sent Events (token-by-token). Old clients omit it and keep getting
  // the single JSON response — fully backwards compatible.
  const wantStream = req.body.stream === true

  // Emit one SSE data frame to the client.
  const sseSend = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const beginSse = () => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // disable proxy buffering
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
  }

  if (!cacheKey || !prompt) {
    return res.status(400).json({ error: 'Missing cacheKey or prompt' })
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured on server' })
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured on server' })
  }

  const action = actionFromCacheKey(cacheKey)

  // `usageIncremented` tracks whether step 2 counted this request, so we can
  // REFUND it on any failure path (incl. the catch below) — a failed
  // generation must never burn the user's daily quota. Declared at function
  // scope so the catch block can reach refundUsage().
  let usageIncremented = false
  const refundUsage = async () => {
    if (!usageIncremented) return
    const { error } = await supabase.rpc('decrement_usage', {
      p_device_fingerprint: deviceFingerprint,
      p_action: action,
    })
    if (error) console.error('decrement_usage refund error:', error.message)
  }

  try {
    // ──────────────────────────────────────────────────────────────────
    // 0. Server-side rate limit. We always serve the Supabase cache (free,
    //    no LLM call) BEFORE the cap check so cached hits don't count
    //    against the user's daily quota. Cap is only enforced on a real
    //    LLM call.
    //
    //    Older clients that don't yet send deviceFingerprint bypass the
    //    cap — that's intentional during the rollout window. Tighten by
    //    making deviceFingerprint required once the next APK is live.
    // ──────────────────────────────────────────────────────────────────

    // 1. Check Supabase cache first — free and instant
    const { data: cached, error: cacheError } = await supabase
      .from('summaries')
      .select('summary')
      .eq('cache_key', cacheKey)
      .maybeSingle()

    if (cached?.summary) {
      if (wantStream) {
        // Cache hit in stream mode: emit the whole text as one frame + done.
        beginSse()
        sseSend({ delta: cached.summary })
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      return res.status(200).json({ summary: cached.summary, cached: true })
    }

    if (cacheError) {
      console.error('Supabase cache read error:', cacheError.message)
    }

    // 2. Enforce the daily cap before paying for an LLM call.
    if (deviceFingerprint) {
      const { data: capCheck, error: capError } = await supabase.rpc(
        'check_and_increment_usage',
        { p_device_fingerprint: deviceFingerprint, p_action: action }
      )

      if (capError) {
        // Don't block users on a transient Supabase RPC error — log and proceed.
        // We did NOT reliably increment, so nothing to refund later.
        console.error('check_and_increment_usage RPC error:', capError.message)
      } else if (capCheck && capCheck.allowed === false) {
        return res.status(429).json({
          error:  'cap_exceeded',
          action: capCheck.action,
          used:   capCheck.used,
          cap:    capCheck.cap,
        })
      } else {
        usageIncremented = true
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 3a. STREAMING path (opt-in). Forward OpenRouter tokens to the client
    //     as SSE so the summary appears progressively instead of after the
    //     full generation. We still accumulate the whole text to write the
    //     Supabase cache at the end.
    // ──────────────────────────────────────────────────────────────────
    if (wantStream) {
      const orStream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://openlensai.app',
          'X-Title': 'OpenLens AI',
        },
        body: JSON.stringify({
          model: OPENROUTER_MODELS[0],
          models: OPENROUTER_MODELS.slice(0, 3),
          max_tokens: 1024,
          stream: true,
          messages: [{ role: 'user', content: prompt }],
        }),
      })

      // Upstream failed before any tokens — still safe to return a JSON error
      // (SSE headers not sent yet) and refund the quota.
      if (!orStream.ok || !orStream.body) {
        const errBody = await orStream.json().catch(() => ({}))
        console.error(
          `OpenRouter stream ${orStream.status} for models [${OPENROUTER_MODELS.join(', ')}]:`,
          JSON.stringify(errBody),
        )
        await refundUsage()
        return res.status(502).json({
          error: 'summary_unavailable',
          message: 'The summary service is temporarily unavailable. Please try again in a moment.',
        })
      }

      beginSse()
      let full = ''
      const decoder = new TextDecoder()
      let buf = ''
      try {
        for await (const chunk of orStream.body) {
          buf += decoder.decode(chunk, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() // keep the (possibly partial) last line for next chunk
          for (const line of lines) {
            const t = line.trim()
            if (!t || t.startsWith(':')) continue            // keepalive / comment
            if (!t.startsWith('data:')) continue
            const payload = t.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const delta = JSON.parse(payload).choices?.[0]?.delta?.content
              if (delta) { full += delta; sseSend({ delta }) }
            } catch { /* ignore unparseable keepalive frames */ }
          }
        }
      } catch (streamErr) {
        console.error('OpenRouter stream read error:', streamErr)
      }

      if (!full) {
        // Nothing was generated — refund and signal a clean error to the client.
        await refundUsage()
        sseSend({ error: 'summary_unavailable' })
        res.write('data: [DONE]\n\n')
        return res.end()
      }

      // Persist the full summary so future requests hit the cache (best-effort).
      const { error: insertError } = await supabase
        .from('summaries')
        .insert({ cache_key: cacheKey, summary: full })
      if (insertError) console.error('Supabase cache write error:', insertError.message)

      res.write('data: [DONE]\n\n')
      return res.end()
    }

    // 3. Cache miss — call OpenRouter (OpenAI-compatible API)
    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://openlensai.app',
        'X-Title': 'OpenLens AI',
      },
      body: JSON.stringify({
        // `model` (required) = primary; `models` (optional) = ordered fallback
        // chain. OpenRouter tries `model` first, then each entry in `models`,
        // so a single delisted model no longer breaks every summary. Every
        // slug here must be a VALID OpenRouter model id — an unknown id in the
        // list makes the whole request 400.
        model: OPENROUTER_MODELS[0],
        // OpenRouter caps the fallback `models` array at 3 items (sending more
        // returns 400). Send the primary + up to 2 fallbacks.
        models: OPENROUTER_MODELS.slice(0, 3),
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!orRes.ok) {
      const errBody = await orRes.json().catch(() => ({}))
      // Log the full upstream error server-side for debugging, but never leak
      // raw provider JSON to the client — the app would render it inside the
      // summary card. Return a clean, user-safe message instead.
      console.error(
        `OpenRouter ${orRes.status} for models [${OPENROUTER_MODELS.join(', ')}]:`,
        JSON.stringify(errBody),
      )
      await refundUsage()
      return res.status(502).json({
        error: 'summary_unavailable',
        message: 'The summary service is temporarily unavailable. Please try again in a moment.',
      })
    }

    const data = await orRes.json()
    const summary = data.choices?.[0]?.message?.content

    if (!summary) {
      console.error('Empty response from OpenRouter:', JSON.stringify(data))
      await refundUsage()
      return res.status(502).json({
        error: 'summary_unavailable',
        message: 'The summary service is temporarily unavailable. Please try again in a moment.',
      })
    }

    // 4. Store in Supabase so all future users get it for free (best-effort)
    const { error: insertError } = await supabase
      .from('summaries')
      .insert({ cache_key: cacheKey, summary })

    if (insertError) {
      console.error('Supabase cache write error:', insertError.message)
    }

    return res.status(200).json({ summary, cached: false })

  } catch (error) {
    console.error('Summary handler error:', error)
    await refundUsage()
    // If we already started streaming (SSE headers sent), we can't send a JSON
    // status — close the stream cleanly instead.
    if (res.headersSent) {
      try { res.write('data: [DONE]\n\n') } catch {}
      return res.end()
    }
    return res.status(500).json({ error: 'Server error', details: error.message })
  }
}
