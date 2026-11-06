# Testing

Run `npm test` with Node.js 22 or newer. No dependency installation is needed.
GitHub Actions runs the same suite on pushes and pull requests.

The tests execute the extension's JavaScript using mocked Chrome APIs and small
DOM fixtures. They cover profile cleanup, concurrent profile changes and mod
switches, exports, Cancel, timers, catalog failure/timeout, popup/sidebar state,
the synchronous invocation of uninstall from an explicit click, and shuffle cycles,
persistence, independent profiles/all-mods bags, edits, failure handling, migration,
the advanced toggle in both views, and direct manual uninstall with cancellation,
reserved selection, cold-worker completion, and exactly-once store navigation.

## Opera GX integration checklist

Mocks cannot verify Opera's native user-gesture enforcement, notification delivery,
or confirmation dialogs. Run these checks in Opera GX before publishing a release.
Use a disposable browser profile and mods you can reinstall.

1. Load this directory unpacked through Opera's extensions page with developer mode enabled.
2. With **Uninstall and reinstall** enabled, wait for **Randomize** to become available.
   Opening the popup must not switch or uninstall a mod. Click **Randomize** once:
   Opera's uninstall confirmation should appear immediately. After invoking uninstall,
   the same click also shows the selected-mod message and its **Reinstall** button.
3. Cancel: the mod remains installed, no store tab opens, and the shuffle draw is not
   consumed. The message and Reinstall button remain, including after reopening the
   popup. Click **Reinstall** (or Randomize again) to retry the same selection. Accept: the correct store page should
   open exactly once after successful removal, even if the popup closes.
4. Repeat steps 2–3 in the sidebar. On success the sidebar remains open and the next
   candidate becomes available. With reinstall disabled or a missing catalog URL,
   Randomize should enable the selected mod normally without an uninstall prompt.
5. Enable periodic randomization and OS notifications. An alarm should offer a notification,
   never uninstall automatically. Clicking the notification should open Opera's confirmation.
   Test both Cancel and Accept. Inspect the selected name and the store URL.
6. Repeat step 5 after the background worker has stopped (close its DevTools and allow
   it to become inactive). The notification's encoded target should work on a cold worker.
7. Dismiss the OS notification and open the popup: the pending Reinstall button should remain.
   Close/reopen the popup during candidate loading: opening it must not switch mods.
   Stop the worker after a manual reservation begins and verify successful removal
   still opens the correct store page and consumes only one draw.
8. Open popup and sidebar together; switch profiles, edit different checkboxes quickly,
   and confirm both views converge on the saved profile without losing selections.
9. Reinstall a selected mod within 60 seconds; its existing profile inclusions and exclusions
   should survive. A mod absent beyond the grace period is removed on the next UI opening.
10. Block access to raw.githubusercontent.com and reload the extension. Randomization should
    still use the packaged catalog after the bounded remote attempt.

Manual Randomize prepares its candidate before the click so uninstall starts in
the click's synchronous stack. Notifications and their pending Reinstall button
also use the synchronous helper and request native confirmation.


## Shuffle bag integration checks

1. With three or more mods in a profile, confirm **Shuffle bag (no repeats)** is on
   in Advanced Settings in both popup and sidebar. Randomize through two cycles:
   each mod should appear once per cycle, with no repeat across the boundary.
2. Close/reopen the browser midway through a cycle and verify remaining mods appear
   before any repeats. Switch to another profile and back to check independent progress.
3. Turn shuffle off in one view; the other view should update. Turn it back on to
   start fresh bags. Repeat with **Randomize all mods** and with reinstall enabled.
