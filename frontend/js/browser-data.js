function expireCookies() {
    const { pathname, hostname } = location;
    const paths = new Set(['/', pathname]);
    for (let index = pathname.indexOf('/', 1); index !== -1; index = pathname.indexOf('/', index + 1)) {
        paths.add(pathname.slice(0, index));
        paths.add(pathname.slice(0, index + 1));
    }
    for (const cookie of document.cookie.split(';')) {
        const separator = cookie.indexOf('=');
        if (separator < 1) continue;
        const name = cookie.slice(0, separator).trim();
        if (!name) continue;
        for (const path of paths) {
            const expired = `${name}=; Max-Age=0; Path=${path}`;
            document.cookie = expired;
            if (hostname) document.cookie = `${expired}; Domain=${hostname}`;
        }
    }
}

async function clearDatabases() {
    const databases = globalThis.indexedDB;
    if (!databases) return;
    const names = (await databases.databases()).map(database => database.name).filter(name => name != null);
    const results = await Promise.allSettled(names.map(name => new Promise((resolve, reject) => {
        const request = databases.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = request.onblocked = reject;
    })));
    if (results.some(result => result.status === 'rejected')) throw Error('A browser database could not be cleared');
}

export async function clearBrowserData() {
    const tasks = [
        () => localStorage.clear(),
        () => sessionStorage.clear(),
        expireCookies,
        clearDatabases,
        async () => {
            const storage = globalThis.caches;
            if (storage) await Promise.all((await storage.keys()).map(key => storage.delete(key)));
        },
        async () => {
            const workers = await navigator.serviceWorker?.getRegistrations();
            await Promise.all((workers || []).map(worker => worker.unregister()));
        }
    ];
    const local = Promise.allSettled(tasks.map(async task => task()));
    let requested = false;
    if (globalThis.isSecureContext) {
        try {
            const response = await fetch('clear-browser-data.php', {
                method: 'POST', mode: 'same-origin', redirect: 'error', cache: 'no-store',
                headers: { 'X-Hub-Request': '1' }, signal: AbortSignal.timeout?.(5000)
            });
            requested = response.ok && response.headers.has('Clear-Site-Data');
        } catch {}
    }
    const completed = (await local).every(result => result.status === 'fulfilled');
    return requested && completed;
}
