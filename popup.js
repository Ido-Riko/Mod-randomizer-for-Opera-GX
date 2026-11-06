import { uninstallFromGesture } from './modules/reinstall.js';
import { port, storageGet, storageSet, sendMsg } from './modules/api.js';
import {
    customAlert, customConfirmDanger, customPrompt,
    toMinutes, fromMinutesFormat
} from './modules/utils.js';
import {
    initEls, getEls, renderExtensionList, triggerManualSave,
    showModMessage, clearEnabledMessage, showRedirectMessage, removeRedirectMessage,
    showError, showImportResults, getRenderLock, showMissedNotificationMessage
} from './modules/ui.js';
import {
    loadAndRenderProfiles, exportProfiles, importProfiles,
    getCurrentProfile, setCurrentProfile
} from './modules/profiles.js';

const isSidebar = window.location.pathname.includes('sidebar.html');

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Elements
    const els = initEls();

    let manualPlan = null;
    let preparationVersion = 0;
    let manualClickInProgress = false;
    els.randomizeButton.disabled = true;

    function invalidateManual() {
        ++preparationVersion;
        manualPlan = null;
        els.randomizeButton.disabled = true;
        els.randomizeButton.title = 'Loading mods…';
    }
    async function prepareManual() {
        invalidateManual();
        const version = preparationVersion;
        try {
            const plan = await sendMsg('prepareManualRandomization');
            if (version !== preparationVersion) return;
            manualPlan = plan;
            els.randomizeButton.title = plan ? '' : 'No mods available in this profile';
        } catch (error) {
            if (version === preparationVersion) showError(error.message);
        } finally {
            if (version === preparationVersion) els.randomizeButton.disabled = manualClickInProgress || !manualPlan;
        }
    }

    function offerReinstall(mod) {
        showModMessage(mod, true);
        showMissedNotificationMessage(mod, () => {
            uninstallFromGesture(mod, error => {
                if (error) {
                    showError(error.message || 'Uninstall cancelled.');
                    return;
                }
                sendMsg('clearMissedNotification', { modId: mod.id }).catch(error => showError(error.message));
                if (isSidebar) clearEnabledMessage();
                else window.close();
            }, chrome);
        });
    }
    async function handleMissedNotification(mod) {
        const s = await storageGet('uninstallAndReinstallChecked');
        if (s.uninstallAndReinstallChecked !== false) offerReinstall(mod);
    }

    // Helper for hideMissedNotification
    function hideNotification() {
        clearEnabledMessage();
        removeRedirectMessage();
    }

    // Transient events use ports; durable state updates use storage.onChanged.
    port.onMessage.addListener(async (msg) => {
        if (!msg || !msg.action) return;

        if (msg.action === 'uninstallFailed') showError(msg.message);

        if (msg.action === 'extensionsUpdated') {
            await loadAndRenderProfiles();
            const { pendingNotification: pending } = await storageGet('pendingNotification');
            if (pending?.uninstallMode) await handleMissedNotification({ id: pending.modId, name: pending.modName, reinstallUrl: pending.reinstallUrl });
            await renderExtensionList();
            await refreshCurrentMod();
            await prepareManual();
        }
    });

    // 3. UI Helper: Refresh Active Mod Text
    async function refreshCurrentMod() {
        const s = await storageGet('currentMod');
        const name = s.currentMod || 'None';
        if (els.currentMod) els.currentMod.textContent = `Active Mod: ${name}`;
    }

    // 4. Initialization Logic
    (async function init() {
        document.getElementById('modForm')?.addEventListener('submit', e => e.preventDefault());

        clearEnabledMessage();
        removeRedirectMessage();

        // Defaults
        const sInitial = await storageGet('autoModIdentificationChecked');
        if (sInitial.autoModIdentificationChecked === undefined) {
            await storageSet({ autoModIdentificationChecked: false });
            if (els.autoModToggle) els.autoModToggle.checked = false;
        }

        // Notify background
        await sendMsg('popupOpened');

        // Load Toggles & Inputs
        const s = await storageGet([
            'autoModIdentificationChecked', 'uninstallAndReinstallChecked',
            'openModsTabChecked', 'showNotificationsChecked',
            'toggleRandomizeOnStartupChecked', 'toggleRandomizeOnSetTimeChecked',
            'randomizeTime', 'timeUnit', 'currentMod', 'pendingNotification',
            'disableModsOutsideProfileChecked', 'shuffleBagChecked'
        ]);

        if (els.shuffleBagToggle) els.shuffleBagToggle.checked = s.shuffleBagChecked !== false;
        const randomizeAll = s.autoModIdentificationChecked === undefined ? false : !!s.autoModIdentificationChecked;
        if (els.autoModToggle) els.autoModToggle.checked = randomizeAll;
        if (els.disableOutsideProfileToggle) els.disableOutsideProfileToggle.checked = !!s.disableModsOutsideProfileChecked;
        if (els.openModsToggle) els.openModsToggle.checked = s.uninstallAndReinstallChecked === undefined ? true : !!s.uninstallAndReinstallChecked;
        if (els.openModsTabToggle) els.openModsTabToggle.checked = s.openModsTabChecked === undefined ? true : !!s.openModsTabChecked;
        if (els.showNotificationsToggle) els.showNotificationsToggle.checked = s.showNotificationsChecked === undefined ? true : !!s.showNotificationsChecked;
        if (els.startupToggle) els.startupToggle.checked = !!s.toggleRandomizeOnStartupChecked;
        if (els.setTimeToggle) els.setTimeToggle.checked = !!s.toggleRandomizeOnSetTimeChecked;

        const unit = s.timeUnit || 'minutes';
        if (els.timeUnit) {
            els.timeUnit.value = unit;
            els.timeUnit.dataset.previousUnit = unit;
        }
        if (els.timeInput) {
            els.timeInput.value = (s.randomizeTime === 0)
                ? ''
                : ((s.randomizeTime || s.randomizeTime === 0) ? fromMinutesFormat(s.randomizeTime, unit) : '');
        }

        const isUninstallOn = s.uninstallAndReinstallChecked === undefined ? true : !!s.uninstallAndReinstallChecked;
        if (s.pendingNotification && s.pendingNotification.uninstallMode && isUninstallOn) {
            const mod = {
                id: s.pendingNotification.modId,
                name: s.pendingNotification.modName,
                reinstallUrl: s.pendingNotification.reinstallUrl
            };
            offerReinstall(mod);
        }

        await loadAndRenderProfiles();
        await renderExtensionList();
        await refreshCurrentMod();
        await prepareManual();

    })();

    // 6. Event Handlers

    // Profile Change
    els.profileSelect.addEventListener('change', async (e) => {
        const profileName = e.target.value;
        if (getRenderLock()) { e.target.value = getCurrentProfile(); return; }

        invalidateManual();
        setCurrentProfile(profileName);
        await sendMsg('setActiveProfile', { profileName });
        console.log('Profile switched to', profileName);
        await renderExtensionList(profileName);
    });

    // New Profile
    els.newProfileBtn.addEventListener('click', async () => {
        const nameRaw = await customPrompt('Enter profile name:', '', 'New Profile');
        const name = (nameRaw || '').trim();
        if (!name) return;

        const resp = await sendMsg('getExtensions');
        const profiles = resp?.profiles || {};
        if (Object.keys(profiles).some(n => n.toLowerCase() === name.toLowerCase())) {
            await customAlert('A profile with this name already exists.');
            return;
        }

        const r = await sendMsg('createProfile', { profileName: name });
        if (r && r.status === 'success') {
            await sendMsg('setActiveProfile', { profileName: name });
            setCurrentProfile(name);

            // Just reload all profiles to be safe
            await loadAndRenderProfiles();
            await renderExtensionList();
        } else {
            await customAlert(r && r.message ? r.message : 'Failed to create profile');
        }
    });

    // Delete Profile
    els.deleteProfileBtn.addEventListener('click', async () => {
        const profileName = els.profileSelect.value;
        const confirmed = await customConfirmDanger(
            `Delete profile "${profileName}"? This cannot be undone.`,
            'Delete Profile'
        );
        if (!confirmed) return;

        const r = await sendMsg('deleteProfile', { profileName });
        if (r && r.status === 'success') {
            await loadAndRenderProfiles();
            await renderExtensionList();
        } else {
            await customAlert(r && r.message ? r.message : 'Delete failed');
        }
    });

    // Import/Export
    const exportProfileBtn = document.getElementById('exportProfileBtn');
    if (exportProfileBtn) exportProfileBtn.addEventListener('click', exportProfiles);

    const importProfileBtn = document.getElementById('importProfileBtn');
    const importFileInput = document.getElementById('importFileInput');
    if (importProfileBtn && importFileInput) {
        importProfileBtn.addEventListener('click', () => importFileInput.click());
        importFileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (file) {
                await importProfiles(file, showImportResults);
                importFileInput.value = '';
            }
        });
    }

    // Toggle Handlers
    async function onToggleChange(key, inputEl) {
        invalidateManual();
        await storageSet({ [key]: inputEl.checked });
        console.log(`Toggle changed: ${key} = ${inputEl.checked}`);

        if (key === 'autoModIdentificationChecked') {
            await sendMsg('identifyModExtensions');
            await renderExtensionList();
        }
        if (key === 'toggleRandomizeOnSetTimeChecked') {
            await sendMsg('toggleRandomizeOnSetTimeChecked', { value: inputEl.checked });
        }
        if (key === 'uninstallAndReinstallChecked' && !inputEl.checked) {
            chrome.runtime.sendMessage({ action: 'clearMissedNotification' });
        }
        await prepareManual();
    }

    els.shuffleBagToggle?.addEventListener('change', async () => {
        invalidateManual();
        const value = els.shuffleBagToggle.checked;
        try {
            await sendMsg('setShuffleBag', { value });
        } catch (error) {
            const s = await storageGet('shuffleBagChecked');
            els.shuffleBagToggle.checked = s.shuffleBagChecked !== false;
            showError(error.message);
            await prepareManual();
        }
    });
    els.autoModToggle.addEventListener('change', () => onToggleChange('autoModIdentificationChecked', els.autoModToggle));
    if (els.disableOutsideProfileToggle) {
        els.disableOutsideProfileToggle.addEventListener('change', () => onToggleChange('disableModsOutsideProfileChecked', els.disableOutsideProfileToggle));
    }
    els.openModsToggle.addEventListener('change', () => onToggleChange('uninstallAndReinstallChecked', els.openModsToggle));
    els.openModsTabToggle.addEventListener('change', () => onToggleChange('openModsTabChecked', els.openModsTabToggle));
    els.showNotificationsToggle.addEventListener('change', () => onToggleChange('showNotificationsChecked', els.showNotificationsToggle));
    els.startupToggle.addEventListener('change', () => onToggleChange('toggleRandomizeOnStartupChecked', els.startupToggle));
    els.setTimeToggle.addEventListener('change', () => onToggleChange('toggleRandomizeOnSetTimeChecked', els.setTimeToggle));

    // Time Input
    let timeDebounce = null;
    let lastSubmittedMinutes = null;

    async function onTimeInputChange(evt) {
        if (timeDebounce) clearTimeout(timeDebounce);
        const inputEl = evt?.target || els.timeInput;
        const unitEl = els.timeUnit;
        if (!inputEl || !unitEl) return;

        timeDebounce = setTimeout(async () => {
            const raw = inputEl.value;
            const unit = unitEl.value;

            if (!raw && raw !== '0') {
                // await sendMsg('setRandomizeTime', { time: 0 }); // Actually treating empty as disabled/0
                // Not strictly safe if user is just clearing to type new, but existing logic did this
                return;
            }

            const parsed = parseFloat(raw);
            if (isNaN(parsed)) {
                await customAlert('Invalid time value');
                return;
            }
            if (parsed === 0) {
                lastSubmittedMinutes = null;
                await sendMsg('setRandomizeTime', { time: 0 });
                els.timeInput.value = '';
                return;
            }

            // Validations
            if (unit === 'minutes' && parsed < 1 && parsed !== 0.25) {
                await customAlert('Randomize time must be at least 1 minute.');
                return;
            }
            if ((unit === 'hours' || unit === 'days') && parsed < 1) {
                await customAlert(`Randomize time must be at least 1 ${unit}.`);
                return;
            }

            const minutes = toMinutes(parsed, unit);
            if (lastSubmittedMinutes === minutes) return;
            await sendMsg('setRandomizeTime', { time: minutes });
            lastSubmittedMinutes = minutes;

        }, 400);
    }

    async function onTimeUnitChange(evt) {
        const unitEl = evt?.target || els.timeUnit;
        if (!unitEl) return;
        await storageSet({ timeUnit: unitEl.value });

        const s = await storageGet('randomizeTime');
        const minutes = s.randomizeTime;
        if (minutes && minutes > 0) {
            els.timeInput.value = fromMinutesFormat(minutes, unitEl.value);
        }
    }

    if (els.timeInput) els.timeInput.addEventListener('input', onTimeInputChange);
    if (els.timeUnit) els.timeUnit.addEventListener('change', onTimeUnitChange);

    // Search
    els.searchBar.addEventListener('input', () => {
        const q = els.searchBar.value.trim().toLowerCase();
        for (const li of Array.from(els.extensionList.children)) {
            const text = li.textContent.toLowerCase();
            li.style.display = text.includes(q) ? '' : 'none';
        }
    });

    // Bulk Toggles
    if (els.toggleAllBtn) {
        els.toggleAllBtn.addEventListener('click', async () => {
            if (els.extensionList.classList.contains('disabled')) return;
            const checkboxes = els.extensionList.querySelectorAll('input[type="checkbox"]');
            if (!checkboxes.length) return;

            const allChecked = Array.from(checkboxes).every(cb => cb.checked);
            checkboxes.forEach(cb => { cb.checked = !allChecked; });
            await triggerManualSave();
        });
    }
    if (els.reverseAllBtn) {
        els.reverseAllBtn.addEventListener('click', async () => {
            if (els.extensionList.classList.contains('disabled')) return;
            const checkboxes = els.extensionList.querySelectorAll('input[type="checkbox"]');
            if (!checkboxes.length) return;
            checkboxes.forEach(cb => { cb.checked = !cb.checked; });
            await triggerManualSave();
        });
    }

    // Randomize Button
    let redirectTimeoutId = null;

    els.randomizeButton.addEventListener('click', () => {
        if (els.randomizeButton.disabled || !manualPlan || manualClickInProgress || getRenderLock()) return;
        const plan = manualPlan;
        manualClickInProgress = true;
        els.randomizeButton.disabled = true;
        if (plan.reinstallUrl) {
            let finishedSynchronously = false;
            // This must be the first API call: no await, storage, or message first.
            uninstallFromGesture(plan, error => {
                finishedSynchronously = true;
                (async () => {
                    try {
                        if (error) {
                            await sendMsg('cancelManualRandomization', { token: plan.token });
                            showError(error.message || 'Uninstall cancelled.');
                        } else {
                            await sendMsg('completeManualRandomization', { token: plan.token });
                            if (!isSidebar) window.close();
                        }
                    } catch (completionError) {
                        showError(completionError.message);
                    } finally {
                        manualClickInProgress = false;
                        await prepareManual();
                    }
                })();
            }, chrome, { openStore: false });
            if (!finishedSynchronously) {
                sendMsg('beginManualRandomization', { token: plan.token }).catch(error => showError(error.message));
            }
            return;
        }
        (async () => {
            try {
                if (redirectTimeoutId) { clearTimeout(redirectTimeoutId); redirectTimeoutId = null; }
                removeRedirectMessage();
                const mod = await sendMsg('enablePreparedManualRandomization', { token: plan.token });
                await showModMessage(mod, els.openModsToggle.checked);
                if (mod.modsTabUrl) {
                    showRedirectMessage();
                    redirectTimeoutId = setTimeout(() => {
                        removeRedirectMessage();
                        chrome.tabs.create({ url: mod.modsTabUrl });
                        if (isSidebar) clearEnabledMessage();
                        else window.close();
                    }, 3000);
                }
            } catch (error) {
                showError(error.message || 'Could not switch mods.');
            } finally {
                manualClickInProgress = false;
                await prepareManual();
            }
        })();
    });

    // Storage Listener
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const manualKeys = [
            'profiles', 'activeProfile', 'detectedModList', 'autoModIdentificationChecked',
            'uninstallAndReinstallChecked', 'shuffleBagChecked', 'shuffleBags',
            'lastEnabledModId', 'disableModsOutsideProfileChecked'
        ];
        if (manualKeys.some(key => changes[key])) prepareManual();
        if (changes.currentMod) refreshCurrentMod();
        if (changes.shuffleBagChecked && els.shuffleBagToggle) {
            els.shuffleBagToggle.checked = changes.shuffleBagChecked.newValue !== false;
        }
        if (changes.pendingNotification) {
            const pending = changes.pendingNotification.newValue;
            if (pending?.uninstallMode) handleMissedNotification({ id: pending.modId, name: pending.modName, reinstallUrl: pending.reinstallUrl });
            else hideNotification();
        }

        const shouldReloadProfiles =
            (changes.profiles && typeof changes.profiles.newValue === 'object' && typeof changes.profiles.oldValue === 'object' &&
                Object.keys(changes.profiles.newValue || {}).join('|') !== Object.keys(changes.profiles.oldValue || {}).join('|'))
            || !!changes.activeProfile;

        const extensionRenderKeys = new Set([
            'profiles',
            'profilesOrder',
            'activeProfile',
            'detectedModList',
            'autoModIdentificationChecked',
            'recentlyUninstalled'
        ]);
        const shouldRenderExtensionList = Object.keys(changes).some(k => extensionRenderKeys.has(k));

        if (shouldReloadProfiles) loadAndRenderProfiles();
        if (shouldRenderExtensionList) renderExtensionList();
    });

});

