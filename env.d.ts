/// <reference types="vite/client" />

import type { OverlayPost, DisplayConfig } from './types';

export {};

declare global {
  interface Window {
    electronAPI: {
      onNewPost: (cb: (post: OverlayPost) => void) => () => void;
      onConfigUpdate: (cb: (display: DisplayConfig) => void) => () => void;
      getConfig: () => Promise<DisplayConfig>;
      /** Signal to main that a post has been consumed (admitted or skipped). */
      postConsumed: () => void;
    };
  }
}