# Using in Angular

The generated client uses native `fetch` and has no Angular-specific dependencies. The recommended integration is to wrap each generated client in an Angular `Injectable` service, allowing Angular's dependency injection system to manage instantiation and token injection.

## Installation

```bash
npm install @my-org/my-api-client
```

## Wrapping as an Injectable service

```typescript
// src/app/services/widgets.service.ts
import { Injectable } from "@angular/core";
import {
  WidgetsClient,
  Widget,
  WidgetPostRequest,
  ApiError,
} from "@my-org/my-api-client";
import { from, catchError, throwError, Observable } from "rxjs";
import { environment } from "../../environments/environment";

@Injectable({ providedIn: "root" })
export class WidgetsService {
  private readonly client = new WidgetsClient({
    baseUrl: environment.apiBaseUrl,
    retry: { maxAttempts: 3 },
  });

  list(): Observable<Widget[]> {
    return from(this.client.list()).pipe(
      catchError((err) => throwError(() => this.wrapError(err))),
    );
  }

  read(id: string): Observable<Widget> {
    return from(this.client.read(id)).pipe(
      catchError((err) => throwError(() => this.wrapError(err))),
    );
  }

  create(body: WidgetPostRequest): Observable<Widget> {
    return from(this.client.create(body)).pipe(
      catchError((err) => throwError(() => this.wrapError(err))),
    );
  }

  private wrapError(err: unknown): Error {
    if (err instanceof ApiError) {
      return new Error(`API error ${err.status}: ${err.statusText}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
```

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
import { WidgetsClient } from "@my-org/my-api-client";

@Injectable({ providedIn: "root" })
export class WidgetsService {
  private readonly client: WidgetsClient;

  constructor(@Inject(API_BASE_URL) baseUrl: string) {
    this.client = new WidgetsClient({ baseUrl });
  }
}
```

## HttpInterceptor pattern

If you need to inject auth tokens dynamically (e.g. from an Angular auth service), pass them per-request rather than at construction time:

```typescript
async list(token: string) {
  return this.client.list({ headers: { Authorization: `Bearer ${token}` } });
}
```

For a global interceptor pattern with `defaultHeaders`, extend `HttpClient` and override the token at each call:

```typescript
import { HttpClient as BaseClient, ClientConfig } from "@my-org/my-api-client";

export class TokenAwareClient extends BaseClient {
  private token = "";

  setToken(t: string) {
    this.token = t;
  }

  protected override async request<T>(
    method: string,
    path: string,
    options?: Parameters<BaseClient["request"]>[2],
  ): Promise<T> {
    return super.request<T>(method, path, {
      ...options,
      headers: { Authorization: `Bearer ${this.token}`, ...options?.headers },
    });
  }
}
```

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
