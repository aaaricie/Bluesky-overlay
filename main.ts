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
let isRepositioning = false;

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
  const maxX = workArea.x + workArea.width - WINDOW_WIDTH;
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
      overflowGuard: {
        enabled: true,
        maxHeightPercent: 100,
      },
    },
    advanced: { fetchLimit: 10, customFeedUri: '' },
  };
}

function writeConfig(c: AppConfig): void {
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
  );
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
      const res = await fetch(url);
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
  const avatarPromises: Promise<string | null>[] = [];
  for (const item of items) {
    avatarPromises.push(
      resolveAvatar(item.post.author.did, item.post.author.avatar),
    );
    const pp = item.reply?.parent;
    if (pp?.record) {
      avatarPromises.push(
        resolveAvatar(pp.author.did, pp.author.avatar),
      );
    }
  }
  await Promise.all(avatarPromises);
  if (gen !== fetchGen) return [];

  const fresh: OverlayPost[] = [];

  for (const item of items) {
    const { post, reply, reason } = item;
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
          avatarDataUri: await resolveAvatar(pp.author.did, pp.author.avatar),
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
        avatarDataUri: await resolveAvatar(
          post.author.did,
          post.author.avatar,
        ),
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

async function fetchFromSource(
  source: FeedSource,
  limit: number,
): Promise<any[]> {
  if (!agent?.session) return [];
  switch (source.kind) {
    case 'timeline': {
      const { data } = await agent.getTimeline({ limit });
      return data.feed;
    }
    case 'generator': {
      const { data } = await agent.app.bsky.feed.getFeed({
        feed: source.uri,
        limit,
      });
      return data.feed;
    }
    case 'list': {
      const { data } = await agent.app.bsky.feed.getListFeed({
        list: source.uri,
        limit,
      });
      return data.feed;
    }
  }
}

async function fetchPosts(): Promise<void> {
  if (fetchBusy || !agent?.session) return;
  fetchBusy = true;
  const gen = fetchGen;

  try {
    const items = await fetchFromSource(
      feedSource,
      config.advanced.fetchLimit,
    );
    if (gen !== fetchGen) return;

    console.log(
      `[fetch] ${feedSource.kind} returned ${items.length} item(s)`,
    );

    const fresh = await processFeedItems(items, gen);
    if (gen !== fetchGen) return;

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
      dispTimer = setTimeout(pump, 200);
      return;
    }
    fetchPosts();
    return;
  }
  pendingInRenderer++;
  win?.webContents.send('post:new', queue.shift()!);
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

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
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
        width: WINDOW_WIDTH,
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
      console.log('[window] Topmost revoked by OS — re-asserting');
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

  createWindow();

  win!.webContents.once('did-finish-load', () => {
    win?.webContents.send('config:update', config.display);
    if (queue.length > 0) {
      startDisplay();
    } else {
      fetchPosts();
    }
  });

  feedSource = await resolveFeedSourceDid(
    parseSource(config.advanced.customFeedUri),
  );
  logSource('source', feedSource);
}

// ─── Config File Watcher ─────────────────────────────────────────────────────

function watchConfig(): void {
  watcher?.close();
  let bounce: ReturnType<typeof setTimeout> | null = null;
  watcher = fs.watch(cfgPath, () => {
    if (bounce) clearTimeout(bounce);
    bounce = setTimeout(() => {
      bounce = null;
      if (fs.existsSync(cfgPath)) reloadConfig();
    }, 500);
  });
  watcher.on('error', (err) => console.error('[watch]', err));
}

async function reloadConfig(): Promise<void> {
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
    const ok = await authenticate();
    if (ok) fetchPosts();
  } else {
    cancelIdle();
    queue.length = 0;
    clearSeen();
    fetchBusy = false;
  }

  await applyDisplay();

  // Re-arm the watcher: editors that perform atomic saves (write-to-temp +
  // rename) change the file's inode, which causes fs.watch to silently stop
  // firing after the first reload.
  watchConfig();
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
    cfgPath = path.join(app.getPath('userData'), 'config.json');
    const loaded = loadConfig();
    if (!loaded) { app.quit(); return; }
    config = loaded;

    if (!config.auth.handle || !config.auth.appPassword) {
      openConfig();
      app.quit();
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
  });
}