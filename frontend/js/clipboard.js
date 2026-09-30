export async function copyText(value) {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return;
        } catch {}
    }

    const active = document.activeElement;
    const selection = getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const input = document.createElement('textarea');
    input.value = value;
    input.readOnly = true;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    document.body.append(input);
    input.select();
    try {
        if (!document.execCommand('copy')) throw Error('copyFailed');
    } finally {
        input.remove();
        active?.focus({ preventScroll: true });
        if (selection) {
            selection.removeAllRanges();
            for (const range of ranges) selection.addRange(range);
        }
    }
}
