# Using in SvelteKit

The generated client works in both SvelteKit's server-side `load` functions and in client-side Svelte components. Node.js 18+ provides native `fetch` in SvelteKit's server runtime, and all modern browsers provide it on the client.

## Installation

```bash
npm install @my-org/my-api-client
```

## Using in a server load function

`+page.server.ts` runs only on the server. Pass data down to the component via the returned object:

```typescript
// src/routes/widgets/+page.server.ts
import type { PageServerLoad } from "./$types";
import { WidgetsClient, ApiError } from "@my-org/my-api-client";
import { error } from "@sveltejs/kit";
import { env } from "$env/static/private";

const client = new WidgetsClient({ baseUrl: env.API_BASE_URL });

export const load: PageServerLoad = async () => {
  try {
    const widgets = await client.list();
    return { widgets };
  } catch (err) {
    if (err instanceof ApiError) {
      throw error(err.status, err.statusText);
    }
    throw err;
  }
};
```

```svelte
<!-- src/routes/widgets/+page.svelte -->
<script lang="ts">
  import type { PageData } from "./$types";
  export let data: PageData;
</script>

<ul>
  {#each data.widgets as widget}
    <li>{widget.name}</li>
  {/each}
</ul>
```

## Using in a universal load function

`+page.ts` runs on both server and client. SvelteKit provides its own `fetch` wrapper that you should use on the server side; pass it to the client via `RequestOptions.signal` workaround isn't available, so use a plain client for universal loads or pass custom headers as needed:

```typescript
// src/routes/widgets/[id]/+page.ts
import type { PageLoad } from "./$types";
import { WidgetsClient } from "@my-org/my-api-client";

export const load: PageLoad = async ({ params }) => {
  const client = new WidgetsClient({ baseUrl: "/api" });
  const widget = await client.read(params.id);
  return { widget };
};
```

## Client-side store with reactive data

For client-side fetching, create a Svelte store:

```typescript
// src/lib/stores/widgets.ts
import { writable } from "svelte/store";
import { WidgetsClient, type Widget } from "@my-org/my-api-client";

const client = new WidgetsClient({ baseUrl: "/api" });

export const widgets = writable<Widget[]>([]);
export const widgetsLoading = writable(false);
export const widgetsError = writable<string | null>(null);

export async function loadWidgets() {
  widgetsLoading.set(true);
  widgetsError.set(null);
  try {
    widgets.set(await client.list());
  } catch (err) {
    widgetsError.set(String(err));
  } finally {
    widgetsLoading.set(false);
  }
}
```

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { widgets, widgetsLoading, widgetsError, loadWidgets } from "$lib/stores/widgets";

  onMount(loadWidgets);
</script>

{#if $widgetsLoading}
  <p>Loading…</p>
{:else if $widgetsError}
  <p>Error: {$widgetsError}</p>
{:else}
  <ul>
    {#each $widgets as widget}
      <li>{widget.name}</li>
    {/each}
  </ul>
{/if}
```

## Skeleton UI integration

[Skeleton](https://www.skeleton.dev/) is a UI framework built on SvelteKit and Tailwind. The client integrates naturally with Skeleton's modal and drawer stores for create/edit workflows:

```svelte
<script lang="ts">
  import { getModalStore } from "@skeletonlabs/skeleton";
  import { WidgetsClient, type WidgetPostRequest } from "@my-org/my-api-client";

  const modalStore = getModalStore();
  const client = new WidgetsClient({ baseUrl: "/api" });

  async function openCreateModal() {
    modalStore.trigger({
      type: "confirm",
      title: "Create Widget",
      body: "Enter the widget name below.",
      response: async (confirmed: boolean) => {
        if (!confirmed) return;
        const payload: WidgetPostRequest = { name: "New Widget" };
        await client.create(payload);
      },
    });
  }
</script>

<button class="btn variant-filled-primary" on:click={openCreateModal}>
  New Widget
</button>
```

## Environment variables

Use SvelteKit's `$env` modules to keep base URLs out of client-side bundles:

```typescript
// +page.server.ts
import { env } from "$env/static/private"; // Server-only
const client = new WidgetsClient({ baseUrl: env.API_BASE_URL });
```

```typescript
// +page.ts (universal)
import { PUBLIC_API_BASE_URL } from "$env/static/public"; // Safe for browser
const client = new WidgetsClient({ baseUrl: PUBLIC_API_BASE_URL });
```
