/**
 * main.ts — Bluesky Desktop Overlay (Main Process)
 */

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  ipcMain,
  Notification,
  screen,
} from 'electron';
import { BskyAgent } from '@atproto/api';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AppConfig {
  _WARNING?: string;
  auth: { handle: string; appPassword: string };
  display: {
    slotCount: number;
    postDisplaySeconds: number;
    position: { x: number; y: number };
    clickThrough: boolean;
    windowWidth: number;
    overflowGuard: {
      enabled: boolean;
      maxHeightPercent: number;
    };
  };
  advanced: {
    fetchLimit: number;
    customFeedUri: string;
  };
}

interface PostAuthor {
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  avatarDataUri: string | null;
}

interface ParentPost {
  uri: string;
  cid: string;
  author: PostAuthor;
  text: string;
  facets: unknown[];
  createdAt: string;
  embed: unknown | null;
  likeCount: number;
  repostCount: number;
  replyCount: number;
}

interface OverlayPost {
  uri: string;
  cid: string;
  author: PostAuthor;
  text: string;
  facets: unknown[];
  createdAt: string;
  embed: unknown | null;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  repostBy: { did: string; handle: string; displayName: string } | null;
  parent: ParentPost | null;
}

type FeedSource =
  | { kind: 'timeline' }
  | { kind: 'generator'; uri: string }
  | { kind: 'list'; uri: string };

// ─── Constants ───────────────────────────────────────────────────────────────

const ENC_PREFIX = 'ENC:';
const DEDUP_SIZE = 200;
const AVATAR_LRU_CAP = 200;
const IDLE_MIN_MS = 10_000;
const IDLE_MAX_MS = 15_000;
const WINDOW_WIDTH = 460;
const MIN_VISIBLE_HEIGHT = 100;
const TOPMOST_HEARTBEAT_MS = 2_000;
const AVATAR_FETCH_TIMEOUT_MS = 8_000;
const FEED_FETCH_TIMEOUT_MS = 20_000;

// ─── File Logging ─────────────────────────────────────────────────────────────

const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2 MB — rotate when exceeded
let logStream: fs.WriteStream | null = null;

function setupLogging(logDir: string): void {
  const logPath = path.join(logDir, 'app.log');

  // Rotate: if the current log exceeds MAX_LOG_SIZE, move it to app.prev.log
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_SIZE) {
      const prevPath = path.join(logDir, 'app.prev.log');
      if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
      fs.renameSync(logPath, prevPath);
    }
  } catch {
    /* rotation is best-effort */
  }

  logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  function ts(): string {
    return new Date().toISOString();
  }

  function fmt(args: unknown[]): string {
    return args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack ?? a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
  }

  console.log = (...args: unknown[]) => {
    origLog(...args);
    logStream?.write(`${ts()} [LOG]   ${fmt(args)}\n`);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    logStream?.write(`${ts()} [WARN]  ${fmt(args)}\n`);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    logStream?.write(`${ts()} [ERROR] ${fmt(args)}\n`);
  };

  process.on('uncaughtException', (err) => {
    logStream?.write(
      `${ts()} [FATAL] Uncaught exception: ${err.stack ?? err.message}\n`,
    );
  });
  process.on('unhandledRejection', (reason) => {
    const msg =
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logStream?.write(`${ts()} [FATAL] Unhandled rejection: ${msg}\n`);
  });

  console.log('[log] Logging to', logPath);
}

function closeLogging(): void {
  logStream?.end();
  logStream = null;
}

// ─── Module-level State ──────────────────────────────────────────────────────

let cfgPath: string;
let config: AppConfig;
let prevValidConfig: AppConfig | null = null;
let feedSource: FeedSource = { kind: 'timeline' };

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let agent: BskyAgent | null = null;
let watcher: fs.FSWatcher | null = null;

let fetchBusy = false;
let fetchGen = 0;
let dispTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let topHeartbeat: ReturnType<typeof setInterval> | null = null;
let moveWriteBounce: ReturnType<typeof setTimeout> | null = null;

let pendingInRenderer = 0;
let pendingInRendererSince: number = 0;
let isRepositioning = false;

// C1: prevents two concurrent reloadConfig() calls from racing on shared state
let reloadInProgress = false;
// C2: timestamp set by writeConfig() so the file watcher can skip self-triggered reloads
let selfWriteUntil = 0;

const queue: OverlayPost[] = [];

const seenSet = new Set<string>();
const seenOrder: string[] = [];

const avatarCache = new Map<string, string>();
const avatarInFlight = new Map<string, Promise<string | null>>();

// ─── Utility ─────────────────────────────────────────────────────────────────

function notify(title: string, body: string): void {
  new Notification({ title, body }).show();
}

function logSource(label: string, src: FeedSource): void {
  if (src.kind === 'timeline') {
    console.log(`[${label}] Active feed source: timeline`);
  } else {
    console.log(`[${label}] Active feed source: ${src.kind} → ${src.uri}`);
  }
}

// ─── Feed-Source Parsing ─────────────────────────────────────────────────────

function parseSource(input: string): FeedSource {
  const t = (input ?? '').trim();
  if (!t) return { kind: 'timeline' };

  if (t.startsWith('at://')) {
    if (t.includes('/app.bsky.feed.generator/'))
      return { kind: 'generator', uri: t };
    if (t.includes('/app.bsky.graph.list/'))
      return { kind: 'list', uri: t };
    console.warn(`[source] Unrecognised AT-URI collection: ${t}`);
    return { kind: 'timeline' };
  }

  const feedMatch = t.match(
    /bsky\.app\/profile\/([^/]+)\/feed\/([^/?#]+)/,
  );
  if (feedMatch) {
    return {
      kind: 'generator',
      uri: `at://${feedMatch[1]}/app.bsky.feed.generator/${feedMatch[2]}`,
    };
  }

  const listMatch = t.match(
    /bsky\.app\/profile\/([^/]+)\/lists\/([^/?#]+)/,
  );
  if (listMatch) {
    return {
      kind: 'list',
      uri: `at://${listMatch[1]}/app.bsky.graph.list/${listMatch[2]}`,
    };
  }

  console.warn(`[source] Could not parse customFeedUri: ${t}`);
  return { kind: 'timeline' };
}

// ─── Handle → DID Resolution ─────────────────────────────────────────────────

async function resolveAtUriDid(atUri: string): Promise<string> {
  const m = atUri.match(/^at:\/\/([^/]+)(\/.*)?$/);
  if (!m) return atUri;
  const authority = m[1];
  const rest = m[2] ?? '';
  if (authority.startsWith('did:')) return atUri;
  if (!agent?.session) {
    console.warn(
      `[source] Cannot resolve handle "${authority}" — not authenticated`,
    );
    return atUri;
  }
  try {
    const { data } = await agent.resolveHandle({ handle: authority });
    const resolved = `at://${data.did}${rest}`;
    console.log(`[source] Resolved handle "${authority}" → ${data.did}`);
    return resolved;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[source] Failed to resolve handle "${authority}":`,
      message,
    );
    notify(
      'Feed Error',
      `Could not resolve handle "${authority}". Check the customFeedUri in config.json.`,
    );
    return atUri;
  }
}

async function resolveFeedSourceDid(src: FeedSource): Promise<FeedSource> {
  switch (src.kind) {
    case 'timeline':
      return src;
    case 'generator':
      return { kind: 'generator', uri: await resolveAtUriDid(src.uri) };
    case 'list':
      return { kind: 'list', uri: await resolveAtUriDid(src.uri) };
  }
}

// ─── Screen-Boundary Clamping ────────────────────────────────────────────────

function clampToScreen(x: number, y: number): { x: number; y: number } {
  const { workArea } = screen.getDisplayNearestPoint({ x, y });
  const maxX = workArea.x + workArea.width - (config?.display?.windowWidth ?? WINDOW_WIDTH);
  const maxY = workArea.y + workArea.height - MIN_VISIBLE_HEIGHT;
  return {
    x: Math.max(workArea.x, Math.min(x, maxX)),
    y: Math.max(workArea.y, Math.min(y, maxY)),
  };
}

// ─── Configuration ───────────────────────────────────────────────────────────

function defaultConfig(): AppConfig {
  return {
    _WARNING:
      'Setting postDisplaySeconds below 3 with a low fetchLimit may cause excessive API calls and risk rate limiting.',
    auth: { handle: '', appPassword: '' },
    display: {
      slotCount: 10,
      postDisplaySeconds: 30,
      position: { x: 100, y: 100 },
      clickThrough: true,
      windowWidth: 460,
      overflowGuard: {
        enabled: true,
        maxHeightPercent: 100,
      },
    },
    advanced: { fetchLimit: 10, customFeedUri: '' },
  };
}

function writeConfig(c: AppConfig): void {
  // C2: stamp the time so watchConfig()'s debounce can skip this self-write
  selfWriteUntil = Date.now() + 600; // must exceed the 500ms debounce
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2), 'utf-8');
}

function openConfig(): void {
  shell.openPath(cfgPath).catch(() => {});
}

function sanitise(c: AppConfig): AppConfig {
  const d = defaultConfig();
  c.auth ??= d.auth;
  c.display ??= d.display;
  c.display.slotCount = Math.max(
    1,
    Math.min(100, c.display.slotCount ?? d.display.slotCount),
  );
  c.display.postDisplaySeconds = Math.max(
    1,
    c.display.postDisplaySeconds ?? d.display.postDisplaySeconds,
  );
  c.display.position ??= d.display.position;
  c.display.position.x ??= d.display.position.x;
  c.display.position.y ??= d.display.position.y;
  c.display.clickThrough ??= d.display.clickThrough;
  c.display.overflowGuard ??= d.display.overflowGuard;
  c.display.overflowGuard.enabled ??= d.display.overflowGuard.enabled;
  c.display.overflowGuard.maxHeightPercent = Math.max(
    1,
    Math.min(
      100,
      c.display.overflowGuard.maxHeightPercent ??
        d.display.overflowGuard.maxHeightPercent,
    ),
  );
  c.advanced ??= d.advanced;
  c.advanced.fetchLimit = Math.max(
    1,
    Math.min(100, c.advanced.fetchLimit ?? d.advanced.fetchLimit),
  );
  c.advanced.customFeedUri ??= d.advanced.customFeedUri;
  c.display.windowWidth = Math.max(
    300,
    Math.min(800, c.display.windowWidth ?? d.display.windowWidth),
  );
  const clamped = clampToScreen(
    c.display.position.x,
    c.display.position.y,
  );
  c.display.position.x = clamped.x;
  c.display.position.y = clamped.y;
  return c;
}

function loadConfig(): AppConfig | null {
  if (!fs.existsSync(cfgPath)) {
    writeConfig(defaultConfig());
    openConfig();
    return null;
  }
  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const c = sanitise(JSON.parse(raw));
    if (JSON.stringify(c) !== JSON.stringify(JSON.parse(raw))) {
      writeConfig(c);
    }
    prevValidConfig = c;
    return c;
  } catch (err) {
    console.error('[config] Malformed JSON:', err);
    notify(
      'Config Error',
      'config.json is malformed. Using last valid configuration.',
    );
    return prevValidConfig ?? defaultConfig();
  }
}

// ─── Credential Encryption ───────────────────────────────────────────────────

function encryptPw(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      '[crypto] OS encryption unavailable — password stored as plaintext.',
    );
    notify(
      'Security Warning',
      'OS encryption is unavailable. Your app password is stored as plaintext in config.json.',
    );
    return plain;
  }
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
}

function decryptPw(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    config.auth.appPassword = encryptPw(stored);
    writeConfig(config);
    return stored;
  }
  return safeStorage.decryptString(
    Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'),
  ).trim();
}

// ─── Avatar LRU Cache ────────────────────────────────────────────────────────

async function resolveAvatar(
  did: string,
  url: string | undefined,
): Promise<string | null> {
  if (!url) return null;
  if (avatarCache.has(did)) {
    const v = avatarCache.get(did)!;
    avatarCache.delete(did);
    avatarCache.set(did, v);
    return v;
  }
  if (avatarInFlight.has(did)) return avatarInFlight.get(did)!;

  const task = (async (): Promise<string | null> => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), AVATAR_FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const mime = res.headers.get('content-type') ?? 'image/jpeg';
      const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
      const dataUri = `data:${mime};base64,${b64}`;
      avatarCache.set(did, dataUri);
      if (avatarCache.size > AVATAR_LRU_CAP) {
        avatarCache.delete(avatarCache.keys().next().value!);
      }
      return dataUri;
    } catch {
      return null;
    } finally {
      avatarInFlight.delete(did);
    }
  })();

  avatarInFlight.set(did, task);
  return task;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function alreadySeen(uri: string): boolean {
  return seenSet.has(uri);
}

function markSeen(uri: string): void {
  if (seenSet.has(uri)) return;
  seenSet.add(uri);
  seenOrder.push(uri);
  while (seenOrder.length > DEDUP_SIZE) {
    seenSet.delete(seenOrder.shift()!);
  }
}

function clearSeen(): void {
  seenSet.clear();
  seenOrder.length = 0;
}

// ─── Authentication ──────────────────────────────────────────────────────────

async function authenticate(): Promise<boolean> {
  const { handle, appPassword } = config.auth;
  if (!handle || !appPassword) {
    openConfig();
    return false;
  }
  let plain: string;
  try {
    plain = decryptPw(appPassword);
  } catch (err) {
    console.error('[auth] Decryption error:', err);
    notify(
      'Auth Error',
      'Could not decrypt app password. Please re-enter it in config.json.',
    );
    openConfig();
    return false;
  }
  agent = new BskyAgent({ service: 'https://bsky.social' });
  try {
    await agent.login({ identifier: handle, password: plain });
    console.log(`[auth] Authenticated as ${handle}`);
    return true;
  } catch (err) {
    console.error('[auth] Login failed:', err);
    notify(
      'Auth Error',
      'Bluesky login failed. Please check your credentials in config.json.',
    );
    openConfig();
    agent = null;
    return false;
  }
}

// ─── Feed-Item Processing ────────────────────────────────────────────────────

async function processFeedItems(
  items: any[],
  gen: number,
): Promise<OverlayPost[]> {
  // Phase 1: collect unique DIDs → avatar URL mappings and fetch all concurrently.
  // We capture the results directly so phase 2 doesn't need to call resolveAvatar()
  // again — a second call risks a cache miss if the LRU evicted entries under load.
  const didToUrl = new Map<string, string | undefined>();
  for (const item of items) {
    if (!didToUrl.has(item.post.author.did)) {
      didToUrl.set(item.post.author.did, item.post.author.avatar);
    }
    const pp = item.reply?.parent;
    if (pp?.record && !didToUrl.has(pp.author.did)) {
      didToUrl.set(pp.author.did, pp.author.avatar);
    }
  }
  const didList = [...didToUrl.entries()];
  const resolvedList = await Promise.all(
    didList.map(([did, url]) => resolveAvatar(did, url)),
  );
  if (gen !== fetchGen) return [];
  const avatarMap = new Map<string, string | null>(
    didList.map(([did], i) => [did, resolvedList[i]]),
  );

  const fresh: OverlayPost[] = [];

  for (const item of items) {
    const { post, reply, reason } = item;
    if (!post?.uri || !post?.author?.did || !post?.author?.handle) {
      console.warn('[fetch] Skipping malformed feed item (missing post/author fields)');
      continue;
    }
    if (alreadySeen(post.uri)) continue;

    const rec = post.record as Record<string, unknown>;

    let parent: ParentPost | null = null;
    const pp = reply?.parent;
    if (pp?.record) {
      const ppRec = pp.record as Record<string, unknown>;
      parent = {
        uri: pp.uri,
        cid: pp.cid,
        author: {
          did: pp.author.did,
          handle: pp.author.handle,
          displayName: pp.author.displayName ?? pp.author.handle,
          avatarUrl: pp.author.avatar ?? null,
          avatarDataUri: avatarMap.get(pp.author.did) ?? null,
        },
        text: (ppRec.text as string) ?? '',
        facets: (ppRec.facets as unknown[]) ?? [],
        createdAt: (ppRec.createdAt as string) ?? pp.indexedAt,
        embed: pp.embed ?? null,
        likeCount: pp.likeCount ?? 0,
        repostCount: pp.repostCount ?? 0,
        replyCount: pp.replyCount ?? 0,
      };
    }

    let repostBy: OverlayPost['repostBy'] = null;
    if ((reason as any)?.$type === 'app.bsky.feed.defs#reasonRepost') {
      const by = (reason as any).by;
      repostBy = {
        did: by.did,
        handle: by.handle,
        displayName: by.displayName ?? by.handle,
      };
    }

    fresh.push({
      uri: post.uri,
      cid: post.cid,
      author: {
        did: post.author.did,
        handle: post.author.handle,
        displayName: post.author.displayName ?? post.author.handle,
        avatarUrl: post.author.avatar ?? null,
        avatarDataUri: avatarMap.get(post.author.did) ?? null,
      },
      text: (rec.text as string) ?? '',
      facets: (rec.facets as unknown[]) ?? [],
      createdAt: (rec.createdAt as string) ?? post.indexedAt,
      embed: post.embed ?? null,
      likeCount: post.likeCount ?? 0,
      repostCount: post.repostCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostBy,
      parent,
    });
  }

  return fresh;
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

// Wraps a fetch promise with an AbortController timeout so that a hanging
// network request can never permanently lock fetchBusy.
function withFetchTimeout<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FEED_FETCH_TIMEOUT_MS);
  return task(ac.signal).finally(() => clearTimeout(timer));
}

async function fetchFromSource(
  source: FeedSource,
  limit: number,
): Promise<any[]> {
  if (!agent?.session) return [];
  switch (source.kind) {
    case 'timeline': {
      const { data } = await withFetchTimeout((signal) =>
        agent!.getTimeline({ limit }, { signal } as any),
      );
      return data.feed;
    }
    case 'generator': {
      const { data } = await withFetchTimeout((signal) =>
        agent!.app.bsky.feed.getFeed({ feed: source.uri, limit }, { signal } as any),
      );
      return data.feed;
    }
    case 'list': {
      const { data } = await withFetchTimeout((signal) =>
        agent!.app.bsky.feed.getListFeed({ list: source.uri, limit }, { signal } as any),
      );
      return data.feed;
    }
  }
}

async function fetchPosts(): Promise<void> {
  if (fetchBusy) return;

  // ── FIX (Bug 1): handle missing session instead of silently returning ──
  if (!agent?.session) {
    console.warn('[fetch] No active session — attempting re-authentication');
    const ok = await authenticate();
    if (ok) {
      feedSource = await resolveFeedSourceDid(
        parseSource(config.advanced.customFeedUri),
      );
      fetchPosts();
    } else {
      console.warn('[fetch] Re-auth failed — retrying in 30s');
      setTimeout(fetchPosts, 30_000);
    }
    return;
  }

  fetchBusy = true;
  const gen = fetchGen;

  try {
    const items = await fetchFromSource(
      feedSource,
      config.advanced.fetchLimit,
    );
    if (gen !== fetchGen) { fetchBusy = false; return; }

    console.log(
      `[fetch] ${feedSource.kind} returned ${items.length} item(s)`,
    );

    const fresh = await processFeedItems(items, gen);
    if (gen !== fetchGen) { fetchBusy = false; return; }

    console.log(
      `[fetch] ${fresh.length} new post(s) after dedup (seen: ${seenSet.size})`,
    );

    if (fresh.length > 0) {
      fresh.reverse();
      for (const p of fresh) {
        markSeen(p.uri);
        queue.push(p);
      }
      startDisplay();
    } else {
      scheduleIdle();
    }
  } catch (err: any) {
    if (gen !== fetchGen) return;

    if (err?.status === 429) {
      const backoffMs =
        parseInt(err.headers?.['retry-after'] ?? '30', 10) * 1_000;
      console.warn(
        `[fetch] Rate-limited — backing off ${backoffMs / 1_000}s`,
      );
      setTimeout(() => {
        fetchBusy = false;
        fetchPosts();
      }, backoffMs);
      return;
    }

    if (err?.status === 401) {
      console.warn('[fetch] 401 — attempting re-authentication');
      fetchBusy = false;
      const ok = await authenticate();
      if (ok) {
        feedSource = await resolveFeedSourceDid(
          parseSource(config.advanced.customFeedUri),
        );
        fetchPosts();
      } else {
        // ── FIX (Bug 1): retry instead of silently dying ──
        console.warn('[fetch] Re-auth after 401 failed — retrying in 30s');
        setTimeout(fetchPosts, 30_000);
      }
      return;
    }

    const feedLabel =
      feedSource.kind === 'timeline'
        ? 'timeline'
        : `${feedSource.kind} (${feedSource.uri})`;
    console.error(
      `[fetch] Error from ${feedLabel}:`,
      err?.message ?? err,
    );
    setTimeout(() => {
      fetchBusy = false;
      fetchPosts();
    }, 10_000);
    return;
  }

  if (gen === fetchGen) fetchBusy = false;
}

// ─── Display Pump ────────────────────────────────────────────────────────────

function slotDwellMs(): number {
  return (
    (config.display.postDisplaySeconds / config.display.slotCount) * 1_000
  );
}

function startDisplay(): void {
  if (dispTimer !== null) return;
  pump();
}

function pump(): void {
  if (queue.length === 0) {
    dispTimer = null;
    if (pendingInRenderer > 0) {
      if (Date.now() - pendingInRendererSince > 10_000) {
        console.warn(
          '[pump] pendingInRenderer stuck for >10s — resetting',
        );
        pendingInRenderer = 0;
        fetchPosts();
        return;
      }
      dispTimer = setTimeout(pump, 200);
      return;
    }
    // If a fetch is already in-flight, don't call fetchPosts() — it would
    // return immediately and leave dispTimer null, permanently killing the
    // loop. Retry in 2 s so pump() stays alive until the fetch resolves.
    if (fetchBusy) {
      dispTimer = setTimeout(pump, 2_000);
      return;
    }
    fetchPosts();
    return;
  }

  // ── FIX (Bug 2): don't dispatch if the window is gone ──
  if (!win || win.isDestroyed()) {
    dispTimer = null;
    queue.length = 0;
    pendingInRenderer = 0;
    return;
  }

  // M1: only stamp the time when pendingInRenderer transitions from 0 → 1.
  // Stamping on every dispatch kept the timestamp perpetually fresh during
  // large queue flushes, preventing the 10-second stuck guard from firing.
  if (pendingInRenderer === 0) pendingInRendererSince = Date.now();
  pendingInRenderer++;
  win.webContents.send('post:new', queue.shift()!);
  dispTimer = setTimeout(pump, slotDwellMs());
}

function stopDisplay(): void {
  if (dispTimer !== null) {
    clearTimeout(dispTimer);
    dispTimer = null;
  }
}

// ─── Idle Cooldown ───────────────────────────────────────────────────────────

function scheduleIdle(): void {
  if (idleTimer !== null) return;
  const gen = fetchGen;
  const ms = IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS);
  console.log(
    `[idle] No new posts. Polling again in ${(ms / 1_000).toFixed(1)}s`,
  );
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (gen !== fetchGen) return;
    fetchPosts();
  }, ms);
}

function cancelIdle(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// ─── Always-On-Top Heartbeat ─────────────────────────────────────────────────

function startTopHeartbeat(): void {
  stopTopHeartbeat();
  topHeartbeat = setInterval(() => {
    // L1: heartbeat is only needed when click-through (always-on-top) is active.
    // During movable/repositioning mode the window is intentionally focusable
    // and toggling always-on-top would disrupt other AOT windows unnecessarily.
    if (!config?.display?.clickThrough) return;
    if (win && !win.isDestroyed()) {
      // Toggle off then on — calling setAlwaysOnTop(true) while the flag
      // is nominally still true is a no-op on some Windows builds.
      win.setAlwaysOnTop(false);
      win.setAlwaysOnTop(true, 'normal');
      win.moveTop();
    }
  }, TOPMOST_HEARTBEAT_MS);
}

function stopTopHeartbeat(): void {
  if (topHeartbeat !== null) {
    clearInterval(topHeartbeat);
    topHeartbeat = null;
  }
}

// ─── Window ──────────────────────────────────────────────────────────────────

function windowHeight(x: number, y: number): number {
  const display = screen.getDisplayNearestPoint({ x, y });
  const bottom = display.workArea.y + display.workArea.height;
  return Math.max(MIN_VISIBLE_HEIGHT, bottom - y);
}

function createWindow(): void {
  const { position, clickThrough } = config.display;
  const clamped = clampToScreen(position.x, position.y);
  config.display.position = clamped;
  const winWidth = config.display.windowWidth;

  win = new BrowserWindow({
    width: winWidth,
    height: windowHeight(clamped.x, clamped.y),
    x: clamped.x,
    y: clamped.y,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: !clickThrough,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'normal');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(clickThrough);

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  } else {
    win.loadURL('http://localhost:5173');
  }

  win.on('moved', () => {
    if (!win || isRepositioning) return;
    const [rawX, rawY] = win.getPosition();
    const { x, y } = clampToScreen(rawX, rawY);
    if (x !== rawX || y !== rawY) {
      isRepositioning = true;
      win.setBounds({
        x,
        y,
        width: config.display.windowWidth,
        height: windowHeight(x, y),
      });
      isRepositioning = false;
    }
    config.display.position = { x, y };
    // Debounce the config write so dragging doesn't trigger the file
    // watcher → reloadConfig → window recreation on every pixel.
    if (moveWriteBounce) clearTimeout(moveWriteBounce);
    moveWriteBounce = setTimeout(() => {
      moveWriteBounce = null;
      writeConfig(config);
    }, 1_000);
  });

  win.on('closed', () => {
    win = null;
  });

  win.on('always-on-top-changed', (_event, isOnTop) => {
    if (!isOnTop && win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'normal');
      win.moveTop();
    }
  });

  startTopHeartbeat();
}

// ─── Runtime Display Config ──────────────────────────────────────────────────

async function applyDisplay(): Promise<void> {
  const { position } = config.display;
  const clamped = clampToScreen(position.x, position.y);
  config.display.position = clamped;

  stopTopHeartbeat();
  stopDisplay();

  // Window is being recreated — any posts previously dispatched to the
  // old renderer are lost, so reset the counter to avoid stalling pump().
  pendingInRenderer = 0;

  if (win) {
    win.destroy();
    win = null;
  }

  // H1: resolve the feed source DID *before* creating the window so the first
  // fetchPosts() call (triggered by did-finish-load) uses the correct source.
  // Previously this awaited *after* createWindow(), so the renderer finished
  // loading (~80-150ms) before handle resolution finished (~200-800ms), causing
  // the first fetch to use the stale pre-reload feedSource.
  feedSource = await resolveFeedSourceDid(
    parseSource(config.advanced.customFeedUri),
  );
  logSource('source', feedSource);

  createWindow();

  win!.webContents.once('did-finish-load', () => {
    win?.webContents.send('config:update', config.display);
    if (queue.length > 0) {
      startDisplay();
    } else {
      fetchPosts();
    }
  });
}

// ─── Config File Watcher ─────────────────────────────────────────────────────

function watchConfig(): void {
  watcher?.close();
  let bounce: ReturnType<typeof setTimeout> | null = null;
  watcher = fs.watch(cfgPath, () => {
    if (bounce) clearTimeout(bounce);
    bounce = setTimeout(() => {
      bounce = null;
      // C2: if this write was triggered by writeConfig() itself (e.g. sanitise,
      // decryptPw, or drag debounce), skip reloading — selfWriteUntil extends
      // 100ms past this debounce so the check is always valid here.
      if (Date.now() < selfWriteUntil) return;
      if (fs.existsSync(cfgPath)) reloadConfig();
    }, 500);
  });
  watcher.on('error', (err) => console.error('[watch]', err));
}

async function reloadConfig(): Promise<void> {
  // C1: prevent two concurrent reloadConfig() calls from racing on shared state.
  // The watcher debounce is only 500ms but reloadConfig can take 1–6s (auth +
  // handle resolution). If a second watcher event arrives during that window,
  // we drop it — the user can save again if needed.
  if (reloadInProgress) {
    console.log('[config] Reload already in progress — skipping concurrent trigger');
    return;
  }
  reloadInProgress = true;

  try {
    const prevAuth = {
      handle: config.auth.handle,
      pw: config.auth.appPassword,
    };
    const loaded = loadConfig();
    if (!loaded) return;
    config = loaded;

    const credsChanged =
      prevAuth.handle !== config.auth.handle ||
      prevAuth.pw !== config.auth.appPassword;

    if (credsChanged) {
      console.log('[config] Credentials changed — re-authenticating');
      cancelIdle();
      stopDisplay();
      queue.length = 0;
      clearSeen();
      fetchBusy = false;
      fetchGen++;
      pendingInRenderer = 0;
      await authenticate();
      // H2: do NOT call fetchPosts() here. applyDisplay() → did-finish-load
      // will call fetchPosts() once the renderer is confirmed ready, preventing
      // IPC messages being sent before the listener is registered.
    } else {
      cancelIdle();
      queue.length = 0;
      clearSeen();
      fetchBusy = false;
      // H3: increment fetchGen in the non-creds path too. Without this, any
      // in-flight fetch with the old gen passes the gen !== fetchGen guard and
      // enqueues stale results into the freshly-cleared queue.
      fetchGen++;
    }

    await applyDisplay();

    // Re-arm the watcher: editors that perform atomic saves (write-to-temp +
    // rename) change the file's inode, which causes fs.watch to silently stop
    // firing after the first reload.
    watchConfig();
  } finally {
    reloadInProgress = false;
  }
}

// ─── System Tray ─────────────────────────────────────────────────────────────

function createTray(): void {
  const iconPath = path.join(app.getAppPath(), 'assets', 'tray-icon.png');
  const img = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf' +
          'FcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
      );
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Bluesky Overlay');

  const ctxMenu = Menu.buildFromTemplate([
    { label: 'Open Config', click: () => openConfig() },
    { label: 'Reload Config', click: () => { reloadConfig(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.on('right-click', () => {
    win?.blur();
    tray!.popUpContextMenu(ctxMenu);
  });
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle('config:get', () => config.display);

  ipcMain.on('post:consumed', () => {
    if (pendingInRenderer <= 0) {
      console.warn(
        '[ipc] post:consumed received but pendingInRenderer is already 0 — counter desync',
      );
    }
    pendingInRenderer = Math.max(0, pendingInRenderer - 1);
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });

  app.whenReady().then(async () => {
    const userDataDir = app.getPath('userData');
    setupLogging(userDataDir);
    cfgPath = path.join(userDataDir, 'config.json');
    const loaded = loadConfig();
    if (!loaded) {
      // L6: was a silent quit — inform the user so the app doesn't just vanish.
      new Notification({
        title: 'Bluesky Overlay',
        body: 'Config file created. Fill in your handle and app password, then relaunch.',
      }).show();
      setTimeout(() => app.quit(), 500);
      return;
    }
    config = loaded;

    if (!config.auth.handle || !config.auth.appPassword) {
      openConfig();
      // L6: was a silent quit — explain why the app is closing.
      new Notification({
        title: 'Bluesky Overlay',
        body: 'Credentials missing. Add your handle and app password to config.json, then relaunch.',
      }).show();
      setTimeout(() => app.quit(), 500);
      return;
    }

    console.log(
      `[dedup] Fresh deduplication filter (${seenSet.size} entries)`,
    );

    const authOk = await authenticate();
    feedSource = await resolveFeedSourceDid(
      parseSource(config.advanced.customFeedUri),
    );
    logSource('startup', feedSource);

    createWindow();
    createTray();
    registerIpc();

    win!.webContents.once('did-finish-load', () => {
      win?.webContents.send('config:update', config.display);
      if (authOk && agent?.session) fetchPosts();
    });

    watchConfig();
  });

  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    watcher?.close();
    stopTopHeartbeat();
    cancelIdle();
    stopDisplay();
    closeLogging();
  });
}
