import { useState, useEffect, useReducer, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import PostCard from './PostCard';
import type { OverlayPost, DisplayConfig } from './types';

const DEFAULT_CONFIG: DisplayConfig = {
  slotCount: 2,
  postDisplaySeconds: 5,
  position: { x: 100, y: 100 },
  clickThrough: true,
  overflowGuard: { enabled: false, maxHeightPercent: 80 },
};

interface ActivePost {
  post: OverlayPost;
  enteredAt: number;
}

/** Wraps a queued post with bookkeeping metadata. */
interface PendingEntry {
  post: OverlayPost;
  enqueuedAt: number;
  attempts: number;
}

/** Skip a pending post after this many failed measurement attempts. */
const MAX_PENDING_ATTEMPTS = 20;
/** Skip pending posts older than this (ms). */
const MAX_PENDING_AGE_MS = 60_000;

export default function App() {
  const [config, setConfig] = useState<DisplayConfig>(DEFAULT_CONFIG);
  const [posts, setPosts] = useState<ActivePost[]>([]);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const pendingQueue = useRef<PendingEntry[]>([]);
  const [measuredPost, setMeasuredPost] = useState<OverlayPost | null>(null);

  // Shadow ref — lets the tick interval read the current value without
  // being listed as an effect dependency.
  const measuredPostRef = useRef<OverlayPost | null>(null);
  const postsRef = useRef<ActivePost[]>([]);

  const lastAdmittedAt = useRef<number>(0);
  const lastMeasureAttemptAt = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  const totalMs = config.postDisplaySeconds * 1000;
  const dwellMs = totalMs / config.slotCount;

  /** Keep both the ref and the React state in sync. */
  const updateMeasuredPost = useCallback(
    (post: OverlayPost | null) => {
      measuredPostRef.current = post;
      setMeasuredPost(post);
    },
    [],
  );

  /* ── Tick: expire old posts + attempt to flush pending queue ─────── */
  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();

      // Expire old displayed posts
      setPosts((prev) => {
        const next = prev.filter((p) => now - p.enteredAt < totalMs);
        return next.length === prev.length ? prev : next;
      });

      if (config.overflowGuard.enabled) {
        // Purge stale / stuck entries from the front of the queue
        while (pendingQueue.current.length > 0) {
          const front = pendingQueue.current[0];

          // ── FIX (Bug 3a): skip purging the entry currently being measured ──
          if (
            measuredPostRef.current !== null &&
            front.post.uri === measuredPostRef.current.uri
          ) {
            break;
          }

          if (
            now - front.enqueuedAt > MAX_PENDING_AGE_MS ||
            front.attempts >= MAX_PENDING_ATTEMPTS
          ) {
            console.log(
              `[overflow-guard] Dropping stuck pending post ` +
                `(age=${now - front.enqueuedAt}ms, attempts=${front.attempts})`,
            );
            pendingQueue.current.shift();
            try {
              window.electronAPI.postConsumed();
            } catch {
              /* noop */
            }
          } else {
            break;
          }
        }

        // Attempt to start measuring the next pending post.
        // minRetryGap prevents rapid re-measurement when a post repeatedly
        // fails the fit check.
        const minRetryGap = Math.min(dwellMs, 500);
        if (
          pendingQueue.current.length > 0 &&
          measuredPostRef.current === null &&
          now - lastAdmittedAt.current >= dwellMs &&
          now - lastMeasureAttemptAt.current >= minRetryGap
        ) {
          lastMeasureAttemptAt.current = now;
          pendingQueue.current[0].attempts++;
          updateMeasuredPost(pendingQueue.current[0].post);
        }
      }

      if (
        postsRef.current.length > 0 ||
        pendingQueue.current.length > 0 ||
        measuredPostRef.current !== null
      ) {
        tick();
      }
    }, 100);
    return () => clearInterval(id);
  }, [totalMs, dwellMs, config.overflowGuard.enabled, updateMeasuredPost]);

  /* ── After measurement div renders, wait for height to stabilise ─── */
  useEffect(() => {
    if (!measuredPost || !measureRef.current || !containerRef.current) return;

    const div = measureRef.current;
    const container = containerRef.current;
    const maxPx =
      (window.innerHeight * config.overflowGuard.maxHeightPercent) / 100;

    let cancelled = false;
    let stabiliseTimer: ReturnType<typeof setTimeout>;
    let fallbackTimer: ReturnType<typeof setTimeout>;
    const ac = new AbortController();

    const evaluate = () => {
      if (cancelled) return;

      // ── FIX (Bug 3b): verify the measured post is still at the front ──
      if (
        pendingQueue.current.length === 0 ||
        pendingQueue.current[0].post.uri !== measuredPost!.uri
      ) {
        // The entry was purged or reordered while we were measuring.
        updateMeasuredPost(null);
        return;
      }

      const currentHeight = container.scrollHeight;
      const cardHeight = div.scrollHeight;

      // Card has no measurable height yet — bail, but do NOT clear
      // measuredPost here; the fallback timer handles that case.
      if (cardHeight === 0) return;

      if (cardHeight > maxPx) {
        console.log(
          `[overflow-guard] Skipping oversized post (${cardHeight}px > ${maxPx}px allowed)`,
        );
        pendingQueue.current.shift();
        updateMeasuredPost(null);
        try {
          window.electronAPI.postConsumed();
        } catch {
          /* noop */
        }
        return;
      }

      if (currentHeight + cardHeight + 6 <= maxPx) {
        const entry = pendingQueue.current.shift()!;
        lastAdmittedAt.current = Date.now();
        setPosts((prev) => [
          ...prev.filter((p) => p.post.uri !== entry.post.uri),
          { post: entry.post, enteredAt: Date.now() },
        ]);
        try {
          window.electronAPI.postConsumed();
        } catch {
          /* noop */
        }
      }
      // Whether it fit or not, clear measured state.
      // If it didn't fit the post remains in pendingQueue and will be
      // retried after the next interval.
      updateMeasuredPost(null);
    };

    const tryEvaluate = () => {
      if (cancelled) return;
      const imgs = Array.from(div.querySelectorAll<HTMLImageElement>('img'));
      const allSettled = imgs.every((img) => img.complete);
      if (allSettled) {
        clearTimeout(fallbackTimer);
        evaluate();
      }
    };

    const scheduleEvaluate = () => {
      clearTimeout(stabiliseTimer);
      stabiliseTimer = setTimeout(tryEvaluate, 100);
    };

    const ro = new ResizeObserver(scheduleEvaluate);
    ro.observe(div);

    const imgs = Array.from(div.querySelectorAll<HTMLImageElement>('img'));
    for (const img of imgs) {
      if (!img.complete) {
        img.addEventListener('load', scheduleEvaluate, {
          once: true,
          signal: ac.signal,
        });
        img.addEventListener('error', scheduleEvaluate, {
          once: true,
          signal: ac.signal,
        });
      }
    }

    scheduleEvaluate();

    // Absolute fallback: force-clear measuredPost after 2.5 s regardless
    // of card height.  This prevents the pipeline from getting permanently
    // stuck when the card never obtains a measurable height.
    fallbackTimer = setTimeout(() => {
      if (cancelled) return;
      const cardHeight = div.scrollHeight;
      if (cardHeight > 0) {
        evaluate();
      } else {
        console.warn(
          '[overflow-guard] Fallback: card height still 0 after timeout, clearing measured post',
        );
        updateMeasuredPost(null);
      }
    }, 2500);

    return () => {
      cancelled = true;
      ac.abort();
      ro.disconnect();
      clearTimeout(stabiliseTimer);
      clearTimeout(fallbackTimer);
    };
  }, [measuredPost, config.overflowGuard.maxHeightPercent, updateMeasuredPost]);

  /* ── Config IPC listener (mount-only) ────────────────────────────── */
  useEffect(() => {
    const off = window.electronAPI.onConfigUpdate((d: DisplayConfig) =>
      setConfig(d),
    );
    window.electronAPI.getConfig().then((d) => {
      if (d) setConfig(d);
    });
    return off;
  }, []);

  /* ── Post IPC listener (re-subscribe when guard toggle changes) ──── */
  useEffect(() => {
    // When switching from overflow-guard enabled → disabled, flush any
    // orphaned pending posts so they are not silently lost.
    if (!config.overflowGuard.enabled && pendingQueue.current.length > 0) {
      const orphaned = pendingQueue.current.splice(0);
      for (const entry of orphaned) {
        setPosts((prev) => [
          ...prev.filter((p) => p.post.uri !== entry.post.uri),
          { post: entry.post, enteredAt: Date.now() },
        ]);
        try {
          window.electronAPI.postConsumed();
        } catch {
          /* noop */
        }
      }
    }

    const off = window.electronAPI.onNewPost((post: OverlayPost) => {
      if (config.overflowGuard.enabled) {
        pendingQueue.current.push({
          post,
          enqueuedAt: Date.now(),
          attempts: 0,
        });
      } else {
        setPosts((prev) => [
          ...prev.filter((p) => p.post.uri !== post.uri),
          { post, enteredAt: Date.now() },
        ]);
        try {
          window.electronAPI.postConsumed();
        } catch {
          /* noop */
        }
      }
    });
    return off;
  }, [config.overflowGuard.enabled]);

  /* ── Build ordered visible list (newest at top) ──────────────────── */
  const now = Date.now();
  const visible = posts
    .filter((p) => now - p.enteredAt < totalMs)
    .map((p) => ({
      ...p,
      slot: Math.min(
        Math.floor((now - p.enteredAt) / dwellMs),
        config.slotCount - 1,
      ),
    }))
    .sort((a, b) => a.slot - b.slot || b.enteredAt - a.enteredAt);

  return (
    <>
      <div className="measure-container" ref={measureRef}>
        {measuredPost && <PostCard post={measuredPost} measureMode={true} />}
      </div>

      <div
        ref={containerRef}
        className={`overlay-container${config.clickThrough ? '' : ' movable'}`}
      >
        <AnimatePresence mode="popLayout">
          {visible.map(({ post }) => (
            <motion.div
              key={post.uri}
              layout
              className="slot-item"
              style={{ width: '100%' }}
              initial={{ opacity: 0, y: -50, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 60, scale: 0.94 }}
              transition={{
                layout: { type: 'spring', stiffness: 200, damping: 25 },
                opacity: { duration: 0.25 },
                y: { type: 'spring', stiffness: 200, damping: 25 },
                scale: { duration: 0.25 },
              }}
            >
              <PostCard post={post} now={now} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
