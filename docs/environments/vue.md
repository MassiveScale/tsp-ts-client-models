# Using in Vue

The generated client works in Vue 3 projects (Vite, Nuxt, or plain Vue CLI). Native `fetch` is available in all modern browsers and in Node.js 18+ for SSR.

## Installation

```bash
npm install @my-org/my-api-client
```

## Composable pattern

The recommended approach in Vue 3 is a composable that wraps the client and exposes reactive state:

```typescript
// src/composables/useWidgets.ts
import { ref } from "vue";
import { WidgetsClient, type Widget, ApiError } from "@my-org/my-api-client";

const client = new WidgetsClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL,
});

export function useWidgets() {
  const widgets = ref<Widget[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchWidgets() {
    loading.value = true;
    error.value = null;
    try {
      widgets.value = await client.list();
    } catch (err) {
      error.value =
        err instanceof ApiError
          ? `${err.status}: ${err.statusText}`
          : String(err);
    } finally {
      loading.value = false;
    }
  }

  return { widgets, loading, error, fetchWidgets };
}
```

```vue
<!-- src/components/WidgetList.vue -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useWidgets } from "@/composables/useWidgets";

const { widgets, loading, error, fetchWidgets } = useWidgets();
onMounted(fetchWidgets);
</script>

<template>
  <p v-if="loading">Loading…</p>
  <p v-else-if="error">Error: {{ error }}</p>
  <ul v-else>
    <li v-for="widget in widgets" :key="widget.id">{{ widget.name }}</li>
  </ul>
</template>
```

## Pinia store

For state shared across many components, put the client in a Pinia store:

```bash
npm install pinia
```

```typescript
// src/stores/widgets.ts
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  WidgetsClient,
  type Widget,
  type WidgetPostRequest,
} from "@my-org/my-api-client";

const client = new WidgetsClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL,
});

export const useWidgetStore = defineStore("widgets", () => {
  const items = ref<Widget[]>([]);
  const loading = ref(false);

  async function fetchAll() {
    loading.value = true;
    try {
      items.value = await client.list();
    } finally {
      loading.value = false;
    }
  }

  async function create(body: WidgetPostRequest) {
    const created = await client.create(body);
    items.value.push(created);
    return created;
  }

  async function remove(id: string) {
    await client.remove(id);
    items.value = items.value.filter((w) => w.id !== id);
  }

  return { items, loading, fetchAll, create, remove };
});
```

```vue
<script setup lang="ts">
import { onMounted } from "vue";
import { useWidgetStore } from "@/stores/widgets";

const store = useWidgetStore();
onMounted(store.fetchAll);
</script>

<template>
  <ul>
    <li v-for="widget in store.items" :key="widget.id">
      {{ widget.name }}
      <button @click="store.remove(widget.id)">Delete</button>
    </li>
  </ul>
</template>
```

## provide / inject for the client instance

If you need the client accessible throughout the component tree without a state store, use `provide`/`inject`:

```typescript
// src/main.ts
import { createApp, InjectionKey } from "vue";
import { WidgetsClient } from "@my-org/my-api-client";
import App from "./App.vue";

export const WIDGETS_CLIENT_KEY: InjectionKey<WidgetsClient> =
  Symbol("widgetsClient");

const app = createApp(App);
app.provide(
  WIDGETS_CLIENT_KEY,
  new WidgetsClient({ baseUrl: import.meta.env.VITE_API_BASE_URL }),
);
app.mount("#app");
```

```vue
<script setup lang="ts">
import { inject } from "vue";
import { WIDGETS_CLIENT_KEY } from "@/main";

const client = inject(WIDGETS_CLIENT_KEY)!;
const widgets = await client.list();
</script>
```

## Nuxt 3

In Nuxt, use `useFetch` or `$fetch` for SSR-aware data fetching, or call the client inside `useAsyncData`:

```typescript
// composables/useWidgets.ts (Nuxt auto-imported)
import { WidgetsClient } from "@my-org/my-api-client";

export function useWidgets() {
  const client = new WidgetsClient({
    baseUrl: useRuntimeConfig().public.apiBaseUrl,
  });

  return useAsyncData("widgets", () => client.list());
}
```

```vue
<script setup lang="ts">
const { data: widgets } = await useWidgets();
</script>
```

In `nuxt.config.ts`, expose the URL via `runtimeConfig`:

```typescript
export default defineNuxtConfig({
  runtimeConfig: {
    public: { apiBaseUrl: process.env.NUXT_PUBLIC_API_BASE_URL },
  },
});
```

## Cancellation

Pass an `AbortSignal` for route navigation guards or `onBeforeUnmount` cleanup:

```typescript
const controller = new AbortController();
onBeforeUnmount(() => controller.abort());

const data = await client.list({ signal: controller.signal });
```
