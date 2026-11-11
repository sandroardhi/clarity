# Skalpl patches on microsoft/clarity

Remote `upstream` is https://github.com/microsoft/clarity. Show the current fork point and Skalpl commits:

```bash
git fetch upstream master
git log --oneline --no-merges $(git merge-base HEAD upstream/master)..HEAD
```

Keep every patch below when you merge upstream. `packages/clarity-js/test/isolation.test.ts` checks patches 1 to 3. CI runs it on each PR to master.

## clarity-js

1. **Own global and storage keys.** The tracker lives at `window.skalplHeatmap`, not `window.clarity`. Cookies are `_skhmu` and `_skhms`; the tab key is `_skhmt`. Lifecycle events use the key `skalplHeatmap`.
   - Files: `types/data.d.ts` (`Constant.Global`, `Constant.EventKey`, cookie keys), `src/queue.ts`, `src/clarity.ts`, `src/core/index.ts`, `src/dynamic/agent/*.ts`, `src/dynamic/webmcp/*.ts`.
   - Reason: a host page can run Microsoft Clarity next to ours.
   - On merge: check every new `window.clarity` or `Constant.Clarity` use in upstream code.
2. **Upload URL comes from config only.** The session cookie no longer stores or restores an upload URL. The cookie has 4 parts.
   - File: `src/data/metadata.ts`, `Session` in `types/data.d.ts`.
   - Reason: a cookie set by another script must not redirect our uploads.
3. **Server status handling.** 413 and 429 stop recording for the page. Other 4xx drop that sequence and recording continues.
   - File: `src/data/upload.ts` `check()`.
   - The server and nginx send 429 for rate limits because of this.
4. **Text node clicks.** A click on a text node is attributed to its parent element.
   - File: `src/interaction/click.ts`.
5. **Visualize survives tracker load.** `queue.ts process()` keeps an existing `skalplHeatmap.visualize`.

## clarity-visualize

6. **Global.** Exposes `skalplHeatmap.visualize`, `window.clarityVisualize` and `window.Visualizer`. File: `src/global.ts`.
7. **Heatmap fixes.** File: `src/heatmap.ts`.
   - New activity resets the click scale; redraws keep it.
   - Scroll and click maps guard empty data and a zero max.
   - The canvas ignores pointer events.
   - An element is found by selector when the hash lookup fails, unless the selector is a bare tag (`src/selector.ts`).
   - Visibility counts children of the target element.

## clarity-devtools

8. Uses `skalplHeatmap` and `Constant.Global`. Files: `src/clarity.ts`, `src/devtools.ts`.

## Skalpl only

- `packages/clarity-server`: ingest and heatmap API. See its README.
- `deploy/`: box config and scripts. See `deploy/README.md`.
- Root `package.json`: the `*:server` scripts.
- Tests renamed for the new global and keys: `test/*.test.ts`, `packages/*/test/*.test.ts`.
