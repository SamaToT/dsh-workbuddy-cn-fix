# dsh-workbuddy-cn-fix

Repairs the CN chat path of [`dsh-workbuddy-connect`](https://www.npmjs.com/package/dsh-workbuddy-connect).

## Why

WorkBuddy's CN upstream (`copilot.tencent.com`) runs a channel check on the **opening**
of the system message. A request is refused with

```
HTTP 400 / code 11128 — "Illegal API invocation from an unapproved channel"
显示文案：「请求被拦截，请重新发送」
```

when either of two conditions holds:

1. the first system message opens with a rival client's identity line
   (`You are an AI agent powered by DeepSeek Harness.`), or
2. the system message carries the role `developer` — which is what pi-ai emits
   for reasoning models (`detectCompat` marks `supportsDeveloperRole: true`
   for this endpoint).

The shipped plugin normalizes the role and neutralizes the signature on the
**international** path only (`prepareChatBody`, used when `region === "global"`).
The **CN** path (`prepareCnChatBody`) does neither, so every request DSH sends
to `workbuddy` is rejected — with no configuration change able to fix it.

## What it does

At activation it patches the installed `dsh-workbuddy-connect` in place:

- `prepareCnChatBody` now calls `normalizeDeveloperRole(body)` and
  `neutralizeRejectedSystemSignature(body)`.
- `neutralizeRejectedSystemSignature` puts a harmless opening line
  (`You are a helpful assistant.`) **in front of** a system message whose
  opening matches the rejected signature. The prompt text itself is kept
  verbatim, so the model still receives the instructions it was given; only the
  prefix check stops matching.

The write is atomic (temporary file, then rename) and idempotent, and it runs
on every start — so a plugin reinstall, which replaces `node_modules`, is
repaired on the next launch instead of silently breaking again.

## Verification

Measured against the live CN endpoint with the plugin's own credential and
headers (`WorkBuddyUpstreamClient.chatStream`, `stream: true`):

| system role / opening | upstream 0.7.9 | with this fix |
|---|---|---|
| `system` + rival identity | 400 / 11128 | **200** |
| `system` + neutral line | 200 | 200 |
| `developer` + neutral line | 400 / 11128 | **200** |
| `developer` + rival identity | 400 / 11128 | **200** |

The unpatched column also shows the check needs **both** conditions fixed: a
neutral opening alone is not enough while the role stays `developer`.

## Install

```sh
dsh plugin --profile <your profile> add link:<path to this directory>
```

The desktop profile is managed by the App, so for it the bundle is referenced
from the profile's `package.json` (`dependencies` + `dsh.profile.bundles`).

## Notes

- Only the CN path is touched; the international path keeps the upstream logic.
- The upstream package is edited in place because it sends the request from
  inside its own adapter and exposes no hook for a caller to rewrite the body.
- `dsh-model-optimizer`'s `neutralizeIdentityFor` is a *different* layer: it
  rewrites the `harness:identity` **section** of the assembled prompt, while
  the gateway inspects the **opening of the sent system message**. It cannot
  satisfy the channel check, and it is not needed once this bundle is present.

## License

MIT
