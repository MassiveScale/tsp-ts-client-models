# Using in React

The generated client works in React projects with no extra configuration. Native `fetch` is available in all modern browsers and in the Node.js runtimes used by React frameworks (Next.js, Remix, Vite SSR).

## Installation

```bash
npm install @my-org/my-api-client
```

## Plain useEffect

For simple one-off fetches, use the client inside `useEffect`:

```typescript
import { useEffect, useState } from "react";
import { WidgetsClient, Widget, ApiError } from "@my-org/my-api-client";

const client = new WidgetsClient({ baseUrl: "/api" });

function WidgetList() {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    client
      .list({ signal: controller.signal })
      .then(setWidgets)
      .catch((err) => {
        if (err instanceof ApiError) setError(`${err.status}: ${err.statusText}`);
      });

    return () => controller.abort(); // cancel on unmount
  }, []);

  if (error) return <p>Error: {error}</p>;
  return <ul>{widgets.map((w) => <li key={w.id}>{w.name}</li>)}</ul>;
}
```

## TanStack Query (React Query)

TanStack Query is the recommended approach for data fetching in React. The generated client integrates directly as a query function:

```bash
npm install @tanstack/react-query
```

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { WidgetsClient, WidgetPostRequest } from "@my-org/my-api-client";

const client = new WidgetsClient({ baseUrl: "/api" });

// List query
export function useWidgets() {
  return useQuery({
    queryKey: ["widgets"],
    queryFn: () => client.list(),
  });
}

// Single-item query
export function useWidget(id: string) {
  return useQuery({
    queryKey: ["widgets", id],
    queryFn: () => client.read(id),
    enabled: !!id,
  });
}

// Create mutation
export function useCreateWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: WidgetPostRequest) => client.create(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["widgets"] }),
  });
}
```

```typescript
// Component usage
function WidgetList() {
  const { data: widgets, isLoading, error } = useWidgets();
  const createWidget = useCreateWidget();

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>Error: {String(error)}</p>;

  return (
    <>
      <button onClick={() => createWidget.mutate({ name: "New Widget" })}>
        Add
      </button>
      <ul>{widgets?.map((w) => <li key={w.id}>{w.name}</li>)}</ul>
    </>
  );
}
```

## SWR

```bash
npm install swr
```

```typescript
import useSWR from "swr";
import { WidgetsClient } from "@my-org/my-api-client";

const client = new WidgetsClient({ baseUrl: "/api" });

export function useWidget(id: string) {
  return useSWR(["widgets", id], () => client.read(id));
}
```

## Shared client instance

Create the client once (outside any component) and share it via React Context or a module singleton:

```typescript
// lib/api.ts
import { WidgetsClient } from "@my-org/my-api-client";

export const widgetsClient = new WidgetsClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL,
  retry: { maxAttempts: 2 },
});
```

For auth tokens that change at runtime, extend the client rather than recreating it:

```typescript
import { HttpClient, ClientConfig } from "@my-org/my-api-client";

export class AuthClient extends HttpClient {
  constructor(config: Omit<ClientConfig, "defaultHeaders">) {
    super(config);
  }
  setToken(token: string) {
    // Override protected config at runtime
    (this as any).config.defaultHeaders = { Authorization: `Bearer ${token}` };
  }
}
```
