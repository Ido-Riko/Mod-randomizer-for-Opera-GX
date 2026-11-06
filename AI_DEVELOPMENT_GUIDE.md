# AI Development Guide for Mod Randomizer

This document is written for AI agents and developers working on the Opera GX Mod Randomizer extension. It details the architecture, state management, and critical rules to follow to ensure new features do not conflict with existing logic or introduce bugs.

## 1. Extension Architecture
The extension is built under **Manifest V3** with the following structure:
- `background.js`: A Service Worker acting as the central source of truth. Handles `chrome.management` API calls, notifications, alarms, and tracks background state. It is an ES-module service worker.
- `popup.html` & `sidebar.html`: The user interfaces. They share exactly the same DOM structure and utilize the same scripts (`popup.js`).
- `modules/`:
  - `api.js`: Wrappers for `chrome.storage.local` and `chrome.runtime.sendMessage`/`Port`.
  - `profiles.js`: Logic for managing, exporting, and importing user profiles.
  - `ui.js`: DOM manipulation, rendering the mod list, toggles, and modal dialogues.
  - `utils.js`: Formatting, custom alerts, prompts, and confirms.

## 2. Core Workflows to Understand

### A. The "Uninstall and Reinstall" Workflow (CRITICAL)
Due to Opera GX API limitations, simply enabling a mod via `chrome.management.setEnabled()` does not toggle all internal checkmarks of the mod. To solve this, the extension defaults to an "Uninstall and Reinstall" flow:
1. The worker chooses/enables a mod and stores the pending reinstall target.
2. Popup/sidebar show a **Reinstall** button. Its click calls `uninstallFromGesture()` synchronously, before any await, message, storage access, or tab creation.
3. Automatic startup/alarm selection only offers an OS notification. Its click handler decodes the target from the notification ID and calls the same helper synchronously, including after a worker restart.
4. Native confirmation is always requested. Cancellation/error keeps the pending action and opens no store tab; success opens the reinstall URL and clears the matching pending action.
5. Catalog lookup uses a bundled fallback, a remote request with a three-second timeout, and retry on a later randomization. Invalid/missing URLs use the enable-only workflow.
*Rule:* If you modify randomization outputs, you must account for this split workflow (`executeRandomization()` -> `handleUninstallWorkflow()` vs `handleModEnableWorkflow()`).

### B. Grace Period for Uninstalled Mods
When users use the "Uninstall/Reinstall" flow, the mod temporarily disappears from `chrome.management`.
- `background.js` listens to `onUninstalled` and saves the mod to `recentlyUninstalled` in `chrome.storage.local` with a timestamp.
- `background.js` (`cleanupUndetectedMods`) utilizes a 60-second grace period, reading the timestamp from the stored object (and accepting legacy numeric timestamps). If a mod is uninstalled but is within the grace period, it is **not** deleted from the user's profiles.

### C. Background-UI Communication
- `modules/api.js` reconnects long-lived UI ports after disconnects.
- The worker tracks a Set of all open UI ports. Ports carry transient errors and refresh events.
- `chrome.storage.onChanged` carries durable state updates, including pending reinstall actions; new views read the latest stored state.
- All profile mutations (selection, create, rename, delete, import, order initialization, cleanup, and installation discovery) run through the worker's serialized state queue.
- Checkbox saves submit per-ID changes rather than overwriting a whole profile from a stale UI snapshot.
- Do not add UI writes to `profiles`, `profilesOrder`, or `knownDetectedIds`.

## 3. Storage and State Keys
All state is stored in `chrome.storage.local`. DO NOT hardcode defaults locally; fetch them from storage or handle missing keys gracefully (usually falling back to `true` or `false` based on the feature's default state in `background.js` `onInstalled`).

**Critical Keys:**
- `profiles` (Object): Map of `ProfileName` -> `[ModID1, ModID2, ...]`.
- `profilesOrder` (Object): Explicit ordering data for rendering mods in the popup.
- `activeProfile` (String): Current active profile name.
- `detectedModList` (Array): Array of `{ id, name }`. Ground truth of mods currently installed (filtered by Opera GX mod update URL).
- `knownDetectedIds` (Array): Tracks mods we have already acknowledged to prevent indiscriminately toggling newly installed mods on across all profiles if "Randomize all mods" is off.
- `recentlyUninstalled` (Object): Map of `ModID` -> `{ timestamp, name }` for the grace period.

**Toggle States:**
- `autoModIdentificationChecked` (Randomize all mods)
- `uninstallAndReinstallChecked` (Uninstall and reinstall workflow)
- `openModsTabChecked` (Open mods tab)
- `showNotificationsChecked` (Show OS notifications)
- `toggleRandomizeOnStartupChecked` (Alarms on startup)
- `toggleRandomizeOnSetTimeChecked` & `randomizeTime` & `timeUnit` (Periodic randomization)

## 4. Rules for Adding Features
1. **Never Duplicate Logic:** If you need to trigger a randomization, send a message to `background.js` (`action: 'getRandomMod'`). Do NOT write mod picking logic in the popup.
2. **Modifying the UI:**
   - Ensure the IDs or classes you add to `popup.html` also go to `sidebar.html`.
   - Add new elements to the `initEls` mapping inside `modules/ui.js` instead of globally querying the document in `popup.js`.
3. **Alarms and Timers:** Let `background.js` handle all `setTimeout` and `chrome.alarms` calls for core features. The UI should only handle debouncing for UI inputs (like search bars or time inputs).
4. **Handling Edge Cases for Disabled Mods:** Remember that the "Randomize all mods" toggle (`autoModIdentificationChecked`) disables the custom profiles list visually and logically. Any profile-editing feature must be blocked or hidden when this mode is active.
5. **Use the internal `api.js` helpers:** Instead of raw `chrome.storage.local`, use `storageGet()` and `storageSet()` for promise-wrapped interactions.

## 5. Development Checklist
- [ ] Did I verify my change doesn't break the `uninstallAndReinstall` workflow?
- [ ] If I added a new setting, did I set a default value in `background.js` under `chrome.runtime.onInstalled`?
- [ ] Are UI modifications mirrored in both `popup.html` and `sidebar.html`?
- [ ] Is UI state properly preserved across popup closes utilizing `chrome.storage.local`?

## 6. Tests
Run `npm test` (Node.js 22+, no dependencies). See `TESTING.md` for native Opera GX checks. Mocks verify call ordering but cannot certify browser user-gesture enforcement.
