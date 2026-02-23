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

export default function App() {
  const [config, setConfig] = useState<DisplayConfig>(DEFAULT_CONFIG);
  const [posts, setPosts] = useState<ActivePost[]>([]);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const pendingQueue = useRef<OverlayPost[]>([]);
  const [measuredPost, setMeasuredPost] = useState<OverlayPost | null>(null);

  // Shadow ref for measuredPost — lets the tick interval read the current
  // value without being listed as an effect dependency (which would tear
  // down and recreate the interval on every measurement cycle).
  const measuredPostRef = useRef<OverlayPost | null>(null);

  const lastAdmittedAt = useRef<number>(0);
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
    const id = setInterval(() => {
      const now = Date.now();

      setPosts((prev) => {
        const next = prev.filter((p) => now - p.enteredAt < totalMs);
        return next.length === prev.length ? prev : next;
      });

      if (
        config.overflowGuard.enabled &&
        pendingQueue.current.length > 0 &&
        measuredPostRef.current === null &&
        now - lastAdmittedAt.current >= dwellMs
      ) {
        updateMeasuredPost(pendingQueue.current[0]);
      }

      tick();
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
      const currentHeight = container.scrollHeight;
      const cardHeight = div.scrollHeight;

      if (cardHeight === 0) return;

      if (cardHeight > maxPx) {
        console.log(
          `[overflow-guard] Skipping oversized post (${cardHeight}px > ${maxPx}px allowed)`,
        );
        pendingQueue.current.shift();
        updateMeasuredPost(null);
        window.electronAPI.postConsumed();
        return;
      }

      if (currentHeight + cardHeight + 6 <= maxPx) {
        const post = pendingQueue.current.shift()!;
        lastAdmittedAt.current = Date.now();
        setPosts((prev) => [
          ...prev.filter((p) => p.post.uri !== post.uri),
          { post, enteredAt: Date.now() },
        ]);
        window.electronAPI.postConsumed();
      }
      // Whether it fit or not, clear measured state.
      // If it didn't fit the post remains in pendingQueue and will be
      // retried after the next dwellMs interval — not on every 100 ms tick.
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

    // Attach load/error listeners via AbortController for clean teardown.
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

    // Absolute fallback: evaluate with whatever height is available after
    // 2.5 s rather than leaving the card stuck in the pending queue.
    fallbackTimer = setTimeout(evaluate, 2500);

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
    const off = window.electronAPI.onNewPost((post: OverlayPost) => {
      if (config.overflowGuard.enabled) {
        pendingQueue.current.push(post);
      } else {
        setPosts((prev) => [
          ...prev.filter((p) => p.post.uri !== post.uri),
          { post, enteredAt: Date.now() },
        ]);
        window.electronAPI.postConsumed();
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
        {measuredPost && (
          <PostCard post={measuredPost} measureMode={true} />
        )}
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
              <PostCard post={post} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
