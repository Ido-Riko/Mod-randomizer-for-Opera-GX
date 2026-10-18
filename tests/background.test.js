import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, A, B, C, mod, clone, event, flush } from './helpers.js';
import { notificationIdFor } from '../modules/reinstall.js';

test('cleanup preserves recent uninstall membership and exclusions across reinstall', async () => {
    const env = environment({ data: { profiles: { Default: [A], Other: [B] }, recentlyUninstalled: { [B]: { timestamp: Date.now(), name: 'Beta' } } } });
    env.mods.splice(1, 1);
    await env.message('popupOpened');
    assert.deepEqual(env.data.profiles, { Default: [A], Other: [B] });
    assert.deepEqual(env.data.knownDetectedIds, [A, B]);
    env.mods.push({ id: B, name: 'Beta', enabled: true, updateUrl: 'https://api.gx.me/store/mods/update' });
    await Promise.all(env.chrome.management.onInstalled.emit({ id: B }));
    assert.deepEqual(env.data.profiles, { Default: [A], Other: [B] });
});
test('expired uninstall entries are cleaned', async () => {
    const env = environment({ data: { recentlyUninstalled: { [B]: { timestamp: Date.now() - 61000, name: 'Beta' } } } });
    env.mods.splice(1, 1); await env.message('popupOpened');
    assert.deepEqual(env.data.profiles.Default, [A]);
    assert.deepEqual(env.data.profilesOrder.Default, [A]);
});
test('overlapping randomizations are serialized and leave one enabled mod', async () => {
    const env = environment();
    const results = await Promise.all([env.message('getRandomMod'), env.message('getRandomMod')]);
    assert.equal(results.filter(r => r?.id).length, 2);
    assert.equal(env.mods.filter(m => m.enabled).length, 1);
    assert.equal(env.mods.find(m => m.enabled).id, env.data.lastEnabledModId);
});
test('management errors are returned and do not record false success', async () => {
    const env = environment({ failEnable: true });
    const result = await env.message('getRandomMod');
    assert.equal(result.status, 'error'); assert.match(result.message, /Permission denied/);
    assert.equal(env.data.currentMod, undefined); assert.equal(env.data.lastRandomizationTime, undefined);
});
test('a one-mod profile can re-enable the last selected mod', async () => {
    const env = environment({ data: { profiles: { Default: [A] }, lastEnabledModId: A } });
    assert.equal((await env.message('getRandomMod')).id, A);
    assert.equal(env.mods[0].enabled, true);
});
test('concurrent profile deltas preserve both views edits', async () => {
    const env = environment();
    await Promise.all([
        env.message('saveModExtensionIds', { profileName: 'Default', changes: { [A]: false } }),
        env.message('saveModExtensionIds', { profileName: 'Default', changes: { [B]: false } })
    ]);
    assert.deepEqual(env.data.profiles.Default, []);
});
test('rename and delete update order and active profile atomically; stale saves rejected', async () => {
    const env = environment();
    await env.message('renameProfile', { oldName: 'Default', newName: 'New' });
    assert.deepEqual(env.data.profilesOrder, { New: [A, B] }); assert.equal(env.data.activeProfile, 'New');
    assert.equal((await env.message('saveModExtensionIds', { profileName: 'Default', changes: { [A]: true } })).status, 'error');
    await env.message('deleteProfile', { profileName: 'New' });
    assert.equal(env.data.profilesOrder.New, undefined); assert.equal(env.data.activeProfile, 'Default');
});
test('import and concurrent profile edit both survive', async () => {
    const env = environment();
    const [result] = await Promise.all([
        env.message('importProfiles', { data: { profiles: { Imported: [{ id: A, name: 'Alpha' }] } } }),
        env.message('saveModExtensionIds', { profileName: 'Default', changes: { [A]: false } })
    ]);
    assert.deepEqual(Array.from(result.imported), ['Imported']);
    assert.deepEqual(env.data.profiles, { Default: [B], Imported: [A] });
});
test('invalid import cannot partially overwrite profiles', async () => {
    const env = environment(); const before = clone(env.data.profiles);
    assert.equal((await env.message('importProfiles', { data: { profiles: { Good: [A], Bad: {} } } })).status, 'error');
    assert.deepEqual(env.data.profiles, before);
});
test('ports broadcast to both views; closing one does not disconnect the other', () => {
    const env = environment(), received = [[], []];
    const ports = received.map(messages => ({ name: 'popup', onDisconnect: event(), postMessage: msg => messages.push(msg) }));
    ports.forEach(port => env.chrome.runtime.onConnect.emit(port));
    env.context.tryDeliverToPopup({ action: 'extensionsUpdated' });
    assert.deepEqual(received.map(r => r.length), [1, 1]);
    ports[0].onDisconnect.emit(); env.context.tryDeliverToPopup({ action: 'extensionsUpdated' });
    assert.deepEqual(received.map(r => r.length), [1, 2]);
});
test('remote catalog failure uses bundled catalog for manual reinstall offer', async () => {
    const env = environment({ data: { uninstallAndReinstallChecked: true }, fetch: async url => {
        if (url.startsWith('https:')) throw new Error('Offline');
        return { ok: true, json: async () => ({ Alpha: { url: mod.reinstallUrl } }) };
    } });
    const selected = await env.message('getRandomMod');
    assert.equal(selected.reinstallUrl, mod.reinstallUrl);
    assert.equal(env.calls.uninstall.length, 0);
    assert.equal(env.data.pendingNotification.modId, A);
});
test('remote hang is bounded; retry remains possible after failure', async () => {
    const env = environment({ fetch: (url, { signal }) => {
        if (!url.startsWith('https:')) return Promise.resolve({ ok: true, json: async () => ({}) });
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))));
    } });
    await flush(); await env.runTimers(3000);
    const retry = env.context.loadCatalog(); await flush(); await env.runTimers(3000); await retry;
    assert.equal(env.calls.fetch.filter(url => url.startsWith('https:')).length, 2);
});
test('alarm prepares notification without uninstall; notification click works in cold worker', async () => {
    const env = environment({ data: { uninstallAndReinstallChecked: true, toggleRandomizeOnSetTimeChecked: true } });
    await Promise.all(env.chrome.alarms.onAlarm.emit({ name: 'randomizeAlarm' }));
    await env.runTimers(500);
    assert.equal(env.calls.uninstall.length, 0); assert.equal(env.calls.notifications.length, 1);
    let gesture = true;
    const cold = environment({ requireGesture: true, gesture: () => gesture });
    cold.chrome.notifications.onClicked.emit(env.calls.notifications[0].id);
    gesture = false;
    assert.equal(cold.calls.uninstall.length, 1, 'uninstall called synchronously without reading storage');
    assert.equal(cold.calls.tabs.length, 0);
    cold.calls.uninstall[0].cb(); await flush();
    assert.equal(cold.calls.tabs[0].url, mod.reinstallUrl);
});
test('cancelled notification uninstall preserves pending action and opens no tab', async () => {
    const env = environment({ data: { pendingNotification: { modId: A, uninstallMode: true } } });
    env.chrome.notifications.onClicked.emit(notificationIdFor(mod));
    env.chrome.runtime.lastError = { message: 'User cancelled' }; env.calls.uninstall[0].cb(); delete env.chrome.runtime.lastError;
    await flush(); assert.equal(env.calls.tabs.length, 0); assert.equal(env.data.pendingNotification.modId, A);
});
test('interval updates complete before response and honor scheduling toggle', async () => {
    const env = environment();
    await env.message('setRandomizeTime', { time: 5 });
    assert.equal(env.data.randomizeTime, 5); assert.equal(env.calls.alarms.filter(a => a.config).length, 0);
    await env.message('toggleRandomizeOnSetTimeChecked', { value: true });
    assert.equal(env.calls.alarms.at(-1).config.periodInMinutes, 5);
    assert.equal((await env.message('setRandomizeTime', { time: -1 })).status, 'error');
    assert.equal(env.data.randomizeTime, 5);
});
test('missing catalog URL uses normal enable workflow without uninstall', async () => {
    const env = environment({ data: { uninstallAndReinstallChecked: true, profiles: { Default: [B] } } });
    const result = await env.message('getRandomMod');
    assert.equal(result.id, B); assert.equal(result.reinstallUrl, undefined);
    assert.equal(env.calls.uninstall.length, 0); assert.equal(env.mods[1].enabled, true);
});
test('new request cancels a delayed notification for the superseded mod', async () => {
    const env = environment({ data: { uninstallAndReinstallChecked: true, toggleRandomizeOnSetTimeChecked: true } });
    await Promise.all(env.chrome.alarms.onAlarm.emit({ name: 'randomizeAlarm' }));
    await env.message('getRandomMod'); await env.runTimers(500);
    assert.equal(env.calls.notifications.length, 0);
});
