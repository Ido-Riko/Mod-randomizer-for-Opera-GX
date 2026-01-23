export function showModal(title, message, buttons, inputConfig = null) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('modalOverlay');
        const titleEl = document.getElementById('modalTitle');
        const messageEl = document.getElementById('modalMessage');
        const inputEl = document.getElementById('modalInput');
        const buttonsEl = document.getElementById('modalButtons');

        titleEl.textContent = title;
        messageEl.textContent = message;
        buttonsEl.innerHTML = '';

        // Handle input field
        if (inputConfig) {
            inputEl.style.display = 'block';
            inputEl.value = inputConfig.defaultValue || '';
            inputEl.placeholder = inputConfig.placeholder || '';
            inputEl.focus();

            // Allow Enter key to submit
            const enterHandler = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const btn = buttonsEl.querySelector('.modal-btn-primary');
                    if (btn) btn.click();
                }
            };
            inputEl.addEventListener('keydown', enterHandler);
            inputEl._enterHandler = enterHandler;
        } else {
            inputEl.style.display = 'none';
        }

        // Create buttons
        buttons.forEach(btn => {
            const button = document.createElement('button');
            button.className = `modal-btn ${btn.className || 'modal-btn-secondary'}`;
            button.textContent = btn.text;
            button.onclick = () => {
                overlay.classList.remove('active');
                if (inputEl._enterHandler) {
                    inputEl.removeEventListener('keydown', inputEl._enterHandler);
                    delete inputEl._enterHandler;
                }
                resolve(inputConfig ? inputEl.value : btn.value);
            };
            buttonsEl.appendChild(button);
        });

        overlay.classList.add('active');

        // Focus input or first button
        setTimeout(() => {
            if (inputConfig) {
                inputEl.focus();
                inputEl.select();
            } else {
                const firstBtn = buttonsEl.querySelector('.modal-btn-primary') ||
                    buttonsEl.querySelector('.modal-btn');
                if (firstBtn) firstBtn.focus();
            }
        }, 100);
    });
}

export function customAlert(message, title = 'Notice') {
    return showModal(title, message, [
        { text: 'OK', className: 'modal-btn-primary', value: true }
    ]);
}

export function customConfirm(message, title = 'Confirm') {
    return showModal(title, message, [
        { text: 'Cancel', className: 'modal-btn-secondary', value: false },
        { text: 'OK', className: 'modal-btn-primary', value: true }
    ]);
}

export function customConfirmDanger(message, title = 'Confirm') {
    return showModal(title, message, [
        { text: 'Cancel', className: 'modal-btn-secondary', value: false },
        { text: 'Delete', className: 'modal-btn-danger', value: true }
    ]);
}

export function customPrompt(message, defaultValue = '', title = 'Input') {
    return showModal(title, message, [
        { text: 'Cancel', className: 'modal-btn-secondary', value: null },
        { text: 'OK', className: 'modal-btn-primary', value: 'submit' }
    ], {
        defaultValue,
        placeholder: message
    }).then(result => result === null ? null : result);
}

export function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// --- Formatting helpers for time units ---
export function toMinutes(value, unit) {
    const v = parseFloat(value);
    if (isNaN(v)) return NaN;
    if (unit === 'minutes') return v;
    if (unit === 'hours') return v * 60;
    if (unit === 'days') return v * 24 * 60;
    return v;
}

export function fromMinutesFormat(minutes, unit) {
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
