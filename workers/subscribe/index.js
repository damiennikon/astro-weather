export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const body = await request.json()
      const { subscription, lat, lng, locationName } = body

      if (!subscription?.endpoint || lat == null || lng == null) {
        return new Response(JSON.stringify({ error: 'Missing required fields' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const keyBuffer = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(subscription.endpoint)
      )
      const keyHex = Array.from(new Uint8Array(keyBuffer))
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
      const kvKey = `sub:${keyHex}`

      const value = JSON.stringify({
        subscription,
        lat,
        lng,
        locationName: locationName ?? 'Unknown',
        lastNotified: null,
        subscribedAt: new Date().toISOString()
      })

      await env.ASTRO_SUBSCRIPTIONS.put(kvKey, value, { expirationTtl: 60 * 60 * 24 * 365 })

      return new Response(JSON.stringify({ ok: true, key: kvKey }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (request.method === 'DELETE' && url.pathname === '/unsubscribe') {
      const body = await request.json()
      const { endpoint } = body
      if (!endpoint) {
        return new Response(JSON.stringify({ error: 'Missing endpoint' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      const keyBuffer = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(endpoint)
      )
      const keyHex = Array.from(new Uint8Array(keyBuffer))
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
      await env.ASTRO_SUBSCRIPTIONS.delete(`sub:${keyHex}`)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response('Not Found', { status: 404 })
  }
}
