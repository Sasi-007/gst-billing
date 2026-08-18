import { NextResponse } from 'next/server'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'])
const MAX_BYTES = 5 * 1024 * 1024  // 5 MB

const EXTRACT_PROMPT = `You are an expert at reading Indian supplier/vendor purchase invoices.

Analyse the invoice image carefully and extract ALL data. Return ONLY valid JSON — no markdown fence, no explanation text.

Required JSON schema:
{
  "supplier_name": "string or null",
  "supplier_gstin": "string or null",
  "invoice_number": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "items": [
    {
      "name": "exact product name from invoice",
      "hsn_code": "string or null",
      "quantity": <positive number>,
      "unit": "kg | g | L | mL | pcs | box | pack | dozen | bottle | strip",
      "rate": <price per unit as a positive number, GST-inclusive>,
      "gst_rate": <one of: 0, 3, 5, 12, 18, 28>,
      "amount": <total line amount as positive number>
    }
  ],
  "subtotal": <number or null>,
  "gst_amount": <number or null>,
  "total_amount": <number or null>
}

Rules:
- Extract EVERY line item — do not skip any.
- If GST rate is not visible for an item, default to 0.
- quantity and rate must be positive numbers; amount = rate × quantity.
- If a field is unclear or absent, use null.
- Return empty array [] for items if no line items are found.
- Do NOT include any text outside the JSON object.`

export async function POST(request) {
  // ── Config check ────────────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI scanning is not configured. Add OPENAI_API_KEY to your .env.local file.' },
      { status: 503 }
    )
  }

  // ── Parse multipart form ─────────────────────────────────────
  let formData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid request — expected multipart/form-data.' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'No file provided in the request.' }, { status: 400 })
  }

  // ── Validate file type ───────────────────────────────────────
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: 'Unsupported file type. Please upload a JPG, PNG, or WEBP image.' },
      { status: 400 }
    )
  }

  // ── Validate file size ───────────────────────────────────────
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed is 5 MB.` },
      { status: 400 }
    )
  }

  // ── Convert to base64 ────────────────────────────────────────
  let base64
  try {
    const bytes = await file.arrayBuffer()
    base64 = Buffer.from(bytes).toString('base64')
  } catch {
    return NextResponse.json({ error: 'Failed to read image data.' }, { status: 500 })
  }

  // ── Call OpenAI Vision ───────────────────────────────────────
  let aiResponse
  try {
    aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: EXTRACT_PROMPT },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${file.type};base64,${base64}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
        max_tokens: 3000,
        temperature: 0,         // deterministic output
        response_format: { type: 'text' },
      }),
      signal: AbortSignal.timeout(45_000),  // 45-second timeout
    })
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return NextResponse.json(
        { error: 'AI request timed out. Try a smaller / clearer image.' },
        { status: 504 }
      )
    }
    return NextResponse.json({ error: 'Network error contacting AI service.' }, { status: 502 })
  }

  // ── Handle OpenAI HTTP errors ────────────────────────────────
  if (!aiResponse.ok) {
    let detail = ''
    try { detail = (await aiResponse.json()).error?.message || '' } catch { /* ignore */ }

    if (aiResponse.status === 401) {
      return NextResponse.json({ error: 'Invalid OpenAI API key. Check your OPENAI_API_KEY.' }, { status: 503 })
    }
    if (aiResponse.status === 429) {
      return NextResponse.json(
        { error: 'AI service is busy. Please wait a moment and try again.' },
        { status: 429 }
      )
    }
    return NextResponse.json(
      { error: `AI service error (${aiResponse.status}): ${detail || 'unknown error'}` },
      { status: 502 }
    )
  }

  // ── Extract content from response ────────────────────────────
  let content = ''
  try {
    const body = await aiResponse.json()
    content = body?.choices?.[0]?.message?.content ?? ''
  } catch {
    return NextResponse.json({ error: 'Could not read AI response.' }, { status: 500 })
  }

  if (!content.trim()) {
    return NextResponse.json({ error: 'AI returned an empty response.' }, { status: 500 })
  }

  // ── Parse JSON (handle possible markdown fencing) ────────────
  let parsed
  try {
    // Strip ```json ... ``` if present
    const cleaned = content
      .replace(/^```(?:json)?\s*/im, '')
      .replace(/```\s*$/m, '')
      .trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return NextResponse.json(
      { error: 'AI response was not valid JSON. Please try again or use a clearer image.' },
      { status: 500 }
    )
  }

  // ── Validate & sanitise structure ────────────────────────────
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Unexpected response shape from AI.' }, { status: 500 })
  }

  const VALID_GST = new Set([0, 3, 5, 12, 18, 28])

  parsed.items = Array.isArray(parsed.items)
    ? parsed.items
        .filter(item => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim())
        .map(item => ({
          name:     item.name.trim(),
          hsn_code: item.hsn_code ? String(item.hsn_code).trim() : '',
          quantity: Math.max(0.001, parseFloat(item.quantity) || 1),
          unit:     String(item.unit || 'pcs').trim().toLowerCase(),
          rate:     Math.max(0, parseFloat(item.rate)     || 0),
          gst_rate: VALID_GST.has(parseFloat(item.gst_rate)) ? parseFloat(item.gst_rate) : 0,
          amount:   Math.max(0, parseFloat(item.amount)   || 0),
        }))
    : []

  parsed.supplier_name    = parsed.supplier_name    ? String(parsed.supplier_name).trim()    : null
  parsed.supplier_gstin   = parsed.supplier_gstin   ? String(parsed.supplier_gstin).toUpperCase().trim() : null
  parsed.invoice_number   = parsed.invoice_number   ? String(parsed.invoice_number).trim()   : null
  parsed.invoice_date     = /^\d{4}-\d{2}-\d{2}$/.test(parsed.invoice_date) ? parsed.invoice_date : null
  parsed.total_amount     = parseFloat(parsed.total_amount) || null
  parsed.gst_amount       = parseFloat(parsed.gst_amount)   || null
  parsed.subtotal         = parseFloat(parsed.subtotal)      || null

  return NextResponse.json(parsed)
}
