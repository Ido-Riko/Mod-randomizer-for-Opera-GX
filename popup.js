// popup.js (rewritten)
// - Uses existing HTML IDs only
// - Profiles via profileSelect + New/Delete buttons (rename by double-click on select)
// - Keeps profilesOrder in storage so items remain visible & ordered even if unchecked
// - Shows only detected mods + profile-known mods
// - Disables manual list visually when auto-identify is ON
// - Proper time conversion and display (no misleading "0")
// - Logs actions to console for debugging
// THIS MUST BE AT THE TOP LEVEL (global scope)
const port = chrome.runtime.connect({ name: 'popup' });
const isSidebar = window.location.pathname.includes('sidebar.html');
document.addEventListener('DOMContentLoaded', () => {
    const els = {
        profileSelect: document.getElementById('profileSelect'),
        newProfileBtn: document.getElementById('newProfileBtn'),
        deleteProfileBtn: document.getElementById('deleteProfileBtn'),
        autoModToggle: document.getElementById('randomizeAllMods'),
        openModsToggle: document.getElementById('uninstallAndReinstall'),
        openModsTabToggle: document.getElementById('openModsTab'),
        showNotificationsToggle: document.getElementById('showNotifications'),
        startupToggle: document.getElementById('toggleRandomizeOnStartup'),
        setTimeToggle: document.getElementById('toggleRandomizeOnSetTime'),
        timeInput: document.getElementById('timeInput'),
        timeUnit: document.getElementById('timeUnitSelect'),
        randomizeButton: document.getElementById('randomizeButton'),
        extensionList: document.getElementById('extensionList'),
        searchBar: document.getElementById('searchBar'),
        currentMod: document.getElementById('current-mod'),
        message: document.getElementById('message'),
        toggleAllBtn: document.getElementById('toggleAllBtn'),
        reverseAllBtn: document.getElementById('reverseAllBtn')

};


    // --- Port connection for robust messaging ---

    // Listen for messages from background via port
    port.onMessage.addListener(async (msg) => {
        if (!msg || !msg.action) return;

        if (msg.action === 'randomizationCompleted' && msg.enabledExtension) {
            await showModMessage(msg.enabledExtension, false);
            refreshCurrentMod();
            console.log('Popup received randomizationCompleted via port');
            // Acknowledge receipt so background can clear pendingRandomization
            if (msg.pendingId) {
                port.postMessage({ action: 'randomizationAck', pendingId: msg.pendingId });
            }
        }
    });
    // Track which profile the UI is currently rendering/working with to avoid saving to a wrong profile on quick switches
    let currentProfile = null;
    let renderLock = false; // prevents mid-save re-renders that can drop fast clicks
    let manualSaveDebounce = null; // single debouncer reused across renders
    let pendingSaveProfile = null; // profile name for which the debounced save will run

    // Keep the existing hr below the Randomize button untouched.
    // Create messages right after that hr, and a temporary hr between messages and the manual section.
    // Structure:
    //   [Randomize Button]
    //   [permanent hr (#message-hr)]
    //   [enabledArea]
    //   [redirectArea]
    //   [temporary hr (#message-temp-hr)]
    //   [Manual section...]





    // --- Helpers for chrome APIs ---
    const storageGet = (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve));
    const storageSet = (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve));
    const sendMsg = (action, data = {}) =>
        new Promise(resolve => chrome.runtime.sendMessage({ action, ...data }, (res) => {
            if (chrome.runtime.lastError) {
                console.warn('sendMsg lastError:', chrome.runtime.lastError.message);
            }
            resolve(res);
        }));

    // --- Formatting helpers for time units ---
    function toMinutes(value, unit) {
        const v = parseFloat(value);
        if (isNaN(v)) return NaN;
        if (unit === 'minutes') return v;
        if (unit === 'hours') return v * 60;
        if (unit === 'days') return v * 24 * 60;
        return v;
    }
    function fromMinutesFormat(minutes, unit) {
        if (minutes === undefined || minutes === null) return '';
        const m = Number(minutes);
        if (isNaN(m)) return '';

        let v;
        if (unit === 'minutes') v = m;
        else if (unit === 'hours') v = m / 60;
        else if (unit === 'days') v = m / (24 * 60);
        else v = m;

        // Decide decimals: >=1 -> 2 decimals max (trim); <1 -> up to 4 decimals
        if (Math.abs(v) >= 1) {
            return trimZeros(v.toFixed(2));
        } else {
            return trimZeros(v.toFixed(4));
        }
    }
    function trimZeros(s) {
        // remove trailing zeros and possible trailing dot
        return s.replace(/\.?0+$/, '');
    }

    // --- Profile order storage helpers ---
    // profilesOrder: { profileName: [id1,id2,...] } stored in chrome.storage.local
    async function ensureProfilesOrder(profiles) {
        const st = await storageGet('profilesOrder');
        let profilesOrder = st.profilesOrder || {};
        let changed = false;
        for (const profileName of Object.keys(profiles)) {
            if (!profilesOrder[profileName]) {
                profilesOrder[profileName] = Array.isArray(profiles[profileName]) ? [...profiles[profileName]] : [];
                changed = true;
            } else {
                // ensure any enabled ids are present in order
                const enabled = Array.isArray(profiles[profileName]) ? profiles[profileName] : [];
                for (const id of enabled) {
                    if (!profilesOrder[profileName].includes(id)) {
                        profilesOrder[profileName].push(id);
                        changed = true;
                    }
                }
            }
        }
        if (changed) {
            await storageSet({ profilesOrder });
            console.log('Initialized/updated profilesOrder');
        }
        return profilesOrder;
    }

    // --- UI updates: profiles ---
    async function loadAndRenderProfiles() {
        // Avoid extra background round-trip; only profiles/activeProfile are needed here
        const s = await storageGet(['profiles', 'activeProfile']);
        const profiles = s?.profiles || { Default: [] };
        const activeProfile = s?.activeProfile || Object.keys(profiles)[0] || 'Default';

        // Keep a stable notion of the current profile in the popup:
        // - if currentProfile is unset or missing -> set to activeProfile
        // - otherwise preserve currentProfile (so we don't stomp it during background-triggered refreshes)
        if (!currentProfile || profiles[currentProfile] === undefined) {
            currentProfile = activeProfile;
        }

        // populate select
        els.profileSelect.innerHTML = '';
        for (const name of Object.keys(profiles)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === currentProfile) opt.selected = true;
            els.profileSelect.appendChild(opt);
        }

        // Ensure the select reflects the currentProfile explicitly
        els.profileSelect.value = currentProfile;

        // Make sure profilesOrder exists and includes these profiles
        await ensureProfilesOrder(profiles);

        // Wire rename by double-click on select
        if (!els.profileSelect._hasDbl) {
            els.profileSelect.addEventListener('dblclick', async () => {
                const oldName = els.profileSelect.value;
                const newNameRaw = prompt('Rename profile', oldName);
                const newName = (newNameRaw || '').trim();
                if (!newName || newName === oldName) return;

                // Prevent accidental duplicates (case-insensitive) on the client side
                const names = Object.keys(profiles);
                if (names.some(n => n.toLowerCase() === newName.toLowerCase() && n !== oldName)) {
                    alert('A profile with this name already exists.');
                    return;
                }

                const res = await sendMsg('renameProfile', { oldName, newName });
                if (res && res.status === 'success') {
                    // If we store profilesOrder locally, rename that too
                    const st = await storageGet('profilesOrder');
                    const po = st.profilesOrder || {};
                    if (po[oldName]) {
                        po[newName] = po[oldName];
                        delete po[oldName];
                        await storageSet({ profilesOrder: po });
                    }
                    console.log(`Renamed profile ${oldName} -> ${newName}`);
                    await loadAndRenderProfiles();
                } else {
                    alert(res && res.message ? res.message : 'Rename failed');
                }
            });
            els.profileSelect._hasDbl = true;
        }
    }

    els.profileSelect.addEventListener('change', async (e) => {
        const profileName = e.target.value;
        if (renderLock) return; // avoid switching while a save is in-flight

        // Cancel any pending save tied to previous profile view to avoid cross-profile writes
        if (manualSaveDebounce) {
            clearTimeout(manualSaveDebounce);
            manualSaveDebounce = null;
        }
        pendingSaveProfile = null;

        currentProfile = profileName; // keep popup-local state in sync
        await sendMsg('setActiveProfile', { profileName });
        console.log('Profile switched to', profileName);
        await renderExtensionList();
    });

    els.newProfileBtn.addEventListener('click', async () => {
        const nameRaw = prompt('New profile name:');
        const name = (nameRaw || '').trim();
        if (!name) return;

        // Pre-check duplicates (case-insensitive) to provide faster feedback
        const resp = await sendMsg('getExtensions');
        const profiles = resp?.profiles || {};
        if (Object.keys(profiles).some(n => n.toLowerCase() === name.toLowerCase())) {
            alert('A profile with this name already exists.');
            return;
        }

        // First ask background to create the profile
        const r = await sendMsg('createProfile', { profileName: name });
        if (r && r.status === 'success') {
            // Immediately make it active to avoid rendering the old profile in between
            await sendMsg('setActiveProfile', { profileName: name });
            currentProfile = name;

            // Update the select right away so the UI matches the state
            // (loadAndRenderProfiles will repopulate it, but we set it now to avoid flicker)
            if (els.profileSelect.querySelector(`option[value="${name}"]`) == null) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                els.profileSelect.appendChild(opt);
            }
            els.profileSelect.value = name;

            // Refresh profiles and render the list for the new profile
            await loadAndRenderProfiles();
            await renderExtensionList();
            console.log('Created + switched to profile', name);
        } else {
            alert(r && r.message ? r.message : 'Failed to create profile');
        }
    });

    els.deleteProfileBtn.addEventListener('click', async () => {
        const profileName = els.profileSelect.value;
        if (!confirm(`Delete profile "${profileName}"? This cannot be undone.`)) return;
        const r = await sendMsg('deleteProfile', { profileName });
        if (r && r.status === 'success') {
            // remove from profilesOrder too
            const st = await storageGet('profilesOrder');
            const po = st.profilesOrder || {};
            if (po[profileName]) { delete po[profileName]; await storageSet({ profilesOrder: po }); }
            console.log('Deleted profile', profileName);
            await loadAndRenderProfiles();
            await renderExtensionList();
        } else {
            alert(r && r.message ? r.message : 'Delete failed');
        }
    });

    // --- Extension / manual list rendering ---
    // We render items in the order defined in profilesOrder[active], then any enabled-but-not-in-order, then detected extras.
    async function renderExtensionList() {
        if (renderLock) return;

        // fetch everything
        const resp = await sendMsg('getExtensions');

        // Default randomize-all to ON when key is missing
        const settings = await storageGet('autoModIdentificationChecked');
        const randomizeAll = settings.autoModIdentificationChecked === undefined
            ? true
            : !!settings.autoModIdentificationChecked;

        // Sync toggle UI if needed
        if (els.autoModToggle && els.autoModToggle.checked !== randomizeAll) {
            els.autoModToggle.checked = randomizeAll;
        }
        // Update both sections' disabled state
        const profileSection = document.querySelector('.profile-section');
        if (randomizeAll) {
            els.extensionList.parentElement.classList.add("disabled");
            if (profileSection) profileSection.classList.add("disabled");
        } else {
            els.extensionList.parentElement.classList.remove("disabled");
            if (profileSection) profileSection.classList.remove("disabled");
        }
        // blacken manual section when randomize-all ON
        if (randomizeAll) {
            els.extensionList.parentElement.classList.add("disabled");
        } else {
            els.extensionList.parentElement.classList.remove("disabled");
        }

        const detected = resp?.detectedModList
            || (resp?.extensions ? resp.extensions.filter(e => e.updateUrl === 'https://api.gx.me/store/mods/update').map(e => ({ id: e.id, name: e.name })) : []);
        const profiles = resp?.profiles || (await storageGet('profiles')).profiles || { Default: [] };

        // Choose profile for non-randomize mode (preserve currentProfile if valid)
        const active = (currentProfile && profiles[currentProfile] !== undefined)
            ? currentProfile
            : (resp?.activeProfile || (await storageGet('activeProfile')).activeProfile || Object.keys(profiles)[0] || 'Default');

        // Remember which profile this list belongs to (used only when randomize-all is OFF and by the debounced saver)
        els.extensionList.dataset.profile = active;

        // When randomize-all is OFF, show the saved state; when ON, we will force-check visually
        const profileList = Array.isArray(profiles[active]) ? profiles[active] : [];

        const detectedMap = new Map((detected || []).map(d => [d.id, d.name]));

        // profilesOrder from storage
        const st = await storageGet('profilesOrder');
        let profilesOrder = st.profilesOrder || {};
        if (!profilesOrder[active]) {
            profilesOrder[active] = [...profileList];
            await storageSet({ profilesOrder });
        }

        // Build display order
        const order = profilesOrder[active].slice();
        const seen = new Set(order);
        for (const id of profileList) if (!seen.has(id)) { order.push(id); seen.add(id); }
        for (const d of detected) if (!seen.has(d.id)) { order.push(d.id); seen.add(d.id); }

        // Alphabetic sort by mod name (case-insensitive), keeping Unknowns grouped by their label
        const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
        const sortedOrder = order.slice().sort((a, b) => {
            const nameA = (detectedMap.get(a) || 'Unknown Mod (not detected)');
            const nameB = (detectedMap.get(b) || 'Unknown Mod (not detected)');
            return collator.compare(nameA, nameB);
        });

        // Render list
        // In renderExtensionList, before clearing:
        const oldCheckboxes = els.extensionList.querySelectorAll('input[type="checkbox"]');
        oldCheckboxes.forEach(cb => {
            cb.removeEventListener('change', onManualCheckboxChange);
        });
        els.extensionList.innerHTML = '';
        els.extensionList.classList.toggle('disabled', randomizeAll);

        for (const id of sortedOrder) {
            const name = detectedMap.get(id) || 'Unknown Mod (not detected)';
            const li = document.createElement('li');
            li.dataset.extid = id;

            const label = document.createElement('span');
            label.textContent = name;
            label.title = name;
            label.style.flex = '1';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.extid = id;

            if (randomizeAll) {
                // Show all as checked visually, but do not save any changes while in this mode
                cb.checked = true;
                cb.disabled = true;
            } else {
                // Reflect real saved state from the current profile
                cb.checked = profileList.includes(id);
                cb.disabled = false;
                cb.addEventListener('change', onManualCheckboxChange);
            }

            li.appendChild(cb);
            li.appendChild(label);
            els.extensionList.appendChild(li);
        }


        console.log(`Rendered manual list for profile ${active} entries ${sortedOrder.length} (detected=${detected.length}, randomizeAll=${randomizeAll})`);
    }

    // When a checkbox changes: save checked ids to active profile but KEEP order in profilesOrder (don't remove unchecked)
    // use the existing manualSaveDebounce declared earlier
    async function onManualCheckboxChange() {
        // Optimistically prevent re-renders for a short time so fast clicks are not lost
        renderLock = true;

        // debounce quick toggles
        if (manualSaveDebounce) clearTimeout(manualSaveDebounce);

        // Capture the profile this list is for at the moment of the change
        pendingSaveProfile = els.extensionList.dataset.profile || currentProfile || 'Default';

        manualSaveDebounce = setTimeout(async () => {
            const checkedIds = Array.from(els.extensionList.querySelectorAll('input[type="checkbox"]'))
                .filter(cb => cb.checked)
                .map(cb => cb.dataset.extid);

            // Save strictly to the profile that this list was rendered for
            const active = pendingSaveProfile || 'Default';

            // Update profilesOrder to include any newly checked ids if missing (append at end), but DO NOT remove unchecked ids.
            const st = await storageGet('profilesOrder');
            const profilesOrder = st.profilesOrder || {};
            profilesOrder[active] = profilesOrder[active] || [];

            let changed = false;
            for (const id of checkedIds) {
                if (!profilesOrder[active].includes(id)) { profilesOrder[active].push(id); changed = true; }
            }
            if (changed) {
                await storageSet({ profilesOrder });
                console.log('Updated profilesOrder after manual save');
            }

            // Save the currently checked ids as the profile's enabled list
            const saveRes = await sendMsg('saveModExtensionIds', { modExtensionIds: checkedIds, profileName: active });
            console.log(`Saved ${checkedIds.length} mods to profile "${active}"`, saveRes);

            pendingSaveProfile = null;

            // Release the render lock shortly after save to keep UI responsive on bursts
            setTimeout(() => { renderLock = false; }, 100);
        }, 120);
    }

    // --- Search filter ---
    function onSearchInput() {
        const q = els.searchBar.value.trim().toLowerCase();
        for (const li of Array.from(els.extensionList.children)) {
            const text = li.textContent.toLowerCase();
            li.style.display = text.includes(q) ? '' : 'none';
        }
    }

    function showRedirectMessage() {
        const { redirectArea } = ensureMessageAreas();

        // Clear any existing redirect message
        redirectArea.innerHTML = '';

        const placeholder = document.createElement('p');
        placeholder.className = 'redirect-message';
        placeholder.textContent = 'Redirecting to enable checkmarks';
        let dots = '';
        const interval = setInterval(() => {
            dots = dots.length < 3 ? dots + '.' : '';
            placeholder.textContent = 'Redirecting to enable checkmarks' + dots;
        }, 300);
        placeholder.dataset.intervalId = String(interval);

        redirectArea.appendChild(placeholder);
        ensureTempSeparator();
    }

    function removeRedirectMessage() {
        const redirectArea = document.getElementById('redirect-area');
        if (redirectArea) {
            // Stop any running animation timer
            const el = redirectArea.querySelector('.redirect-message');
            if (el?.dataset.intervalId) clearInterval(parseInt(el.dataset.intervalId));
            redirectArea.innerHTML = '';
        }
        // Remove message-hr and areas if both are empty
        removeMessageAreasIfEmpty();
    }

    function removeMessageAreasIfEmpty() {
        const enabledArea = document.getElementById('enabled-area');
        const redirectArea = document.getElementById('redirect-area');
        const permanentHr = document.getElementById('message-hr');
        const tempHr = document.getElementById('message-temp-hr');

        // Check if both areas are empty
        const enabledEmpty = !enabledArea || enabledArea.childElementCount === 0;
        const redirectEmpty = !redirectArea || redirectArea.childElementCount === 0;

        if (enabledEmpty && redirectEmpty) {
            // Remove all message-related elements
            if (enabledArea) enabledArea.remove();
            if (redirectArea) redirectArea.remove();
            if (permanentHr) permanentHr.remove();
            if (tempHr) tempHr.remove();
        }
    }

    // Auto-clear timer for enabled message (for when "Open mods tab" is OFF)

    let enabledAutoClearTimerId = null;
    let uninstallAutoClearTimerId = null;
    let messageAutoClearTimerId = null;
// Keep the existing hr below the Randomize button untouched.
// Create messages right after that hr, and a temporary hr between messages and the manual section.
// Structure:
//   [Randomize Button]
//   [permanent hr (#message-hr)]
//   [enabledArea]
//   [redirectArea]
//   [temporary hr (#message-temp-hr)]
//   [Manual section...]
    function ensureMessageAreas() {
        // Permanent separator that already exists in HTML
        let permanentHr = document.getElementById('message-hr');
        if (!permanentHr) {
            permanentHr = document.createElement('hr');
            permanentHr.id = 'message-hr';
            els.randomizeButton.insertAdjacentElement('afterend', permanentHr);
        }
        // Ensure enabledArea immediately after the permanent hr
        let enabledArea = document.getElementById('enabled-area');
        if (!enabledArea) {
            enabledArea = document.createElement('div');
            enabledArea.id = 'enabled-area';
            permanentHr.insertAdjacentElement('afterend', enabledArea);
        } else {
            // Make sure it's placed right after the permanent hr
            if (permanentHr.nextElementSibling !== enabledArea) {
                permanentHr.insertAdjacentElement('afterend', enabledArea);
            }
        }
        // Ensure redirectArea right after enabledArea
        let redirectArea = document.getElementById('redirect-area');
        if (!redirectArea) {
            redirectArea = document.createElement('div');
            redirectArea.id = 'redirect-area';
            enabledArea.insertAdjacentElement('afterend', redirectArea);
        } else if (redirectArea.previousElementSibling !== enabledArea) {
            enabledArea.insertAdjacentElement('afterend', redirectArea);
        }
        return { permanentHr, enabledArea, redirectArea };
    }

// Ensure a temporary separator after whichever message area is active
    function ensureTempSeparator() {
        const { enabledArea, redirectArea } = ensureMessageAreas();
        let tempHr = document.getElementById('message-temp-hr');
        if (!tempHr) {
            tempHr = document.createElement('hr');
            tempHr.id = 'message-temp-hr';
        }
        // Prefer placing after redirectArea if it has content; else after enabledArea
        const anchor = (redirectArea && redirectArea.childElementCount > 0) ? redirectArea : enabledArea;
        if (anchor && anchor.nextElementSibling !== tempHr) {
            anchor.insertAdjacentElement('afterend', tempHr);
        }
    }



    function clearEnabledMessage() {
        const enabledArea = document.getElementById('enabled-area');
        if (enabledArea) {
            enabledArea.innerHTML = '';
        }
        // Remove message-hr and areas if both are empty
        removeMessageAreasIfEmpty();
    }


    // Global timers
    let autoClearTimerId = null;
    let redirectTimeoutId = null;
    let redirectIntervalId = null;
    /**
     * Displays a simple loading or status message in the UI.
     * @param {string} message The text to display.
     */
// Unified message function
    async function showModMessage(mod, uninstallAndReinstall) {
        const { enabledArea, redirectArea } = ensureMessageAreas();

        // Clear previous timers
        [autoClearTimerId, redirectTimeoutId, redirectIntervalId].forEach(id => {
            if (id) clearTimeout(id);
        });
        autoClearTimerId = redirectTimeoutId = redirectIntervalId = null;

        enabledArea.innerHTML = '';
        redirectArea.innerHTML = '';

        const d = document.createElement('div');
        d.id = 'modMessage';
        d.style.textAlign = 'center';

        const messageText = document.createElement('div');
        messageText.style.color = 'var(--success)';
        messageText.style.marginBottom = '8px';

        // Handle missing URL in uninstall mode
        if (uninstallAndReinstall && !mod.reinstallUrl) {
            const name = mod.name ? escapeHtml(mod.name) : '(unknown)';
            messageText.innerHTML = `URL missing- Enabled: <span class="mod-name">${name}</span>`;
        } else {
            console.log("Url is "+ mod.reinstallUrl) ;
            const label = uninstallAndReinstall ? 'Chose Mod' : 'Enabled Mod';
            const name = mod.name ? escapeHtml(mod.name) : '(unknown)';
            messageText.innerHTML = `${label}: <span class="mod-name">${name}</span>`;
        }


        d.appendChild(messageText);
        enabledArea.appendChild(d);

        ensureTempSeparator();
    }

    /**
     * Handles the main "Randomize" button click.
     * Depending on user settings, it either just navigates to a mod
     * or initiates an uninstall and opens the reinstall page.
     */
    /**
     * This is the main function that should be tied to your "Randomize" button's click event.
     */
// This should be your main "Randomize" button's click handler
// Modify onRandomizeClick:
    async function onRandomizeClick() {
        try {
            // Cancel any existing redirect
            if (redirectTimeoutId) {
                clearTimeout(redirectTimeoutId);
                redirectTimeoutId = null;
                console.log('Cancelled previous redirect timer');
            }

            const st = await chrome.storage.local.get('uninstallAndReinstallChecked');
            const uninstallAndReinstall = !!st.uninstallAndReinstallChecked;

            const modToProcess = await chrome.runtime.sendMessage({
                action: 'getRandomMod',
                uninstallAndReinstall: uninstallAndReinstall
            });

            if (!modToProcess || !modToProcess.id) {
                alert('No mod was found to randomize.');
                return;
            }

            console.log('Received mod from background:', modToProcess.name);

            if (uninstallAndReinstall && modToProcess.reinstallUrl) {
                await showModMessage(modToProcess, true);
                chrome.tabs.create({ url: modToProcess.reinstallUrl });

                chrome.management.uninstall(modToProcess.id, { showConfirmDialog: true }, () => {
                    if (chrome.runtime.lastError) {
                        console.log('Uninstall cancelled');
                        // Clear message if uninstall was cancelled
                        if (isSidebar) {
                            setTimeout(() => {
                                clearEnabledMessage();
                            }, 500);
                        }
                    } else {
                        console.log('Mod uninstalled, closing popup');
                        if (isSidebar) {
                            // Sidebar mode: just clear the message
                            clearEnabledMessage();
                        } else {
                            window.close();
                        }
                    }
                });
            } else {
                await showModMessage(modToProcess, uninstallAndReinstall && !modToProcess.reinstallUrl);

                // Only show redirect message and redirect if modsTabUrl is provided
                if (modToProcess.modsTabUrl) {
                    showRedirectMessage();

                    // Store timeout ID so it can be cancelled on next click
                    redirectTimeoutId = setTimeout(() => {
                        removeRedirectMessage();
                        chrome.tabs.create({ url: modToProcess.modsTabUrl });

                        if (isSidebar) {
                            // In sidebar mode, also clear the enabled message since window doesn't close
                            clearEnabledMessage();
                        } else {
                            window.close();
                        }
                    }, 3000);
                }else {
                    // No redirect - just show the message
                    console.log('Mod enabled, no redirect (Open mods tab is OFF)');
                }
            }

        } catch (error) {
            console.error('Error in randomization flow:', error);
            showError(error.message || 'An unknown error occurred.');
        }
    }    function escapeHtml(s) {
        return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }


// Basic error message
    function showError(text) {
        els.message.textContent = text;
        setTimeout(() => { if (els.message.textContent === text) els.message.textContent = ''; }, 4000);
    }


    // --- Time input handling ---
    let timeDebounce = null;
    let lastSubmittedMinutes = null; // prevent duplicate sends of the same effective value

    async function onTimeInputChange(evt) {
        if (timeDebounce) clearTimeout(timeDebounce);
        const inputEl = evt?.target || els.timeInput;
        const unitEl = els.timeUnit;
        // If inputs are missing, do nothing safely
        if (!inputEl || !unitEl) return;

        // Quick diagnostic so you see a log immediately when typing/changing
        console.log('Time input changed:', inputEl.value, 'unit=', unitEl.value);

        timeDebounce = setTimeout(async () => {
            const raw = inputEl.value;
            const unit = unitEl.value;

            // Helper to skip duplicates and send
            const maybeSend = async (minutesToSet) => {
                if (lastSubmittedMinutes === minutesToSet) {
                    console.log('Time unchanged; ignoring duplicate set:', minutesToSet, 'minutes');
                    return;
                }
                lastSubmittedMinutes = minutesToSet;
                await sendMsg('setRandomizeTime', { time: minutesToSet });
                if (minutesToSet === 0) {
                    console.log('Time disabled (0 or empty)');
                } else {
                    console.log('Time set ->', minutesToSet, 'minutes');
                }
            };

            if (!raw && raw !== '0') {
                // treat empty as disabled
                await maybeSend(0);
                return;
            }

            const parsed = parseFloat(raw);
            if (isNaN(parsed)) {
                alert('Invalid time value');
                return;
            }

            // If explicitly set to 0, disable and clear input so placeholder shows
            if (parsed === 0) {
                await maybeSend(0);
                els.timeInput.value = '';
                return;
            }

            // allow 0.25 only for minutes
            if (unit === 'minutes' && parsed === 0.25) {
                await maybeSend(0.25);
                console.log('Time set -> 0.25 minutes (test)');
                return;
            }

            // validation
            if (unit === 'minutes' && parsed < 1) {
                alert('Randomize time must be at least 1 minute (or 0.25 for testing) or 0 to disable.');
                return;
            }
            if ((unit === 'hours' || unit === 'days') && parsed < 1) {
                alert(`Randomize time must be at least 1 ${unit} or 0 to disable.`);
                return;
            }

            const minutes = toMinutes(parsed, unit);
            if (isNaN(minutes)) return;

            await maybeSend(minutes);
        }, 400);
    }
    async function cleanupUndetectedMods() {
        const resp = await sendMsg('getExtensions');
        const detected = resp?.detectedModList || [];
        const detectedIds = new Set(detected.map(d => d.id));

        const st = await storageGet(['profilesOrder', 'profiles', 'knownDetectedIds']);
        let changed = false;
        // Only run if we detect a mismatch
        const detectedCount = detected.length;
        const storedCount = (st.knownDetectedIds || []).length;
        if (detectedCount === storedCount) {
            console.log('No cleanup needed');
            return;
        }
        // Clean profilesOrder
        const profilesOrder = st.profilesOrder || {};
        for (const profileName of Object.keys(profilesOrder)) {
            const before = profilesOrder[profileName].length;
            profilesOrder[profileName] = profilesOrder[profileName].filter(id => detectedIds.has(id));
            if (profilesOrder[profileName].length !== before) changed = true;
        }

        // Clean profiles
        const profiles = st.profiles || {};
        for (const profileName of Object.keys(profiles)) {
            const before = profiles[profileName].length;
            profiles[profileName] = profiles[profileName].filter(id => detectedIds.has(id));
            if (profiles[profileName].length !== before) changed = true;
        }

        // Clean knownDetectedIds
        const knownIds = (st.knownDetectedIds || []).filter(id => detectedIds.has(id));

        if (changed || knownIds.length !== (st.knownDetectedIds || []).length) {
            await storageSet({ profilesOrder, profiles, knownDetectedIds: knownIds });
            console.log('Cleaned up undetected mod IDs from storage');
        }
    }
    async function onTimeUnitChange(evt) {
        const unitEl = evt?.target || els.timeUnit;
        if (!unitEl) return;

        console.log('Time unit change fired:', unitEl.value);

        const oldUnit = unitEl.dataset.previousUnit || 'minutes';
        const newUnit = unitEl.value;
        unitEl.dataset.previousUnit = newUnit;
        await storageSet({ timeUnit: newUnit });

        // convert stored minutes value to display
        const s = await storageGet('randomizeTime');
        const minutes = s.randomizeTime;
        if (!els.timeInput) return;
        if (minutes === 0) {
            // 0 means disabled -> show placeholder
            els.timeInput.value = '';
        } else if (minutes) {
            els.timeInput.value = fromMinutesFormat(minutes, newUnit);
        } else {
            els.timeInput.value = '';
        }
        console.log('Time unit changed ->', newUnit);
    }

    // --- Read & display currentMod ---
    async function refreshCurrentMod() {
        const s = await storageGet('currentMod');
        const name = s.currentMod || 'None';
        els.currentMod.textContent = `Active Mod: ${name}`;
    }

    // --- Toggles handlers ---
    async function onToggleChange(key, inputEl) {
        await storageSet({ [key]: inputEl.checked });
        console.log(`Toggle changed: ${key} = ${inputEl.checked}`);

        // In the onToggleChange function for autoModIdentificationChecked:
        if (key === 'autoModIdentificationChecked') {
            const profileSection = document.querySelector('.profile-section');
            if (inputEl.checked) {
                if (profileSection) profileSection.classList.add("disabled");
            } else {
                if (profileSection) profileSection.classList.remove("disabled");
            }
            await sendMsg('identifyModExtensions');
            await renderExtensionList();
        }
        if (key === 'toggleRandomizeOnSetTimeChecked') {
            await sendMsg('toggleRandomizeOnSetTimeChecked', { value: inputEl.checked });
            // Removed extra "Requested toggleRandomizeOnSetTimeChecked" log to avoid duplicate log lines
        }
        if (key === 'uninstallAndReinstallChecked' && !inputEl.checked) {
            // If the user turns off "Open mods tab" while a redirect message is showing, clear the placeholder now
            removeRedirectMessage();
        }
    }
    // --- Event wiring ---
    els.searchBar.addEventListener('input', onSearchInput);


    els.randomizeButton.addEventListener('click', onRandomizeClick);

    els.autoModToggle.addEventListener('change', () => onToggleChange('autoModIdentificationChecked', els.autoModToggle));
    els.openModsToggle.addEventListener('change', () => onToggleChange('uninstallAndReinstallChecked', els.openModsToggle));
    els.openModsTabToggle.addEventListener('change', () => onToggleChange('openModsTabChecked', els.openModsTabToggle));
    els.showNotificationsToggle.addEventListener('change', () => onToggleChange('showNotificationsChecked', els.showNotificationsToggle));
    els.startupToggle.addEventListener('change', () => onToggleChange('toggleRandomizeOnStartupChecked', els.startupToggle));
    els.setTimeToggle.addEventListener('change', () => onToggleChange('toggleRandomizeOnSetTimeChecked', els.setTimeToggle));
// --- Toggle All Mods Button ---
    if (els.toggleAllBtn) {
        els.toggleAllBtn.addEventListener('click', async () => {
            // Don’t run if randomize-all is ON or list disabled
            if (els.extensionList.classList.contains('disabled')) return;

            const checkboxes = els.extensionList.querySelectorAll('input[type="checkbox"]');
            if (!checkboxes.length) return;

            // Determine whether to enable or disable all based on current majority state
            const allChecked = Array.from(checkboxes).every(cb => cb.checked);
            const newState = !allChecked;

            checkboxes.forEach(cb => {
                cb.checked = newState;
            });

            console.log(`ToggleAllMods -> setting all to ${newState ? 'checked' : 'unchecked'}`);
            await onManualCheckboxChange(); // reuse your existing debounced save
        });
    }
    // --- Reverse All Mods Button ---
    if (els.reverseAllBtn) {
        els.reverseAllBtn.addEventListener('click', async () => {
            // Don't allow changes when randomize-all is ON
            if (els.extensionList.classList.contains('disabled')) return;

            const checkboxes = els.extensionList.querySelectorAll('input[type="checkbox"]');
            if (!checkboxes.length) return;

            checkboxes.forEach(cb => {
                cb.checked = !cb.checked; // flip each checkbox
            });

            console.log('ReverseAllMods -> flipped all mod states');
            await onManualCheckboxChange(); // reuse your existing debounce/save
        });
    }


    // Guard these in case the inputs are not present in this build/variant
    if (els.timeInput) {
        // Only listen to 'input' to avoid duplicate sends from 'change'
        els.timeInput.addEventListener('input', onTimeInputChange);
        // Removed: els.timeInput.addEventListener('change', onTimeInputChange);
    }
    if (els.timeUnit) {
        els.timeUnit.addEventListener('change', onTimeUnitChange);
    }

    // Note: Background communication now happens via port (see port.onMessage listener above)
    // No need for runtime.onMessage listener since we use ports

    // React to storage changes to stay up to date
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.currentMod) refreshCurrentMod();

        // If profile names or activeProfile changed, rebuild the select; otherwise avoid stomping currentProfile
        const shouldReloadProfiles =
            (changes.profiles && typeof changes.profiles.newValue === 'object' && typeof changes.profiles.oldValue === 'object' &&
             Object.keys(changes.profiles.newValue || {}).join('|') !== Object.keys(changes.profiles.oldValue || {}).join('|'))
            || !!changes.activeProfile;

        (async () => {
            if (shouldReloadProfiles) {
                await loadAndRenderProfiles();
            }
            // Always re-render the list to pick up state changes, preserving currentProfile
            await renderExtensionList();
        })();
    });

    // --- Initialization on popup open ---
    (async function init() {
        // Prevent default submit behavior
        document.getElementById('modForm')?.addEventListener('submit', e => e.preventDefault());

        // Clean up any leftover message areas on open
        clearEnabledMessage();
        removeRedirectMessage();
        // Ensure randomize-all defaults to OFF on first run
        const sInitial = await storageGet('autoModIdentificationChecked');
        if (sInitial.autoModIdentificationChecked === undefined) {
            await storageSet({ autoModIdentificationChecked: false });
            if (els.autoModToggle) els.autoModToggle.checked = false;
        }

        // Remove double identification: rely on popupOpened to do it once
        // await sendMsg('identifyModExtensions');

        // Continue normal popup open flow (this performs identification once)
        await sendMsg('popupOpened');
        await cleanupUndetectedMods(); // Add this line

        // load toggles & time unit & time value
        const s = await storageGet([
            'autoModIdentificationChecked',
            'uninstallAndReinstallChecked',
            'openModsTabChecked',
            'showNotificationsChecked',
            'toggleRandomizeOnStartupChecked',
            'toggleRandomizeOnSetTimeChecked',
            'randomizeTime',
            'timeUnit',
            'currentMod'
        ]);

        // Default randomize-all to false if missing
        const randomizeAll = s.autoModIdentificationChecked === undefined ? false : !!s.autoModIdentificationChecked;

        if (els.autoModToggle) els.autoModToggle.checked = randomizeAll;
        els.openModsToggle.checked = s.uninstallAndReinstallChecked === undefined ? true : !!s.uninstallAndReinstallChecked;
        els.openModsTabToggle.checked = s.openModsTabChecked === undefined ? true : !!s.openModsTabChecked;
        els.showNotificationsToggle.checked = s.showNotificationsChecked === undefined ? true : !!s.showNotificationsChecked;
        els.startupToggle.checked = !!s.toggleRandomizeOnStartupChecked;
        els.setTimeToggle.checked = !!s.toggleRandomizeOnSetTimeChecked;

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

        await loadAndRenderProfiles();
        await renderExtensionList();
        await refreshCurrentMod();

        // Send popupReady via port to request any pending randomization from background
        port.postMessage({ action: 'popupReady' });
        console.log('Popup initialized, sent popupReady via port');
    })();
});
