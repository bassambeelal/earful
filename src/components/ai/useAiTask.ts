import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError } from '../../lib/ai'
import type { Progress } from '../../lib/ai/tools'

export type AiTaskStatus = 'idle' | 'running' | 'done' | 'error'

export interface AiTaskContext {
  signal: AbortSignal
  onToken: (delta: string) => void
  onProgress: (p: Progress) => void
}

export type AiTaskResult<T> =
  | { status: 'done'; value: T; text: string }
  | { status: 'stopped'; text: string }
  | { status: 'error'; error: unknown; text: string }
  /** Another run started (or the component unmounted) before this one finished. */
  | { status: 'superseded' }

interface State {
  status: AiTaskStatus
  text: string
  error: unknown
  progress: Progress | null
}

const IDLE: State = { status: 'idle', text: '', error: null, progress: null }

/**
 * One cancellable AI request with streamed text. Tokens are batched per animation
 * frame so long answers don't re-render on every delta. Aborts on unmount.
 */
export function useAiTask() {
  const [state, setState] = useState<State>(IDLE)
  const ctrlRef = useRef<AbortController | null>(null)
  const bufRef = useRef('')
  const frameRef = useRef(0)

  useEffect(
    () => () => {
      ctrlRef.current?.abort()
      ctrlRef.current = null
      cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  const run = useCallback(async <T>(fn: (ctx: AiTaskContext) => Promise<T>): Promise<AiTaskResult<T>> => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    bufRef.current = ''
    setState({ status: 'running', text: '', error: null, progress: null })
    const mine = () => ctrlRef.current === ctrl

    const flush = () => {
      frameRef.current = 0
      if (mine()) setState((s) => ({ ...s, text: bufRef.current }))
    }
    const ctx: AiTaskContext = {
      signal: ctrl.signal,
      onToken: (d) => {
        if (!mine()) return
        bufRef.current += d
        if (!frameRef.current) frameRef.current = requestAnimationFrame(flush)
      },
      onProgress: (p) => {
        if (mine()) setState((s) => ({ ...s, progress: p }))
      },
    }
    try {
      const value = await fn(ctx)
      if (!mine()) return { status: 'superseded' }
      const text = typeof value === 'string' ? value : bufRef.current
      setState({ status: 'done', text, error: null, progress: null })
      return { status: 'done', value, text }
    } catch (error) {
      if (!mine()) return { status: 'superseded' }
      const text = bufRef.current
      if (isAbortError(error)) {
        setState({ status: text ? 'done' : 'idle', text, error: null, progress: null })
        return { status: 'stopped', text }
      }
      setState({ status: 'error', text, error, progress: null })
      return { status: 'error', error, text }
    } finally {
      if (mine()) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
        ctrlRef.current = null
      }
    }
  }, [])

  const stop = useCallback(() => ctrlRef.current?.abort(), [])

  const reset = useCallback(() => {
    ctrlRef.current?.abort()
    ctrlRef.current = null
    bufRef.current = ''
    setState(IDLE)
  }, [])

  return { ...state, running: state.status === 'running', run, stop, reset }
}
