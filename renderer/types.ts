export interface PostAuthor {
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  avatarDataUri: string | null;
}

export interface ParentPost {
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

export interface OverlayPost {
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

export interface DisplayConfig {
  slotCount: number;
  postDisplaySeconds: number;
  position: { x: number; y: number };
  clickThrough: boolean;
  windowWidth: number;
  overflowGuard: {
    enabled: boolean;
    maxHeightPercent: number; // 1–100
  };
}