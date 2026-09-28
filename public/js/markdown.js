import { defaultMarkdownParser } from '../vendor/editor.js';
import { safeUrl } from './domain.js';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export function markdown(source) {
    function render(node) {
        let content = '';
        node.forEach(child => { content += render(child); });
        if (node.isText) content = escape(node.text);
        for (const mark of node.marks) {
            if (mark.type.name === 'strong') content = `<strong>${content}</strong>`;
            if (mark.type.name === 'em') content = `<em>${content}</em>`;
            if (mark.type.name === 'code') content = `<code>${content}</code>`;
            if (mark.type.name === 'link' && safeUrl(mark.attrs.href)) content = `<a href="${escape(mark.attrs.href)}" target="_blank" rel="noopener noreferrer">${content}</a>`;
        }
        const tags = { paragraph: 'p', blockquote: 'blockquote', bullet_list: 'ul', list_item: 'li' };
        if (tags[node.type.name]) return `<${tags[node.type.name]}>${content}</${tags[node.type.name]}>`;
        if (node.type.name === 'heading') return `<h${node.attrs.level}>${content}</h${node.attrs.level}>`;
        if (node.type.name === 'ordered_list') return `<ol start="${Number(node.attrs.order)}">${content}</ol>`;
        if (node.type.name === 'hard_break') return '<br>';
        if (node.type.name === 'horizontal_rule') return '<hr>';
        if (node.type.name === 'code_block') return `<pre><code>${content}</code></pre>`;
        if (node.type.name === 'image') return escape(node.attrs.alt || '');
        return content;
    }
    return render(defaultMarkdownParser.parse(String(source)));
}
