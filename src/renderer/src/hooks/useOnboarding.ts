import { useState, useEffect, useCallback, useRef } from 'react'
import type { OnboardingProgress, OnboardingProgressUpdate } from '../../../preload/index'
import { ONBOARDING_TOTAL_STEPS } from '@/constants/onboardingSteps'

const LS_KEY = 'cerp-onboarding-progress'

const DEFAULT_PROGRESS: OnboardingProgress = {
  currentStep: 1,
  completedSteps: [],
  skipped: false,
  completedAt: null,
  lastSeenAt: new Date(0).toISOString(),
  version: 1,
  totalSteps: ONBOARDING_TOTAL_STEPS,
  isCompleted: false,
}

function readLocal(): OnboardingProgress | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as OnboardingProgress) : null
  } catch {
    return null
  }
}

function writeLocal(p: OnboardingProgress): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p))
  } catch {
    /* ignore quota / serialization errors */
  }
}

/**
 * Drives the Desktop guided tutorial (Idea 1).
 *
 * Backend (DesktopOnboarding) is the source of truth, but we mirror to
 * localStorage so the wizard works offline and survives a failed request.
 * Mutations update local state + cache immediately and fire the PATCH in the
 * background — the tutorial never blocks on the network.
 */
export function useOnboarding() {
  const [progress, setProgress] = useState<OnboardingProgress>(() => readLocal() ?? DEFAULT_PROGRESS)
  const [loading, setLoading] = useState(true)
  // Track whether we've already decided about auto-showing this session.
  const autoShowResolved = useRef(false)
  const [shouldAutoShow, setShouldAutoShow] = useState(false)

  // Load authoritative progress from the backend on mount.
  useEffect(() => {
    let cancelled = false
    window.cerpAPI
      .getOnboardingProgress()
      .then((res) => {
        if (cancelled) return
        const data = res?.data ?? readLocal()
        if (data) {
          setProgress(data)
          writeLocal(data)
        }
      })
      .catch(() => {
        /* keep local fallback */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Decide auto-show ONCE, after the first load settles: only for users who
  // haven't completed or skipped the tutorial.
  useEffect(() => {
    if (loading || autoShowResolved.current) return
    autoShowResolved.current = true
    setShouldAutoShow(!progress.isCompleted && !progress.skipped)
  }, [loading, progress.isCompleted, progress.skipped])

  // Apply an optimistic local patch and persist to backend in the background.
  const apply = useCallback((local: Partial<OnboardingProgress>, remote: OnboardingProgressUpdate) => {
    setProgress((prev) => {
      const next = { ...prev, ...local, lastSeenAt: new Date().toISOString() }
      writeLocal(next)
      return next
    })
    window.cerpAPI
      .updateOnboardingProgress(remote)
      .then((res) => {
        if (res?.data) {
          setProgress(res.data)
          writeLocal(res.data)
        }
      })
      .catch(() => {
        /* local state already updated; backend will reconcile next load */
      })
  }, [])

  const viewStep = useCallback(
    (step: number) => apply({ currentStep: step }, { viewStep: step }),
    [apply],
  )

  const completeStep = useCallback(
    (step: number) =>
      apply(
        {
          completedSteps: Array.from(new Set([...(readLocal()?.completedSteps ?? []), step])).sort(
            (a, b) => a - b,
          ),
        },
        { completeStep: step },
      ),
    [apply],
  )

  const skip = useCallback(() => apply({ skipped: true }, { skipped: true }), [apply])

  const complete = useCallback(
    () => apply({ isCompleted: true, completedAt: new Date().toISOString() }, { completed: true }),
    [apply],
  )

  const relaunch = useCallback(
    () =>
      apply(
        { currentStep: 1, completedSteps: [], skipped: false, isCompleted: false, completedAt: null },
        { relaunch: true },
      ),
    [apply],
  )

  return { progress, loading, shouldAutoShow, viewStep, completeStep, skip, complete, relaunch }
}
