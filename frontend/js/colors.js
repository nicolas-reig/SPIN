export const COLOR_SCHEMES = {
    default: {
        materials: {
            ok: '#31975c', problem: '#d99a22', retired: '#65717d',
            selection: '#1684ef', editSelection: '#8056cb', editContext: '#7c98b3', floor: '#afb7be'
        },
        accent: '#0872df', editAccent: '#8056cb', link: '#096ece',
        danger: '#b44c4d', north: '#cb514f'
    },
    protanopia: {
        materials: {
            ok: '#56b4e9', problem: '#c39400', retired: '#494f55',
            selection: '#074874', editSelection: '#cc79a7', editContext: '#7d9db3', floor: '#afb7be'
        },
        accent: '#074874', editAccent: '#7a3461', link: '#074874',
        danger: '#784800', north: '#784800'
    },
    deuteranopia: {
        materials: {
            ok: '#3288bd', problem: '#c89200', retired: '#494f55',
            selection: '#004569', editSelection: '#b26b8c', editContext: '#7899ae', floor: '#afb7be'
        },
        accent: '#004569', editAccent: '#964775', link: '#004569',
        danger: '#785000', north: '#785000'
    },
    tritanopia: {
        materials: {
            ok: '#008e95', problem: '#ca4062', retired: '#646c74',
            selection: '#00494e', editSelection: '#782d44', editContext: '#719c9e', floor: '#afb7be'
        },
        accent: '#00494e', editAccent: '#782d44', link: '#00494e',
        danger: '#982d47', north: '#982d47'
    },
    achromatopsia: {
        materials: {
            ok: '#5a5a5a', problem: '#dfdfdf', retired: '#202020',
            selection: '#000000', editSelection: '#838383', editContext: '#555555', floor: '#aaaaaa'
        },
        accent: '#303030', editAccent: '#494949', link: '#303030',
        danger: '#303030', north: '#202020'
    }
};

const preferenceKey = 'hub-color-scheme';
const listeners = new Set();
const validMode = value => Object.hasOwn(COLOR_SCHEMES, value) ? value : 'default';
let mode = 'default';
try { mode = validMode(localStorage.getItem(preferenceKey)); } catch {}

export const colorMode = () => mode;
export const colorScheme = () => COLOR_SCHEMES[mode];

function apply() {
    const scheme = colorScheme();
    const root = document.documentElement;
    root.dataset.colorMode = mode;
    const variables = {
        'normal-accent': scheme.accent,
        'edit-accent': scheme.editAccent,
        'link': scheme.link,
        'focus': scheme.accent,
        'green': scheme.materials.ok,
        'red': scheme.danger,
        'error-ink': scheme.danger,
        'compass-north': scheme.north
    };
    for (const status of ['ok', 'problem', 'retired']) variables['status-' + status] = scheme.materials[status];
    for (const [name, value] of Object.entries(variables)) root.style.setProperty('--' + name, value);
    for (const listener of listeners) listener(mode, scheme);
}

export function setColorMode(value) {
    mode = validMode(value);
    let saved = true;
    try {
        if (mode === 'default') localStorage.removeItem(preferenceKey);
        else localStorage.setItem(preferenceKey, mode);
    } catch { saved = false; }
    apply();
    return saved;
}

export function onColorModeChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

window.addEventListener('storage', event => {
    if (event.key !== preferenceKey && event.key !== null) return;
    mode = validMode(event.newValue);
    apply();
});
apply();
