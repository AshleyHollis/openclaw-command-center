# Beta.6 Control UI plugin boundary and capability bridge

Status: resolved research for [issue #2](https://github.com/AshleyHollis/openclaw-command-center/issues/2)

Baseline: OpenClaw [`v2026.7.2-beta.6`](https://github.com/openclaw/openclaw/releases/tag/v2026.7.2-beta.6), commit [`4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c`](https://github.com/openclaw/openclaw/commit/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c)

Evidence reviewed: pinned tag source, official OpenClaw documentation, and merged upstream PR history. No live OpenClaw state was inspected.

## Decision

Beta.6 is enough to mount Command Center as a responsive external Control UI tab and to serve authenticated, read-only plugin pages and data from that plugin's Gateway HTTP routes. It is **not** enough for the approved interactive product: the sandboxed frame has no authenticated Gateway client, write channel, native host navigation, frame-local focus/full-bleed control, or production notification-publish API.

Command Center therefore needs two small, generic upstream seams:

1. A versioned, parent-mediated capability channel for external plugin tabs. It should dispatch only declared, typed operations as the current operator, without exposing a bearer/device credential or raw Gateway client to the frame.
2. A plugin-runtime notification emitter. The host should apply user notification settings, policy, deduplication, and delivery over the existing Web Push/native transports. This cannot depend on an open iframe.

Do not broaden the Beta.6 frame-auth cookie to writes or WebSockets, require the `trusted` iframe mode, proxy arbitrary Gateway RPCs, or use global `ui.command` broadcasts for frame-local navigation and layout.

## Capability matrix

“Fact” below means directly established by the pinned source or official history. “Conclusion” is the resulting fit for Command Center.

| Area | Beta.6 fact | Command Center conclusion |
| --- | --- | --- |
| Tab discovery | An active plugin can advertise a `surface: "tab"` descriptor with a label, path, group, order, icon, and visibility scopes. The path is rendered in a sandboxed frame when no bundled view exists. [`host-hooks.ts` L96-L116](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/plugins/host-hooks.ts#L96-L116) | Sufficient. Command Center can own one global sidebar tab without a product-specific core page. |
| Responsive panel | The external iframe is `width: 100%`, `flex: 1`, and fills the plugin page's assigned height, with a 480 px minimum height. [`components.css` L5699-L5714](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/ui/src/styles/components.css#L5699-L5714) | Sufficient for desktop and mobile layouts inside the content region. This is not full-shell or full-screen control. |
| Sandbox | The default mode is `scripts`, which becomes `sandbox="allow-scripts"`; `trusted` additionally grants `allow-same-origin`. [`tool-display.ts` L232-L249](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/ui/src/lib/chat/tool-display.ts#L232-L249) The official docs warn that `trusted` is a stronger mode. [`control-ui.md` L568-L598](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/control-ui.md#L568-L598) | The bridge must work in the default opaque-origin `scripts` sandbox. Do not make `trusted` a requirement. |
| Authentication | A visible tab backed by the same plugin's `auth: "gateway"` route receives a five-minute, signed, HttpOnly, Secure, route/plugin/generation-bound cookie. [`control-ui-plugin-auth-cookie.ts` L91-L125](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/control-ui-plugin-auth-cookie.ts#L91-L125) The frame is mounted only after an opaque-sandbox cookie probe succeeds in a secure context. [`plugin-page.ts` L189-L248](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/ui/src/pages/plugin/plugin-page.ts#L189-L248) | Sufficient for loading a protected page and its read requests. It is intentionally not an interactive write credential. |
| Approved reads | Tab visibility honors `requiredScopes`, but the frame-auth grant itself is always `operator.read` and is bound to a same-plugin route. [`control-ui-plugin-tabs.ts` L70-L123](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/control-ui-plugin-tabs.ts#L70-L123), [`L155-L187`](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/control-ui-plugin-tabs.ts#L155-L187) | Sufficient for Command Center-owned HTTP reads. A declared parent dispatcher is still useful for typed host/core reads and later live subscriptions. |
| Mutations and declared actions | Cookie auth is accepted only for `GET`/`HEAD`; mutations remain on explicit Gateway auth surfaces and WebSocket upgrades bypass the handoff. [`http-auth-utils.ts` L137-L167](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/http-auth-utils.ts#L137-L167) | Missing. The frame cannot securely invoke plugin write methods or host actions. A parent-mediated declared-action dispatcher is required. |
| Gateway client and live events | Bundled views receive `GatewayBrowserClient`, connection state, session key, and session revision. The external branch receives only `src`, `title`, and `sandbox`; the only frame message listener is the auth probe. [`plugin-page.ts` L22-L45](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/ui/src/pages/plugin/plugin-page.ts#L22-L45), [`L546-L600`](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/ui/src/pages/plugin/plugin-page.ts#L546-L600) | Missing. Polling the plugin's read route is an acceptable MVP fallback; typed, filtered events can be added to the bridge later. |
| Secure message submission | `sessions.send` and `chat.send` require `operator.write`. [`core-descriptors.ts` L235](https://github.com/openclaw/openclaw/blob/4d6bdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/methods/core-descriptors.ts#L235), [`L317`](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/methods/core-descriptors.ts#L317) The external frame has neither an explicit auth credential nor a host RPC proxy. | Missing and required. The host should expose a narrow typed send operation with an explicit target session, executed through the parent's authenticated client. |
| Native navigation | The default frame is granted only script execution, and the plugin page contains no general frame-to-host command handler. The existing `ui.command` API can navigate/focus sessions, but it requires `operator.write` and broadcasts to every connected capable Control UI. [`screen.md` L19-L44](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/tools/screen.md#L19-L44) | Missing. A local host-navigation capability should target the current Control UI/tab, not use the Gateway broadcast. |
| Focus/full-bleed | The frame fills only its assigned plugin content area. There is no tab descriptor field or external-frame handler for hiding/restoring the Control UI chrome. | Missing if Command Center needs a focused mode. Add a frame-local, reversible presentation request; restore host state when the frame unmounts or navigation leaves the tab. |
| Session dashboards | Dashboards belong to one thread and sandboxed widgets can be granted `data`, `actions`, and `prompt`; plugins can add same-plugin read feeds and actions. [`dashboards.md` L9-L31](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/dashboards.md#L9-L31), [`L70-L95`](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/dashboards.md#L70-L95) | This is a useful security design to generalize, but it is not the global Command Center page. |
| Native dashboard widgets | Plugin widget-kind descriptors are advertised, but renderers are trusted first-party Control UI code from a static registry; Beta.6 includes only WorkBoard renderers. [`widgets/index.ts` L26-L42](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/ui/src/lib/board/widgets/index.ts#L26-L42) | An external plugin cannot dynamically ship a native renderer. No such renderer is needed for the Command Center MVP. |
| Browser/mobile Web Push | The Control UI is an installable PWA, and Web Push can wake it when its tab/window is closed. Subscription state and VAPID keys are host-owned. [`control-ui.md` L532-L565](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/control-ui.md#L532-L565) | Delivery substrate exists for supported mobile browsers/PWAs. |
| Production notification emission | The exposed browser methods manage subscriptions and send a test broadcast; native APNS is likewise exposed as `push.test`. [`push.ts` L32-L127](https://github.com/openclaw/openclaw/blob/4d6bdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/server-methods/push.ts#L32-L127), [`L129-L205`](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/server-methods/push.ts#L129-L205) The official notification guide distinguishes PWA/macOS settings from native mobile push paths. [`notifications.md` L10-L36](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/notifications.md#L10-L36) | Missing. There is no generic plugin API for a real attention event with host policy and a safe Command Center deep link. |

## Exact boundaries

### External tab rendering and authentication

Facts:

- A tab path must resolve to a same-origin pathname. [`control-ui-contract.ts` L31-L39](https://github.com/openclaw/openclaw/blob/4d6bdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/control-ui-contract.ts#L31-L39)
- Only a matching route owned by the same plugin can receive the frame grant. The grant contains only `operator.read`, regardless of other scopes that made the tab visible. [`control-ui-plugin-tabs.ts` L155-L187](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/control-ui-plugin-tabs.ts#L155-L187)
- The cookie is scoped to the plugin, canonical route path/match mode, current Gateway auth generation, and five-minute expiry. It is inaccessible to iframe JavaScript. [`control-ui-plugin-auth-cookie.ts` L91-L125](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/control-ui-plugin-auth-cookie.ts#L91-L125)
- Insecure non-loopback HTTP and browsers that block the sandbox cookie fail closed: the real iframe is not mounted. [`plugin-page.ts` L201-L248](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/ui/src/pages/plugin/plugin-page.ts#L201-L248)
- Upstream added this design specifically because external sandbox tabs could not attach a Gateway bearer header. The merged change explicitly rejects mutation requests and WebSockets. [PR #107323](https://github.com/openclaw/openclaw/pull/107323)

Conclusion:

The cookie solves authenticated document and data loading without credential exposure. Its read-only nature is a deliberate security boundary, not an omission to work around. Command Center may expose a same-plugin GET endpoint for its own database/file-derived view model. It must not encode writes in GET requests.

### Reads and actions

Facts:

- The iframe can call its own protected GET route and receive data computed by the trusted native plugin runtime under the granted read scope.
- Session-dashboard widgets already have a separate declared capability system. Plugin `dashboard.dataBindings` must resolve to a method owned by the same plugin with `operator.read`; `actionVerbs` must resolve to a same-plugin `operator.write` method. Invalid ownership or scope rejects registration. [`dashboard-capabilities.ts` L46-L74](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/plugins/dashboard-capabilities.ts#L46-L74), [`L77-L168`](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/plugins/dashboard-capabilities.ts#L77-L168)
- The dashboard bridge keeps credentials out of the sandbox and binds grants to the widget revision. [PR #112083](https://github.com/openclaw/openclaw/pull/112083)
- No equivalent dispatcher is wired to external plugin-tab iframes in Beta.6.

Inference:

The dashboard implementation is evidence that OpenClaw accepts a parent-mediated, declared-capability pattern for untrusted UI. Generalizing that pattern is safer and smaller than inventing a second credential scheme.

Recommendation:

Use the enabled plugin plus the authenticated operator's existing scopes as the authorization boundary. For a trusted installed plugin tab, do not introduce repeated per-click approvals merely to read or update Command Center notes. Registration-time declarations, scope checks, schema validation, and the product's own action-card confirmation policy are separate concerns and should remain separate.

### Navigation and presentation

Facts:

- Beta.6's frame has no generic host command channel.
- `ui.command` is a Gateway-level presentation broadcast to all connected `ui-commands` clients, not a browser-tab-local API. [`screen.md` L32-L44](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/tools/screen.md#L32-L44)
- The external frame fills its content container but does not own the sidebar/header shell. [`components.css` L5699-L5714](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/ui/src/styles/components.css#L5699-L5714)

Inference:

Using `ui.command` for a click inside Command Center could unexpectedly navigate or hide chrome on every connected device. It also cannot identify the mounted iframe that originated the request.

Recommendation:

Keep navigation and focus/full-bleed in the Control UI parent. Accept only typed destinations such as a session reference or an internal Command Center route; do not accept arbitrary URLs. Presentation changes must be scoped to the current mounted frame, reversible, and automatically cleared on unmount, disconnect, or tab change.

### Notifications and mobile

Facts:

- Supported browsers and the installed Control UI PWA can subscribe to Web Push, and the service worker can display a notification while the UI is closed. [`control-ui.md` L532-L565](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/control-ui.md#L532-L565)
- The public Gateway surface in Beta.6 exposes subscription management and test sends, not a plugin-attributed production notification operation. [`push.ts` L129-L205](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/server-methods/push.ts#L129-L205)
- Web Push and native iOS APNS delivery are independent paths. [`control-ui.md` L564-L566](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/control-ui.md#L564-L566)

Conclusion:

The app/PWA should keep owning notification permission, service-worker registration, subscriptions, and delivery. Command Center should not try to register a service worker from its opaque iframe. Because scheduled checks can find an attention item while the tab is closed, notification emission belongs to the native plugin runtime, not the iframe bridge.

Recommendation:

Add a generic host API that lets an enabled plugin emit a bounded notification candidate containing:

- plugin identity supplied by the host, not caller-controlled;
- a stable event/deduplication key;
- severity or attention class;
- bounded title and body;
- a typed, same-Control-UI deep-link target; and
- optional expiry.

The host must apply the operator's notification settings, quiet hours/policy, rate limits, deduplication, and eligible transports. The API should not accept arbitrary origins, raw subscription details, or device tokens. Web/PWA delivery can use the existing transport; parity with native mobile push remains an explicit host integration requirement rather than an assumption.

## Minimum generic tab bridge

This is a recommendation, not a description of Beta.6.

### 1. Establish a bound channel

After mounting the iframe, the parent creates a `MessageChannel` and transfers one port only after validating the mounted `contentWindow`, plugin id, tab id, canonical route, and connection epoch. The handshake negotiates a bridge version and returns only the capabilities available to that tab and current operator.

Every envelope should have a request id, operation name, bounded/schema-validated payload, success/error response, timeout/cancellation behavior, and a per-frame rate limit. Late messages from a prior mount or Gateway connection must be rejected.

### 2. Dispatch declared operations

Provide two categories:

- **Plugin-owned data/actions:** reuse or generalize the dashboard declaration rules. A data binding must resolve to the declaring plugin's `operator.read` method; an action must resolve to that plugin's `operator.write` method.
- **Small core allowlist:** expose only the exact host operations needed by the product, initially session list/history/search reads and a typed session/chat send. Execute them through the parent's authenticated Gateway client as the current operator and preserve the underlying method's scope checks.

Do not expose a generic `gateway.request(method, params)` primitive. Do not pass the Gateway URL plus token, device credential, auth cookie value, or `GatewayBrowserClient` into the sandbox.

### 3. Add local shell capabilities

Expose typed, frame-local operations for:

- open/focus a permitted native session destination;
- update the tab's internal route where the parent needs to preserve deep linking; and
- enter/leave a focused or full-bleed presentation mode.

These are local UI operations, not Gateway broadcasts. The parent remains authoritative and may reject a request based on device size, route, or current state.

### 4. Degrade explicitly

The iframe should feature-detect the bridge. On Beta.6 or any host without it:

- read Command Center data through the authenticated GET route;
- poll for changes at a conservative interval;
- open only routes that work inside the iframe;
- show write controls as unavailable with a clear host-upgrade message; and
- never fall back to a token in a URL, browser storage, or frame-readable configuration.

This allows the read-only UI to remain useful while keeping unsafe fallbacks out of the product.

## Required now versus deferrable

Required for the approved Command Center experience:

- external tab descriptor and protected read route (already present);
- declared write/action dispatch;
- secure session/chat message submission;
- native, current-window navigation;
- frame-local focus/full-bleed request if that presentation is part of the MVP;
- bridge version/capability negotiation and fail-closed validation; and
- background plugin notification emission using host policy and transports.

Deferrable:

- streaming Gateway events; polling the protected read route is acceptable initially;
- arbitrary host RPC access (preferably never added);
- dynamically loaded native dashboard renderers;
- using session dashboards as a second Command Center UI surface; and
- plugin-controlled notification permission/subscription management.

## Rejected alternatives

| Alternative | Why it is rejected |
| --- | --- |
| Make the frame cookie authorize POST or WebSocket | It reverses the explicit read-only security decision in [PR #107323](https://github.com/openclaw/openclaw/pull/107323) and turns ambient cross-site cookie authority into a mutation credential. |
| Put a Gateway token in the iframe URL, script, or storage | It exposes a reusable credential to the sandboxed application and contradicts the reason frame grants were introduced. |
| Require `embedSandbox: "trusted"` | It adds same-origin privilege globally and is unnecessary for a `MessageChannel` bridge. The default `scripts` mode should remain viable. |
| Proxy arbitrary Gateway methods | It makes the sandbox's authority difficult to audit and risks accidental scope expansion as new methods appear. |
| Use `ui.command` for clicks and focus mode | Protocol v1 broadcasts to all connected capable Control UIs, so it has the wrong target and lifecycle. |
| Make Command Center a session dashboard | Dashboards are thread-owned; Command Center is a global surface spanning spaces and attention items. |
| Bundle Command Center UI code into OpenClaw core | It creates product-specific coupling. The core change should be a generic capability seam usable by other external plugin tabs. |
| Send notifications from the iframe | It fails when the frame is closed and duplicates host-owned permission and subscription handling. |

## Final answer to issue #2

At `v2026.7.2-beta.6`, an external Control UI plugin receives a discoverable sandboxed tab, responsive content-region iframe, same-origin route loading, and a short-lived read-only cookie for its own Gateway-authenticated GET/HEAD route. It does not receive a Gateway client, write/mutation channel, WebSocket auth, native navigation, secure chat/session send, current-frame layout control, or production notification publisher.

The minimal safe implementation is a generic, declared, parent-mediated tab capability channel plus a host-owned plugin notification emitter. Existing session-dashboard capability dispatch provides a strong pattern, but session dashboards and statically bundled native widget renderers do not themselves solve the global Command Center use case.

## Primary sources

- [OpenClaw `v2026.7.2-beta.6` release](https://github.com/openclaw/openclaw/releases/tag/v2026.7.2-beta.6)
- [Pinned source commit](https://github.com/openclaw/openclaw/commit/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c)
- [PR #107323: secure external plugin-tab Gateway auth](https://github.com/openclaw/openclaw/pull/107323)
- [Issue #107255: external plugin tab returned 401 under Gateway auth](https://github.com/openclaw/openclaw/issues/107255)
- [PR #99930: initial plugin-contributed Control UI tabs](https://github.com/openclaw/openclaw/pull/99930)
- [PR #112083: plugin-declared dashboard data and actions](https://github.com/openclaw/openclaw/pull/112083)
- [PR #112434: trusted first-party plugin widget kinds](https://github.com/openclaw/openclaw/pull/112434)
- [Official session-dashboard documentation at the pinned commit](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/dashboards.md)
- [Official notification documentation at the pinned commit](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/web/notifications.md)
