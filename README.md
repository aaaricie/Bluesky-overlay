# Bluesky Overlay - Release v1.0.0

Desktop overlay application that displays your Bluesky feed as rolling timeline notifications on top of other applications.

## Features

- **Always-on-top overlay** with configurable positioning and click-through mode
- **Multiple feed sources**: timeline, custom feeds, or lists via AT-URI or bsky.app URLs
- **Animated post display** with configurable slot count and display duration
- **Rich content support**: images, external links, quoted posts, videos, reply threads
- **Overflow guard** prevents overlay from exceeding screen height limits
- **Real-time config reloading** without app restart
- **Encrypted credential storage** using OS keychain
- **System tray integration** with context menu
- **Automatic deduplication** and rate limit handling

## Installation

### **You can either clone the repository or use the setup.exe** Everything needed to run it is included with the installer.

### Prerequisites
- Node.js 18+
- Bluesky account with app password

### Setup

1. Clone repository and install dependencies:
```bash
npm install
```

2. Run the app - it will create `config.json` in your user data directory and open it for editing:
```bash
npm run dev
```

3. Configure your credentials and preferences in `config.json`:
```json
{
  "auth": {
    "handle": "your-handle.bsky.social",
    "appPassword": "your-app-password"
  },
  "display": {
    "slotCount": 10,
    "postDisplaySeconds": 30,
    "position": { "x": 100, "y": 100 },
    "clickThrough": true,
    "overflowGuard": {
      "enabled": true,
      "maxHeightPercent": 100
    }
  },
  "advanced": {
    "fetchLimit": 10,
    "customFeedUri": ""
  }
}
```

## Configuration

### Authentication
- `handle`: Your Bluesky handle
- `appPassword`: Generate at bsky.app → Settings → App Passwords

### Display Settings
- `slotCount`: Number of simultaneous posts (1-100)
- `postDisplaySeconds`: Total display time per post cycle
- `position`: Window position `{x, y}`
- `clickThrough`: Enable mouse click passthrough
- `overflowGuard.enabled`: Prevent posts from exceeding screen height
- `overflowGuard.maxHeightPercent`: Maximum screen height usage (1-100%)

### Advanced Options
- `fetchLimit`: Posts per API request (1-100)
- `customFeedUri`: Custom feed source (AT-URI or bsky.app URL)

### Feed Sources
Supports multiple feed types:
- **Timeline**: Default following feed (leave `customFeedUri` empty)
- **Custom feeds**: `at://did:plc:*/app.bsky.feed.generator/*` or `bsky.app/profile/*/feed/*`
- **Lists**: `at://did:plc:*/app.bsky.graph.list/*` or `bsky.app/profile/*/lists/*`

## Development

### Scripts
```bash
npm run dev          # Development with hot reload
npm run build        # Build for production
npm run start        # Run built application
npm run dist         # Create Windows installer
```

### Tech Stack
- **Electron** + **React** + **TypeScript**
- **Vite** for renderer bundling
- **Framer Motion** for animations
- **AT Protocol API** for Bluesky integration

### Architecture
- **Main process**: Handles authentication, feed fetching, window management, config watching
- **Renderer process**: React UI with post display, animations, overflow management
- **IPC communication**: Config updates and post streaming between processes
- **Real-time updates**: File watcher monitors config changes and reloads automatically

## System Requirements
- Windows (primary target, includes installer)
- macOS/Linux (untested but should work)
