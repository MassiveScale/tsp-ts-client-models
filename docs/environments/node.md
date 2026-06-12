# Using in Node.js

The generated client uses native `fetch`, which is available by default in Node.js 18 and later. No polyfills or extra dependencies are required.

## Setup

Install the generated package:

```bash
npm install @my-org/my-api-client
```

## ESM (recommended)

The generated package is ESM-only (`"type": "module"`). Import it with standard ESM syntax:

```typescript
// src/widgets.ts
import { WidgetsClient, ApiError } from "@my-org/my-api-client";

const client = new WidgetsClient({ baseUrl: "https://api.example.com" });

async function run() {
  try {
    const widgets = await client.list();
    console.log(widgets);
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`HTTP ${err.status}:`, err.body);
    }
    throw err;
  }
}

run();
```

## CJS projects

If your project uses CommonJS (`require`), use a dynamic `import()` at the call site:

```javascript
// Legacy CJS file
async function getWidgets() {
  const { WidgetsClient } = await import("@my-org/my-api-client");
  const client = new WidgetsClient({ baseUrl: "https://api.example.com" });
  return client.list();
}
```

Alternatively, add `"type": "module"` to your `package.json` and use `.mjs` extensions where needed.

## Node.js 17 and older

Node.js 16 does not have built-in `fetch`. Polyfill it globally before instantiating any client:

```bash
npm install node-fetch
```

```typescript
import fetch from "node-fetch";

// Apply the polyfill before any client code runs.
(globalThis as any).fetch = fetch;

import { WidgetsClient } from "@my-org/my-api-client";
// ...
```

Node.js 16 reaches end-of-life in September 2023. Upgrading to Node.js 18+ is strongly recommended.

## Timeout and signal

```typescript
// Global timeout via config
const client = new WidgetsClient({
  baseUrl: "https://api.example.com",
  timeout: 8_000,
});

// Per-call timeout via AbortSignal (Node.js 17.3+)
const widget = await client.read("abc123", {
  signal: AbortSignal.timeout(3_000),
});
```

## Using with TypeScript

Add the generated package as a dev dependency in your `tsconfig.json` path mappings if you reference it locally:

```json
{
  "compilerOptions": {
    "moduleResolution": "NodeNext",
    "paths": {
      "@my-org/my-api-client": ["./tsp-output/client/dist/index.d.ts"]
    }
  }
}
```

Or simply `npm install` the published version and TypeScript resolves it from `node_modules` automatically.
