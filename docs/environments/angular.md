# Using in Angular

The recommended setup for Angular is to generate the **RxJS Observable client** and wrap each generated client in an `Injectable` service, so Angular's dependency injection manages instantiation and the `async` pipe consumes the streams directly — no manual `Promise`→`Observable` bridging.

Set `client-style` in `tspconfig.yaml`:

```yaml
options:
  "@massivescale/tsp-ts-client-models":
    client-style: observable # or "both" to also emit the Promise clients
```

This emits a `{Name}ObservableClient` per interface whose methods return a cold `Observable<T>` (the request fires on `subscribe`; unsubscribing aborts the in-flight `fetch`), and declares `rxjs` as an optional peer dependency of the generated package. See [Observable (RxJS) client](../http-client.md#observable-rxjs-client) for the full semantics.

## Installation

```bash
npm install @my-org/my-api-client
# rxjs is already present in every Angular app
```

## Wrapping as an Injectable service

```typescript
// src/app/services/widgets.service.ts
import { Injectable } from "@angular/core";
import {
  WidgetsObservableClient,
  Widget,
  WidgetPostRequest,
  ApiError,
} from "@my-org/my-api-client";
import { catchError, throwError, Observable } from "rxjs";
import { environment } from "../../environments/environment";

@Injectable({ providedIn: "root" })
export class WidgetsService {
  private readonly client = new WidgetsObservableClient({
    baseUrl: environment.apiBaseUrl,
    retry: { maxAttempts: 3 },
  });

  list(): Observable<Widget[]> {
    return this.client
      .list()
      .pipe(catchError((err) => throwError(() => this.wrapError(err))));
  }

  read(id: string): Observable<Widget> {
    return this.client
      .read(id)
      .pipe(catchError((err) => throwError(() => this.wrapError(err))));
  }

  create(body: WidgetPostRequest): Observable<Widget> {
    return this.client
      .create(body)
      .pipe(catchError((err) => throwError(() => this.wrapError(err))));
  }

  private wrapError(err: unknown): Error {
    if (err instanceof ApiError) {
      return new Error(`API error ${err.status}: ${err.statusText}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
```

The client methods already return `Observable`s, so there is no `from(...)` wrapping — you pipe directly. `ApiError` (and its subclasses) flow through the Observable's error channel, so `catchError` sees the same error types as the Promise client.

> **Your `HttpInterceptor`s do not run for this client yet.** It sends its requests with `fetch`, not Angular's `HttpClient`. To keep your auth, logging and error interceptors, add the adapter below.

## Keeping your HTTP interceptors

Angular runs `HttpInterceptor`s only for requests made through its `HttpClient`. The generated client calls `fetch` directly, so without help an auth interceptor never adds its token and an error interceptor never sees a failure.

Pass an adapter as `config.fetch` to send every request through `HttpClient` instead. Copy `angularFetch` from [Angular `HttpClient` (keeps your interceptors)](../client-extensibility.md#angular-httpclient-keeps-your-interceptors) into your app, then create the client with it:

```typescript
// src/app/services/widgets.service.ts
import { Injectable, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { WidgetsObservableClient } from "@my-org/my-api-client";
import { angularFetch } from "../api/angular-fetch";
import { environment } from "../../environments/environment";

@Injectable({ providedIn: "root" })
export class WidgetsService {
  private readonly client = new WidgetsObservableClient({
    baseUrl: environment.apiBaseUrl,
    fetch: angularFetch(inject(HttpClient)),
  });
}
```

Every interceptor registered with `provideHttpClient(withInterceptors(...))` or `HTTP_INTERCEPTORS` now runs for the generated client, once per attempt. The client still maps error statuses to `ApiError`, applies its retry rules and cancels the request when you unsubscribe. If an interceptor already retries, set `retry: { maxAttempts: 1 }` so a request is not retried twice.

## Using in a component

```typescript
// src/app/widgets/widgets.component.ts
import { Component, OnInit } from "@angular/core";
import { AsyncPipe, NgFor, NgIf } from "@angular/common";
import { Widget } from "@my-org/my-api-client";
import { WidgetsService } from "../services/widgets.service";
import { Observable } from "rxjs";

@Component({
  selector: "app-widgets",
  standalone: true,
  imports: [AsyncPipe, NgFor, NgIf],
  template: `
    <ul *ngIf="widgets$ | async as widgets; else loading">
      <li *ngFor="let w of widgets">{{ w.name }}</li>
    </ul>
    <ng-template #loading>Loading…</ng-template>
  `,
})
export class WidgetsComponent implements OnInit {
  widgets$!: Observable<Widget[]>;

  constructor(private widgetsService: WidgetsService) {}

  ngOnInit(): void {
    this.widgets$ = this.widgetsService.list();
  }
}
```

The `async` pipe subscribes once and unsubscribes automatically when the component is destroyed — which aborts the in-flight request. Because the Observables are **cold**, each subscription issues its own request; if a template subscribes more than once, add `shareReplay(1)` in the service to share a single response.

## Providing the base URL via injection token

Instead of importing `environment` directly inside the service, use an injection token for better testability:

```typescript
// src/app/tokens.ts
import { InjectionToken } from "@angular/core";
export const API_BASE_URL = new InjectionToken<string>("API_BASE_URL");
```

```typescript
// src/app/app.config.ts
import { ApplicationConfig } from "@angular/core";
import { API_BASE_URL } from "./tokens";
import { environment } from "../environments/environment";

export const appConfig: ApplicationConfig = {
  providers: [{ provide: API_BASE_URL, useValue: environment.apiBaseUrl }],
};
```

```typescript
// src/app/services/widgets.service.ts
import { Injectable, Inject } from "@angular/core";
import { API_BASE_URL } from "../tokens";
import { WidgetsObservableClient } from "@my-org/my-api-client";

@Injectable({ providedIn: "root" })
export class WidgetsService {
  private readonly client: WidgetsObservableClient;

  constructor(@Inject(API_BASE_URL) baseUrl: string) {
    this.client = new WidgetsObservableClient({ baseUrl });
  }
}
```

## Injecting auth tokens per request

If an `HttpInterceptor` already adds your token, use the [adapter](#keeping-your-http-interceptors) instead: it lets that interceptor add the token here too.

If you need to inject auth tokens dynamically (e.g. from an Angular auth service), pass them per-request via `RequestOptions.headers`:

```typescript
list(token: string): Observable<Widget[]> {
  return this.client.list(undefined, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
```

For a global token pattern, extend `RxHttpClient` and override the per-request headers:

```typescript
import { RxHttpClient, ClientConfig } from "@my-org/my-api-client";

export class TokenAwareRxClient extends RxHttpClient {
  private token = "";

  setToken(t: string) {
    this.token = t;
  }

  protected override httpGet$<T>(
    path: string,
    options?: Parameters<RxHttpClient["httpGet$"]>[1],
  ) {
    return super.httpGet$<T>(path, {
      ...options,
      headers: { Authorization: `Bearer ${this.token}`, ...options?.headers },
    });
  }
}
```

## Prefer Promises?

If you would rather consume Promises (or use `client-style: promise`, the default), bridge each call with RxJS `from()`:

```typescript
import { from, catchError, throwError } from "rxjs";
import { WidgetsClient } from "@my-org/my-api-client";

const client = new WidgetsClient({ baseUrl: environment.apiBaseUrl });

list(): Observable<Widget[]> {
  return from(client.list()).pipe(catchError((err) => throwError(() => err)));
}
```

Note that `from(promise)` does **not** propagate unsubscribe to the underlying request — use the Observable client (above) when you want unsubscribe-to-cancel.

## Testing

Because the service wraps a plain class, unit tests can substitute a mock client:

```typescript
import { TestBed } from "@angular/core/testing";
import { WidgetsService } from "./widgets.service";
import { API_BASE_URL } from "../tokens";

describe("WidgetsService", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: API_BASE_URL, useValue: "http://localhost:4200" }],
    });
  });

  it("should create", () => {
    const service = TestBed.inject(WidgetsService);
    expect(service).toBeTruthy();
  });
});
```
