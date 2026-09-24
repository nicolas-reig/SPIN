export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
} [c]));

function inline(text) {
    const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\))/g;
    let out = '',
        at = 0;
    for (const match of text.matchAll(pattern)) {
        out += escape(text.slice(at, match.index));
        if (match[2]) out += '<strong>' + escape(match[2]) + '</strong>';
        else if (match[3]) out += '<code>' + escape(match[3]) + '</code>';
        else {
            let safe = false;
            try {
                const u = new URL(match[5]);
                safe = ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
            } catch {}
            out += safe ? `<a href="${escape(match[5])}" target="_blank" rel="noopener noreferrer">${escape(match[4])}</a>` : escape(match[0]);
        }
        at = match.index + match[0].length;
    }
    return out + escape(text.slice(at));
}
// Deliberately small Markdown subset. Raw HTML and images/URLs outside HTTP(S) never become markup.
export function markdown(source) {
    let out = '',
        list = false,
        code = false,
        buffer = [];
    const flush = () => {
        if (buffer.length) {
            out += '<p>' + buffer.map(inline).join('<br>') + '</p>';
            buffer = [];
        }
    };
    for (const line of String(source).split('\n')) {
        if (line.startsWith('```')) {
            flush();
            if (list) {
                out += '</ul>';
                list = false;
            }
            out += code ? '</code></pre>' : '<pre><code>';
            code = !code;
            continue;
        }
        if (code) {
            out += escape(line) + '\n';
            continue;
        }
        if (/^[-*] /.test(line)) {
            flush();
            if (!list) {
                out += '<ul>';
                list = true;
            }
            out += '<li>' + inline(line.slice(2)) + '</li>';
            continue;
        }
        if (list) {
            out += '</ul>';
            list = false;
        }
        if (/^#{1,3} /.test(line)) {
            flush();
            out += '<h3>' + inline(line.replace(/^#{1,3} /, '')) + '</h3>';
        } else if (line.trim() === '') flush();
        else buffer.push(line);
    }
    flush();
    if (list) out += '</ul>';
    if (code) out += '</code></pre>';
    return out;
}
