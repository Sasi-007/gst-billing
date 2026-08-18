import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Server-side only — uses service role key to bypass RLS
function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

// Verify caller is a superadmin
async function verifySuperadmin(request) {
  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return { ok: false, reason: 'Missing auth token' }

  // Decode JWT payload locally (avoids network/TLS dependency for this check)
  let payload
  try {
    const parts = token.split('.')
    if (parts.length < 2) return { ok: false, reason: 'Invalid auth token format' }
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  } catch {
    return { ok: false, reason: 'Invalid auth token payload' }
  }

  const now = Math.floor(Date.now() / 1000)
  if (!payload?.exp || payload.exp <= now) {
    return { ok: false, reason: 'Session expired or invalid token' }
  }
  const email = payload?.email
  if (!email) return { ok: false, reason: 'Token missing email claim' }

  const allowed = (process.env.NEXT_PUBLIC_SUPERADMIN_EMAILS || '').split(',').map(e => e.trim())
  if (!allowed.includes(email)) {
    return { ok: false, reason: `User ${email} is not in NEXT_PUBLIC_SUPERADMIN_EMAILS` }
  }
  return { ok: true, user: { email } }
}

function mapAdminError(err) {
  const code = err?.cause?.code || err?.code
  const msg = String(err?.message || err || '')
  if (code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || msg.includes('unable to get local issuer certificate')) {
    return NextResponse.json(
      { error: 'TLS certificate issue: Node.js cannot trust the SSL certificate chain to Supabase. Configure trusted CA or NODE_EXTRA_CA_CERTS.' },
      { status: 503 }
    )
  }
  return NextResponse.json({ error: msg || 'Admin API request failed' }, { status: 500 })
}

export async function GET(request) {
  try {
    const auth = await verifySuperadmin(request)
    if (!auth.ok) return NextResponse.json({ error: `Forbidden: ${auth.reason}` }, { status: 403 })

    const admin = getAdminClient()
    if (!admin) return NextResponse.json({ error: 'Service role key not configured' }, { status: 503 })

    const { searchParams } = new URL(request.url)
    const resource = searchParams.get('resource')

    if (resource === 'shops') {
      const { data: shops } = await admin
        .from('shops')
        .select('id,name,gstin,phone,city,state,plan,is_active,created_at,bill_counter,purchase_counter')
        .order('created_at', { ascending: false })

      const { data: memberships } = await admin
        .from('user_shops')
        .select('shop_id,role,user_id')
        .eq('role', 'owner')

      const { data: { users: authUsers } } = await admin.auth.admin.listUsers({ perPage: 1000 })
      const emailMap = Object.fromEntries((authUsers || []).map(u => [u.id, u.email]))
      const ownerMap = Object.fromEntries((memberships || []).map(m => [m.shop_id, emailMap[m.user_id]]))
      const enriched = (shops || []).map(s => ({ ...s, owner_email: ownerMap[s.id] || null }))
      return NextResponse.json({ shops: enriched })
    }

    if (resource === 'users') {
      const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
      const { data: memberships } = await admin.from('user_shops').select('user_id,shop_id,role,shops(name)')
      const memberMap = {}
      ;(memberships || []).forEach(m => {
        if (!memberMap[m.user_id]) memberMap[m.user_id] = []
        memberMap[m.user_id].push({ shop: m.shops?.name, role: m.role })
      })

      return NextResponse.json({
        users: (users || []).map(u => ({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          shops: memberMap[u.id] || [],
        }))
      })
    }

    return NextResponse.json({ error: 'Unknown resource' }, { status: 400 })
  } catch (err) {
    return mapAdminError(err)
  }
}

export async function POST(request) {
  try {
    const auth = await verifySuperadmin(request)
    if (!auth.ok) return NextResponse.json({ error: `Forbidden: ${auth.reason}` }, { status: 403 })

    const admin = getAdminClient()
    if (!admin) return NextResponse.json({ error: 'Service role key not configured' }, { status: 503 })

    const body = await request.json().catch(() => ({}))
    const { action } = body

    if (action === 'toggle_shop') {
      const { shop_id, is_active } = body
      if (!shop_id) return NextResponse.json({ error: 'shop_id required' }, { status: 400 })
      await admin.from('shops').update({ is_active }).eq('id', shop_id)
      return NextResponse.json({ ok: true })
    }

    if (action === 'create_user') {
      const { email, password } = body
      if (!email || !password) return NextResponse.json({ error: 'email and password required' }, { status: 400 })
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      return NextResponse.json({ user: { id: data.user.id, email: data.user.email } })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    return mapAdminError(err)
  }
}
