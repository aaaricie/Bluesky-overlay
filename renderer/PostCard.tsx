import { memo } from 'react';
import type { OverlayPost, ParentPost } from './types';

/* ── Types ─────────────────────────────────────────────────────────── */

interface Segment {
  start: number;
  end: number;
  type: 'text' | 'link' | 'mention' | 'tag';
  href?: string;
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function byteToCharIndex(text: string, byteOffset: number): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byteOffset) return i;
    const cp = text.codePointAt(i)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (cp > 0xffff) i++;
  }
  return text.length;
}

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/* ── Rich Text ─────────────────────────────────────────────────────── */

function RichText({ text, facets }: { text: string; facets: unknown[] }) {
  if (!text) return null;
  if (!facets?.length) return <div className="post-text">{text}</div>;

  const segments: Segment[] = [];
  const sorted = [...(facets as any[])].sort(
    (a, b) => (a.index?.byteStart ?? 0) - (b.index?.byteStart ?? 0),
  );

  let cursor = 0;
  for (const f of sorted) {
    const bs = f.index?.byteStart ?? 0;
    const be = f.index?.byteEnd ?? 0;
    const cs = byteToCharIndex(text, bs);
    const ce = byteToCharIndex(text, be);
    if (cs > cursor) segments.push({ start: cursor, end: cs, type: 'text' });
    const feat = f.features?.[0];
    if (feat?.$type === 'app.bsky.richtext.facet#link') {
      segments.push({ start: cs, end: ce, type: 'link', href: feat.uri });
    } else if (feat?.$type === 'app.bsky.richtext.facet#mention') {
      segments.push({ start: cs, end: ce, type: 'mention' });
    } else if (feat?.$type === 'app.bsky.richtext.facet#tag') {
      segments.push({ start: cs, end: ce, type: 'tag' });
    } else {
      segments.push({ start: cs, end: ce, type: 'text' });
    }
    cursor = ce;
  }
  if (cursor < text.length)
    segments.push({ start: cursor, end: text.length, type: 'text' });

  return (
    <div className="post-text">
      {segments.map((s, i) => {
        const slice = text.slice(s.start, s.end);
        switch (s.type) {
          case 'link':
            return <span key={i} className="facet-link">{slice}</span>;
          case 'mention':
            return <span key={i} className="facet-mention">{slice}</span>;
          case 'tag':
            return <span key={i} className="facet-tag">{slice}</span>;
          default:
            return <span key={i}>{slice}</span>;
        }
      })}
    </div>
  );
}

/* ── Embeds ─────────────────────────────────────────────────────────── */

function EmbedView({
  embed,
  measureMode = false,
}: {
  embed: unknown | null;
  measureMode?: boolean;
}) {
  if (!embed) return null;
  const e = embed as any;

  if (e.$type === 'app.bsky.embed.images#view') {
    const images = e.images ?? [];
    return (
      <div className={`embed-images grid-${Math.min(images.length, 4)}`}>
        {images.map((img: any, i: number) => (
          <div key={i} className="embed-image-wrapper">
            <img
              className="embed-image"
              src={img.thumb}
              alt={img.alt ?? ''}
              loading={measureMode ? 'eager' : 'lazy'}
            />
          </div>
        ))}
      </div>
    );
  }

  if (e.$type === 'app.bsky.embed.external#view') {
    const ext = e.external;
    let hostname = '';
    try { hostname = new URL(ext.uri).hostname; } catch { hostname = ext.uri; }
    return (
      <div className="embed-external">
        {ext.thumb && (
          <img
            className="embed-external-thumb"
            src={ext.thumb}
            alt=""
            loading={measureMode ? 'eager' : 'lazy'}
          />
        )}
        <div className="embed-external-info">
          <div className="embed-external-title">{ext.title}</div>
          {ext.description && (
            <div className="embed-external-desc">{ext.description}</div>
          )}
          <div className="embed-external-uri">{hostname}</div>
        </div>
      </div>
    );
  }

  if (e.$type === 'app.bsky.embed.record#view') {
    const rec = e.record;
    if (!rec || rec.$type === 'app.bsky.embed.record#viewNotFound')
      return (
        <div className="embed-quote">
          <span className="embed-quote-unavailable">Post not found</span>
        </div>
      );
    if (rec.$type === 'app.bsky.embed.record#viewBlocked')
      return (
        <div className="embed-quote">
          <span className="embed-quote-unavailable">Blocked post</span>
        </div>
      );
    const qAuthor = rec.author ?? {};
    const qRec = rec.value as Record<string, unknown> | undefined;
    const qEmbeds = rec.embeds as unknown[] | undefined;
    const qCreatedAt = (qRec?.createdAt ?? rec.indexedAt) as string | undefined;
    return (
      <div className="embed-quote">
        <div className="embed-quote-author">
          {qAuthor.avatar && (
            <img
              className="embed-quote-avatar"
              src={qAuthor.avatar}
              alt=""
              loading={measureMode ? 'eager' : 'lazy'}
            />
          )}
          <span className="display-name">{qAuthor.displayName ?? qAuthor.handle}</span>
          <span className="handle">@{qAuthor.handle}</span>
          {qCreatedAt && (
            <span className="timestamp">· {relativeTime(qCreatedAt)}</span>
          )}
        </div>
        {qRec?.text && <div className="post-text">{qRec.text as string}</div>}
        {qEmbeds?.[0] && (
          <div className="embed-quote-media">
            <EmbedView embed={qEmbeds[0]} measureMode={measureMode} />
          </div>
        )}
      </div>
    );
  }

  if (e.$type === 'app.bsky.embed.recordWithMedia#view') {
    return (
      <>
        <EmbedView embed={e.media} measureMode={measureMode} />
        <EmbedView
          embed={e.record ? { ...e.record, $type: 'app.bsky.embed.record#view' } : null}
          measureMode={measureMode}
        />
      </>
    );
  }

  if (e.$type === 'app.bsky.embed.video#view') {
    return (
      <div className="embed-video">
        {e.thumbnail && (
          <img
            className="embed-video-thumb"
            src={e.thumbnail}
            alt=""
            loading={measureMode ? 'eager' : 'lazy'}
          />
        )}
        <div className="embed-video-play">▶</div>
      </div>
    );
  }

  return null;
}

/* ── Thread Parent ─────────────────────────────────────────────────── */

function ThreadParent({
  parent,
  measureMode = false,
}: {
  parent: ParentPost;
  measureMode?: boolean;
}) {
  const src = parent.author.avatarDataUri ?? parent.author.avatarUrl;
  return (
    <div className="thread-parent">
      <div className="thread-parent-left">
        {src
          ? <img className="post-avatar thread-parent-avatar" src={src} alt="" />
          : <div className="post-avatar post-avatar-placeholder thread-parent-avatar" />}
        <div className="thread-line" />
      </div>
      <div className="thread-parent-content">
        <div className="post-author-line">
          <span className="display-name">{parent.author.displayName}</span>
          <span className="handle">@{parent.author.handle}</span>
          <span className="timestamp">· {relativeTime(parent.createdAt)}</span>
        </div>
        <RichText text={parent.text} facets={parent.facets} />
        {parent.embed && (
          <div className="post-embed">
            <EmbedView embed={parent.embed} measureMode={measureMode} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── PostCard ──────────────────────────────────────────────────────── */

function PostCard({
  post,
  measureMode = false,
}: {
  post: OverlayPost;
  measureMode?: boolean;
}) {
  const avatarSrc = post.author.avatarDataUri ?? post.author.avatarUrl;

  return (
    <div className="post-card-frame">
      <div className="post-card">
        {post.repostBy && (
          <div className="repost-indicator">🔁 {post.repostBy.displayName} reposted</div>
        )}

        {post.parent && (
          <ThreadParent parent={post.parent} measureMode={measureMode} />
        )}

        <div className="post-main">
          <div className="post-avatar-col">
            {avatarSrc
              ? <img className="post-avatar" src={avatarSrc} alt={post.author.displayName} />
              : <div className="post-avatar post-avatar-placeholder" />}
          </div>
          <div className="post-content-col">
            <div className="post-author-line">
              <span className="display-name">{post.author.displayName}</span>
              <span className="handle">@{post.author.handle}</span>
              <span className="timestamp">· {relativeTime(post.createdAt)}</span>
            </div>

            <RichText text={post.text} facets={post.facets} />

            {post.embed && (
              <div className="post-embed">
                <EmbedView embed={post.embed} measureMode={measureMode} />
              </div>
            )}

            <div className="post-engagement">
              <span className="engagement-item">💬 {compact(post.replyCount)}</span>
              <span className="engagement-item">🔁 {compact(post.repostCount)}</span>
              <span className="engagement-item">♡ {compact(post.likeCount)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(PostCard);