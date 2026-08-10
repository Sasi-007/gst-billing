'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'

export default function LoginPage() {
  const [mode,     setMode]     = useState('login')   // 'login' | 'signup'
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [message,  setMessage]  = useState('')
  const router = useRouter()

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)

    try {
      let result
      if (mode === 'login') {
        result = await supabase.auth.signInWithPassword({ email, password })
      } else {
        result = await supabase.auth.signUp({ email, password })
      }

      if (result.error) throw result.error

      if (mode === 'signup') {
        // Check if email confirmation is required
        const needsConfirm = !result.data.session
        if (needsConfirm) {
          setMessage('Check your email to confirm your account, then sign in.')
          setLoading(false)
          return
        }
      }

      // Check if user already has a shop
      const { data: membership } = await supabase
        .from('user_shops')
        .select('shop_id')
        .limit(1)

      if (!membership || membership.length === 0) {
        router.replace('/onboarding')
      } else {
        router.replace('/')
      }
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg border p-8 w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-6">
          <div className="text-5xl mb-2">🧾</div>
          <h1 className="text-2xl font-bold text-gray-900">GST Billing</h1>
          <p className="text-sm text-gray-500 mt-1">Grocery &amp; Retail Billing Software</p>
        </div>

        {/* Messages */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg">
            {message}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Min 6 characters"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700
                       disabled:opacity-50 transition-colors mt-1"
          >
            {loading
              ? 'Please wait…'
              : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {/* Toggle mode */}
        <div className="text-center mt-4 text-sm text-gray-600">
          {mode === 'login' ? (
            <>Don&apos;t have an account?{' '}
              <button onClick={() => { setMode('signup'); setError('') }}
                className="text-blue-600 hover:underline font-medium">
                Sign up free
              </button>
            </>
          ) : (
            <>Already have an account?{' '}
              <button onClick={() => { setMode('login'); setError('') }}
                className="text-blue-600 hover:underline font-medium">
                Sign in
              </button>
            </>
          )}
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">
          Multi-brand · Free for 1000+ bills/month
        </p>
      </div>
    </div>
  )
}
