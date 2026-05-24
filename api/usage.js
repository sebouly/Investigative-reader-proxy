import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

/**
 * GET-style endpoint to read today's usage + caps for the current device.
 * Used by the app's ProfileScreen "Usage today" card. POST is accepted so
 * the deviceFingerprint can travel in the body rather than the URL.
 *
 * Response shape (mirrors the Postgres get_daily_usage function):
 *   { summaries:    { used, cap },
 *     translations: { used, cap },
 *     digests:      { used, cap } }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { deviceFingerprint } = req.body

  if (!deviceFingerprint) {
    return res.status(400).json({ error: 'Missing deviceFingerprint' })
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured on server' })
  }

  try {
    const { data, error } = await supabase.rpc('get_daily_usage', {
      p_device_fingerprint: deviceFingerprint,
    })

    if (error) {
      console.error('get_daily_usage RPC error:', error.message)
      return res.status(502).json({ error: 'Supabase RPC failed', details: error.message })
    }

    return res.status(200).json(data ?? {})
  } catch (error) {
    console.error('usage handler error:', error)
    return res.status(500).json({ error: 'Server error', details: error.message })
  }
}
