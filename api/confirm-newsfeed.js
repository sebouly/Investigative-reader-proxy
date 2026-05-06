export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { email, firstName, newsfeedName, frequency, language } = req.body

  if (!email) {
    return res.status(400).json({ error: 'Missing email' })
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY not configured on server' })
  }

  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'
  const displayName = newsfeedName || 'My Newsfeed'
  const displayFreq = frequency || 'your chosen frequency'
  const displayLang = language || 'English'

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
      <div style="background-color: #003D4F; padding: 28px 32px; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 22px;">OpenLens AI</h1>
        <p style="color: #B3E5FC; margin: 4px 0 0; font-size: 13px; font-style: italic;">Your newsfeed is confirmed</p>
      </div>
      <div style="background-color: #f8f9fa; padding: 32px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px;">${greeting}</p>
        <p style="font-size: 15px; line-height: 1.6;">
          Your newsfeed <strong>"${displayName}"</strong> has been successfully set up. 🎉
        </p>
        <div style="background: white; border-left: 4px solid #003D4F; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
          <p style="margin: 0 0 8px; font-size: 13px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Your settings</p>
          <p style="margin: 4px 0; font-size: 14px;"><strong>Frequency:</strong> ${displayFreq}</p>
          <p style="margin: 4px 0; font-size: 14px;"><strong>Language:</strong> ${displayLang}</p>
        </div>
        <p style="font-size: 15px; line-height: 1.6;">
          No bias, no bullsh..., straight to the point, for all. Six elite investigative newsrooms,
          instant summaries — eyes free, mind sharp.
        </p>
        <p style="font-size: 13px; color: #888; margin-top: 32px; border-top: 1px solid #e0e0e0; padding-top: 16px;">
          You're receiving this because you signed up on OpenLens AI.
        </p>
      </div>
    </div>
  `

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'OpenLens AI <onboarding@resend.dev>',
        to: email,
        subject: `Your newsfeed "${displayName}" is confirmed — OpenLens AI`,
        html,
      }),
    })

    const data = await response.json()
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to send email', details: data })
    }
    return res.status(200).json({ success: true })

  } catch (error) {
    return res.status(500).json({ error: 'Server error', details: error.message })
  }
}
