import { storageGet, sendMsg } from './api.js';
import { customAlert, customPrompt } from './utils.js';
import { getEls, renderExtensionList } from './ui.js';

let currentProfile = null;
let profileRenderGeneration = 0;

export function getCurrentProfile() { return currentProfile; }
export function setCurrentProfile(p) { currentProfile = p; }

// --- helpers ---
export async function ensureProfilesOrder() { return sendMsg('ensureProfilesOrder'); }

export async function loadAndRenderProfiles() {
    const generation = ++profileRenderGeneration;
    const s = await storageGet(['profiles', 'activeProfile']);
    if (generation !== profileRenderGeneration) return;
    const profiles = s?.profiles || { Default: [] };
    const activeProfile = s?.activeProfile || Object.keys(profiles)[0] || 'Default';

    // Keep a stable notion of the current profile in the popup:
    currentProfile = activeProfile;

    const els = getEls();
    if (!els.profileSelect) return;

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
    await ensureProfilesOrder();

    // Wire rename by double-click on select
    if (!els.profileSelect._hasDbl) {
        els.profileSelect.addEventListener('dblclick', async () => {
            const oldName = els.profileSelect.value;
            const newNameRaw = await customPrompt('Enter new profile name:', oldName, 'Rename Profile');
            const newName = (newNameRaw || '').trim();
            if (!newName || newName === oldName) return;

            let res;
            try { res = await sendMsg('renameProfile', { oldName, newName }); }
            catch (error) { await customAlert(error.message); return; }
            if (res && res.status === 'success') {
                console.log(`Renamed profile ${oldName} -> ${newName}`);
                await loadAndRenderProfiles();
            } else {
                await customAlert(res && res.message ? res.message : 'Rename failed');
            }
        });
        els.profileSelect._hasDbl = true;
    }
}

// Export/Import Logic
export async function exportProfiles() {
    try {
        const s = await storageGet(['profiles', 'detectedModList']);
        const profiles = s.profiles || {};
        const detectedModList = s.detectedModList || [];

        if (Object.keys(profiles).length === 0) {
            await customAlert('No profiles to export.', 'Export');
            return;
        }

        const modIdToName = new Map(detectedModList.map(m => [m.id, m.name]));

        const exportData = {
            version: 1,
            exportDate: new Date().toISOString(),
            profiles: {}
        };

        for (const [rawProfileName, modIds] of Object.entries(profiles)) {
            // Rename 'Default' to avoid it being skipped as a duplicate on import
            // if the target machine already has a 'Default' profile (which is standard).
            let exportName = rawProfileName;
            if (rawProfileName === 'Default') {
                exportName = 'Default (Exported)';
                let suffix = 2;
                const names = new Set(Object.keys(profiles).map(n => n.toLowerCase()));
                while (names.has(exportName.toLowerCase())) exportName = `Default (Exported ${suffix++})`;
            }

            exportData.profiles[exportName] = (modIds || []).map(id => ({
                id: id,
                name: modIdToName.get(id) || `Unknown (${id})`
            }));
        }

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mod-randomizer-profiles-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('Profiles exported successfully');
        await customAlert(`Exported ${Object.keys(profiles).length} profile(s)`, 'Export Successful');
    } catch (err) {
        console.error('Export error:', err);
        await customAlert('Failed to export profiles: ' + err.message, 'Export Error');
    }
}

export async function importProfiles(file, showImportResultsCallback) {
    try {
        const text = await file.text();
        const importData = JSON.parse(text);

        if (!importData.profiles || typeof importData.profiles !== 'object') {
            throw new Error('Invalid profile file format');
        }

        const results = await sendMsg('importProfiles', { data: importData });
        await loadAndRenderProfiles();
        await renderExtensionList();

        if (showImportResultsCallback) {
            await showImportResultsCallback(results);
        }

    } catch (err) {
        console.error('Import error:', err);
        await customAlert('Failed to import profiles: ' + err.message, 'Import Error');
    }
}
