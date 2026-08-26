import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
})

// ── Auth shortcuts ─────────────────────────────────────────
export const signIn  = (email, pw) => supabase.auth.signInWithPassword({ email, password: pw })
export const signUp  = (email, pw) => supabase.auth.signUp({ email, password: pw })
export const signOut = ()          => supabase.auth.signOut()
export const getUser = async ()    => { const { data: { user } } = await supabase.auth.getUser(); return user }
