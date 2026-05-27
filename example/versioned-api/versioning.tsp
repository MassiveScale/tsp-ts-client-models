import "@typespec/versioning";

using Versioning;

@versioned(Versions)
namespace MassiveScale.Sandbox.Api;

enum Versions {
  v1_0: "v1.0",
  v2_0: "v2.0",
}
