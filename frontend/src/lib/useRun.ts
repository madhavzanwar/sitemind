import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { RunSnapshot } from '../types'

/** Polls GET /api/runs/{id} every `intervalMs` (default 1 s). */
export function useRun(runId: string | null, intervalMs = 1000) {
  const [snap, setSnap] = useState<RunSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    if (!runId) return
    try {
      const s = await api.getRun(runId)
      if (alive.current) {
        setSnap(s)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [runId])

  useEffect(() => {
    alive.current = true
    setSnap(null)
    if (!runId) return
    let timer: number | undefined
    const loop = async () => {
      await refresh()
      if (alive.current) timer = window.setTimeout(loop, intervalMs)
    }
    void loop()
    return () => {
      alive.current = false
      window.clearTimeout(timer)
    }
  }, [runId, intervalMs, refresh])

  return { snap, setSnap, error, refresh }
}
