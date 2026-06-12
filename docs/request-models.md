# Request Models

When an operation has a body parameter whose model contains read-only or lifecycle-scoped properties, the emitter generates a dedicated **request type** that strips those properties out. This ensures the type you pass to a `create` or `update` call never asks you to provide server-managed fields like `id` or `createdAt`.

## Naming convention

Request type names follow the pattern `{BodyModelName}{HttpVerb}Request`, where the HTTP verb is capitalized.

| HTTP method | Generated suffix | Example               |
| ----------- | ---------------- | --------------------- |
| `POST`      | `PostRequest`    | `WidgetPostRequest`   |
| `PATCH`     | `PatchRequest`   | `WidgetPatchRequest`  |
| `PUT`       | `PutRequest`     | `WidgetPutRequest`    |
| `DELETE`    | `DeleteRequest`  | `WidgetDeleteRequest` |

> **Breaking change from 0.2.x:** The old semantic suffixes (`CreateRequest`, `UpdateRequest`, `ReplaceRequest`) are replaced by HTTP-verb suffixes. Update any references in your consuming code.

## When a request type is generated

A request type is generated when the operation body model has **at least one property excluded** by the operation's effective visibility. A request type is **not** generated when all properties are writable — the raw model is used directly.

```typespec
model Widget {
  @visibility(TypeSpec.Lifecycle.Read)
  id: string;          // excluded from requests
  name: string;        // included in all requests
}

@route("/widgets")
interface Widgets {
  @post create(@body body: Widget): Widget;
  // ↑ generates WidgetPostRequest { name: string }
  // because id is Read-only and excluded
}
```

If all properties of `Widget` were writable (no `@visibility` annotations), no `WidgetPostRequest` would be generated and the operation body type would stay as `Widget`.

## Visibility filtering

TypeSpec's `Lifecycle` visibility phases control which properties appear in each request type:

| Lifecycle phase | What it means                                              |
| --------------- | ---------------------------------------------------------- |
| `Read`          | Returned by the server; excluded from all write operations |
| `Create`        | Accepted on POST but not PATCH/PUT                         |
| `Update`        | Accepted on PATCH/PUT but not POST                         |

The emitter resolves visibility using the HTTP operation's verb:

- `POST` → Create phase
- `PATCH` → Update phase
- `PUT` → Create + Update phases

Properties annotated `@visibility(TypeSpec.Lifecycle.Read)` are always excluded. Properties annotated `@visibility(TypeSpec.Lifecycle.Create)` are excluded from `PatchRequest` and `PutRequest`. Properties with no `@visibility` annotation are included in all request types.

```typespec
model Item {
  @visibility(TypeSpec.Lifecycle.Read)
  id: string;                                           // excluded everywhere

  @visibility(TypeSpec.Lifecycle.Read, TypeSpec.Lifecycle.Create)
  tenantId: string;                                     // excluded from PatchRequest

  name: string;                                         // included everywhere
}
```

## MergePatch operations

When an operation body is a `MergePatchUpdate<T>` type from `@typespec/rest`, the emitter uses the synthesized model's properties directly (all already optional) and generates a `{BaseName}PatchRequest`.

```typespec
import "@typespec/rest";
using Rest;

@patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
// ↑ generates WidgetPatchRequest { name?: string }
```

The base model name is extracted from known MergePatch type suffixes (`MergePatchUpdate`, `MergePatchUpdateReplaceOnly`, `MergePatchCreateOrUpdate`).

## Collision detection

If two operations with the same HTTP verb on the same body model produce request types with **different property shapes**, the names collide. The emitter resolves this automatically using `@tag` to prefix each name.

```typespec
@route("/widgets")
interface Widgets {
  @tag("Standard")
  @patch update(@path id: string, @body body: Widget): Widget;
  // → StandardWidgetPatchRequest { name: string }
}

@route("/admin/widgets")
interface AdminWidgets {
  @tag("Admin")
  @patch
  @parameterVisibility(TypeSpec.Lifecycle.Create, TypeSpec.Lifecycle.Update)
  update(@path id: string, @body body: Widget): Widget;
  // → AdminWidgetPatchRequest { name: string; tenantId: string }
}
```

If a collision is detected and **any** of the conflicting operations has no `@tag`, the emitter reports a `request-type-collision` diagnostic error:

```
error @massivescale/tsp-ts-client-models/request-type-collision:
  Request type "WidgetPatchRequest" collision: operation "update" has no @tag
  for disambiguation. Add @tag to all conflicting operations.
```

Fix it by adding a `@tag` to both (or all) conflicting operations.

## Identical shapes are deduplicated

When two operations produce a request type with the **same name and the same property keys**, they are treated as the same type — only one is emitted and no diagnostic is raised. This is the common case for operations that share a body model across interfaces.
