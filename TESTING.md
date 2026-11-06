# Testing

Run `npm test` with Node.js 22 or newer. No dependency installation is needed.
GitHub Actions runs the same suite on pushes and pull requests.

The tests execute the extension's JavaScript using mocked Chrome APIs and small
DOM fixtures. They cover profile cleanup, concurrent profile changes and mod
switches, exports, Cancel, timers, catalog failure/timeout, popup/sidebar state,
the synchronous invocation of uninstall from an explicit click, and shuffle cycles,
persistence, independent profiles/all-mods bags, edits, failure handling, migration,
and the advanced toggle in both views.

## Opera GX integration checklist

Mocks cannot verify Opera's native user-gesture enforcement, notification delivery,
or confirmation dialogs. Run these checks in Opera GX before publishing a release.
Use a disposable browser profile and mods you can reinstall.

1. Load this directory unpacked through Opera's extensions page with developer mode enabled.
2. With **Uninstall and reinstall** enabled, click **Randomize** in the popup.
   The chosen mod and a **Reinstall** button should appear; no uninstall should occur yet.
3. Click **Reinstall**. Confirm that Opera displays its uninstall confirmation.
   Cancel: the mod stays installed, no store tab opens, and Reinstall remains available.
   Retry and accept: the correct store page opens only after successful removal.
4. Repeat steps 2–3 in the sidebar. On success the sidebar remains open.
5. Enable periodic randomization and OS notifications. An alarm should offer a notification,
   never uninstall automatically. Clicking the notification should open Opera's confirmation.
   Test both Cancel and Accept. Inspect the selected name and the store URL.
6. Repeat step 5 after the background worker has stopped (close its DevTools and allow
   it to become inactive). The notification's encoded target should work on a cold worker.
7. Dismiss the OS notification and open the popup: the pending Reinstall button should remain.
   Also close the popup while Randomize is preparing, then reopen it to recover that action.
8. Open popup and sidebar together; switch profiles, edit different checkboxes quickly,
   and confirm both views converge on the saved profile without losing selections.
9. Reinstall a selected mod within 60 seconds; its existing profile inclusions and exclusions
   should survive. A mod absent beyond the grace period is removed on the next UI opening.
10. Block access to raw.githubusercontent.com and reload the extension. Randomization should
    still use the packaged catalog after the bounded remote attempt.

The extra Reinstall click is intentional: selection can require asynchronous work;
uninstall itself must start directly from an explicit click. Both UI and background
notification handlers use the same synchronous helper and request native confirmation.


## Shuffle bag integration checks

1. With three or more mods in a profile, confirm **Shuffle bag (no repeats)** is on
   in Advanced Settings in both popup and sidebar. Randomize through two cycles:
   each mod should appear once per cycle, with no repeat across the boundary.
2. Close/reopen the browser midway through a cycle and verify remaining mods appear
   before any repeats. Switch to another profile and back to check independent progress.
3. Turn shuffle off in one view; the other view should update. Turn it back on to
   start fresh bags. Repeat with **Randomize all mods** and with reinstall enabled.
