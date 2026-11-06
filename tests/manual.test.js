import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, A, B, C, clone, mod } from './helpers.js';
const bagKey = JSON.stringify(['profile', 'Default']);

test('preparing a manual target has no switching side effects and reuses the reservation', async () => {
    const env = environment({ data: { uninstallAndReinstallChecked: true } });
    const first = await env.message('prepareManualRandomization');
    const second = await env.message('prepareManualRandomization');
    assert.equal(first.id, A); assert.equal(first.reinstallUrl, mod.reinstallUrl);
    assert.equal(second.token, first.token);
    assert.equal(env.calls.enabled.length, 0); assert.equal(env.calls.uninstall.length, 0);
    assert.equal(env.calls.tabs.length, 0); assert.equal(env.data.shuffleBags, undefined);
    assert.equal(env.data.lastRandomizationTime, undefined);
});
test('successful manual uninstall commits exactly one shuffle draw and opens the store once', async () => {
    const env = environment({ data: { uninstallAndReinstallChecked: true } });
    const plan = await env.message('prepareManualRandomization');
    await env.message('beginManualRandomization', { token: plan.token });
    env.mods.splice(0, 1);
    await Promise.all(env.chrome.management.onUninstalled.emit(A));
    await env.message('completeManualRandomization', { token: plan.token });
    assert.deepEqual(env.data.shuffleBags[bagKey], [A]);
    assert.equal(env.data.lastEnabledModId, A);
    assert.equal(env.calls.tabs.length, 1);
    assert.equal(env.calls.tabs[0].url, mod.reinstallUrl);
    const next = await env.message('prepareManualRandomization');
    assert.equal(next.id, B);
});
test('completion survives a cold worker without the original popup callback', async () => {
    const warm = environment({ data: { uninstallAndReinstallChecked: true } });
    const plan = await warm.message('prepareManualRandomization');
    await warm.message('beginManualRandomization', { token: plan.token });
    const cold = environment({ data: clone(warm.data), mods: warm.mods.filter(mod => mod.id !== A) });
    await Promise.all(cold.chrome.management.onUninstalled.emit(A));
    assert.deepEqual(cold.data.shuffleBags[bagKey], [A]);
    assert.equal(cold.calls.tabs[0].url, mod.reinstallUrl);
    await cold.message('completeManualRandomization', { token: plan.token });
    assert.equal(cold.calls.tabs.length, 1);
});
test('cancelled uninstall preserves the same target and leaves the bag untouched', async () => {
    const env = environment({ data: { uninstallAndReinstallChecked: true } });
    const plan = await env.message('prepareManualRandomization');
    await env.message('beginManualRandomization', { token: plan.token });
    assert.equal((await env.message('completeManualRandomization', { token: plan.token })).status, 'error');
    await env.message('cancelManualRandomization', { token: plan.token });
    const retry = await env.message('prepareManualRandomization');
    assert.equal(retry.token, plan.token); assert.equal(retry.id, plan.id);
    assert.equal(env.data.shuffleBags, undefined); assert.equal(env.calls.tabs.length, 0);
});
test('preparation adapts to profile and setting changes; stale enable reservations fail', async () => {
    const env = environment({ data: { profiles: { Default: [A], Other: [B] } } });
    const plan = await env.message('prepareManualRandomization');
    await env.message('setActiveProfile', { profileName: 'Other' });
    const stale = await env.message('enablePreparedManualRandomization', { token: plan.token });
    assert.equal(stale.status, 'error'); assert.equal(env.calls.enabled.length, 0);
    const next = await env.message('prepareManualRandomization');
    assert.equal(next.id, B); assert.notEqual(next.token, plan.token);
    env.data.uninstallAndReinstallChecked = true;
    env.data.activeProfile = 'Default';
    const reinstall = await env.message('prepareManualRandomization');
    assert.equal(reinstall.reinstallUrl, mod.reinstallUrl);
});
test('enable-only and missing-URL fallback use the reserved target and consume one draw', async () => {
    for (const uninstall of [false, true]) {
        const env = environment({ data: { profiles: { Default: [B] }, uninstallAndReinstallChecked: uninstall } });
        const plan = await env.message('prepareManualRandomization');
        assert.equal(plan.reinstallUrl, null);
        const result = await env.message('enablePreparedManualRandomization', { token: plan.token });
        assert.equal(result.id, B); assert.equal(env.mods[1].enabled, true);
        assert.deepEqual(env.data.shuffleBags[bagKey], [B]);
        assert.equal(env.calls.uninstall.length, 0); assert.equal(env.calls.tabs.length, 0);
    }
});
test('failed enable and empty eligibility never consume a prepared draw', async () => {
    const env = environment({ failEnable: true });
    const plan = await env.message('prepareManualRandomization');
    const result = await env.message('enablePreparedManualRandomization', { token: plan.token });
    assert.equal(result.status, 'error'); assert.equal(env.data.shuffleBags, undefined);
    env.data.profiles.Default = [];
    assert.equal(await env.message('prepareManualRandomization'), null);
});
test('finishing an older confirmation merges shuffle progress without rewinding an automatic draw', async () => {
    const env = environment({ data: { uninstallAndReinstallChecked: true, profiles: { Default: [A, B, C] }, shuffleBags: { [bagKey]: [B] } } });
    env.mods.push({ id: C, name: 'Gamma', enabled: false });
    const plan = await env.message('prepareManualRandomization');
    assert.equal(plan.id, A);
    env.data.shuffleBags[bagKey] = [B, C];
    env.mods.splice(0, 1);
    await env.message('completeManualRandomization', { token: plan.token });
    assert.deepEqual(env.data.shuffleBags[bagKey], [B, C, A]);
});
test('opening the UI does not clear an automatic pending reinstall action', async () => {
    const pending = { modId: A, modName: 'Alpha', reinstallUrl: mod.reinstallUrl, uninstallMode: true };
    const env = environment({ data: { uninstallAndReinstallChecked: true, pendingNotification: pending } });
    await env.message('prepareManualRandomization');
    assert.deepEqual(env.data.pendingNotification, pending);
});
for (const useAll of [false, true]) {
    test(`direct manual uninstall preserves full shuffle cycles in ${useAll ? 'all-mods' : 'profile'} mode`, async () => {
        const ids = [A, B, C], names = ['Alpha', 'Beta', 'Gamma'];
        const env = environment({
            data: {
                uninstallAndReinstallChecked: true, autoModIdentificationChecked: useAll,
                profiles: { Default: ids }, knownDetectedIds: ids,
                detectedModList: ids.map((id, i) => ({ id, name: names[i] }))
            },
            mods: ids.map((id, i) => ({ id, name: names[i], enabled: false, updateUrl: 'https://api.gx.me/store/mods/update' })),
            fetch: async () => ({ ok: true, json: async () => Object.fromEntries(names.map(name => [name, { url: `https://store.gx.me/mods/${name.toLowerCase()}/example/` }])) })
        });
        let previous;
        for (let cycle = 0; cycle < 2; cycle++) {
            const selected = [];
            for (let i = 0; i < 3; i++) {
                const plan = await env.message('prepareManualRandomization');
                assert.notEqual(plan.id, previous); previous = plan.id; selected.push(plan.id);
                await env.message('beginManualRandomization', { token: plan.token });
                const [removed] = env.mods.splice(env.mods.findIndex(mod => mod.id === plan.id), 1);
                await Promise.all(env.chrome.management.onUninstalled.emit(plan.id));
                env.mods.push({ ...removed, enabled: true });
                await Promise.all(env.chrome.management.onInstalled.emit(removed));
            }
            assert.equal(new Set(selected).size, 3);
        }
        assert.equal(env.calls.tabs.length, 6);
    });
}
