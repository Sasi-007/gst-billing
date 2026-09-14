import { supabase } from "@/lib/supabase";

export async function suggestGstRateForHsn(hsnCode) {
    const code = String(hsnCode || '').trim()
    if (!code || code.length < 4) return null

    const { data: exact } = await supabase
        .from('hsn_gst_reference')
        .select('hsn_code,description,gst_rate')
        .eq('hsn_code',code)
        .maybeSingle()
    if (exact) return exact

    for (const len of [8,6,4]){
        if (code.length < len) continue
        const prefix = code.slice(0, len)
        const { data: rows } = await supabase
            .from('hsn_gst_reference')
            .select('hsn_code,description,gst_rate')
            .like('hsn_code', `${prefix}%`)
            .limit(1)
        if (rows?.length) return rows[0]
    }

    return null
}

