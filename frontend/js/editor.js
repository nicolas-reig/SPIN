import {
    EditorState, EditorView, Slice, InputRule, schema, defaultMarkdownParser, defaultMarkdownSerializer,
    toggleMark, setBlockType, baseKeymap, chainCommands, wrapInList, splitListItem,
    liftListItem, sinkListItem, history, undo, redo, keymap, inputRules,
    wrappingInputRule, textblockTypeInputRule, undoInputRule
} from '../vendor/editor.js';
import { safeUrl } from './domain.js';

export function createNoteEditor(host, { value, label, placeholder, onChange, onFocus, onLink, exhibitId = '', disabled = false }) {
    const markRule = (pattern, type) => new InputRule(pattern, (state, match, start, end) => {
        const text = match[1];
        return state.tr.insertText(text, start, end).addMark(start, start + text.length, type.create()).removeStoredMark(type);
    });
    const rules = [
        markRule(/\*\*([^*]+)\*\*$/, schema.marks.strong),
        markRule(/(?<!\*)\*([^*]+)\*$/, schema.marks.em),
        textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, match => ({ level: match[1].length })),
        wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, match => ({ order: +match[1] }), (match, node) => node.childCount + node.attrs.order === +match[1])
    ];
    const view = new EditorView(host, {
        state: EditorState.create({
            doc: defaultMarkdownParser.parse(value),
            plugins: [
                inputRules({ rules }), history(),
                keymap({
                    'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em),
                    'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo,
                    'Mod-k': () => { onLink(); return true; },
                    'Enter': splitListItem(schema.nodes.list_item),
                    'Mod-[': liftListItem(schema.nodes.list_item), 'Mod-]': sinkListItem(schema.nodes.list_item),
                    'Backspace': undoInputRule
                }), keymap(baseKeymap)
            ]
        }),
        editable: () => !disabled,
        nodeViews: {
            image(node) {
                const image = document.createElement('img');
                const match = /^\.\.\/Fotos\/([^/?#]+)$/i.exec(node.attrs.src || '');
                if (match && exhibitId) {
                    try {
                        const name = decodeURIComponent(match[1]);
                        if (!name.includes('/') && !name.includes('\\') && !name.includes('..')) {
                            image.src = `api.php?action=photo&exhibitId=${encodeURIComponent(exhibitId)}&file=${encodeURIComponent(name)}`;
                        }
                    } catch {}
                }
                image.alt = node.attrs.alt || '';
                return { dom: image };
            }
        },
        attributes: { id: 'note-body', role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'data-placeholder': placeholder },
        dispatchTransaction(transaction) {
            view.updateState(view.state.apply(transaction));
            if (transaction.docChanged) onChange(defaultMarkdownSerializer.serialize(view.state.doc));
            update();
        },
        handleDOMEvents: {
            focus: () => { onFocus(); return false; },
            paste: (_, event) => Boolean(event.clipboardData?.files.length),
            drop: (_, event) => Boolean(event.dataTransfer?.files.length)
        },
        clipboardTextParser: text => new Slice(defaultMarkdownParser.parse(text).content, 0, 0),
        transformPastedHTML: html => {
            const document = new DOMParser().parseFromString(html, 'text/html');
            document.querySelectorAll('img').forEach(image => image.remove());
            document.querySelectorAll('a').forEach(link => { if (!safeUrl(link.getAttribute('href'))) link.removeAttribute('href'); });
            return document.body.innerHTML;
        },
        handleClick: (_, __, event) => {
            if (event.target.closest('a')) { event.preventDefault(); return true; }
            return false;
        }
    });
    function update() {
        const state = view.state;
        host.classList.toggle('is-empty', !state.doc.textContent && state.doc.childCount === 1);
        for (const button of host.closest('form').querySelectorAll('[data-format]')) {
            const mark = button.dataset.format === 'bold' ? schema.marks.strong : button.dataset.format === 'italic' ? schema.marks.em : null;
            let parent = state.selection.$from;
            let inList = false;
            for (let depth = parent.depth; depth > 0; depth--) if (parent.node(depth).type === schema.nodes.ordered_list) inList = true;
            const active = mark ? (state.selection.empty ? mark.isInSet(state.storedMarks || state.selection.$from.marks()) : state.doc.rangeHasMark(state.selection.from, state.selection.to, mark)) : button.dataset.format === 'heading' ? state.selection.$from.parent.type === schema.nodes.heading : button.dataset.format === 'list' ? inList : false;
            button.setAttribute('aria-pressed', Boolean(active));
        }
    }
    function selectedLink() {
        const { from, to, $from, empty } = view.state.selection;
        const mark = $from.marks().find(mark => mark.type === schema.marks.link) ||
            (empty ? $from.nodeAfter?.marks.find(mark => mark.type === schema.marks.link) : null);
        let range = { from, to };
        if (empty && mark) {
            const ranges = [];
            $from.parent.forEach((node, offset) => {
                if (!node.marks.some(item => item.type === schema.marks.link && item.attrs.href === mark.attrs.href)) return;
                const start = $from.start() + offset;
                const previous = ranges.at(-1);
                if (previous?.to === start) previous.to += node.nodeSize;
                else ranges.push({ from: start, to: start + node.nodeSize });
            });
            range = ranges.find(item => item.from <= from && item.to >= from) || range;
        }
        return { ...range, url: mark?.attrs.href || '', text: view.state.doc.textBetween(range.from, range.to) };
    }
    update();
    return {
        destroy: () => view.destroy(),
        focus: () => view.focus(),
        link: selectedLink,
        setLink(url, text, range = view.state.selection) {
            const { from, to } = range;
            let tr = view.state.tr;
            if (!url) tr = tr.removeMark(from, to, schema.marks.link);
            else if (from === to) tr = tr.replaceSelectionWith(schema.text(text || url, [schema.marks.link.create({ href: url })]), false);
            else tr = tr.addMark(from, to, schema.marks.link.create({ href: url }));
            view.dispatch(tr);
            view.focus();
        },
        command(name) {
            const commands = {
                bold: toggleMark(schema.marks.strong), italic: toggleMark(schema.marks.em),
                heading: setBlockType(view.state.selection.$from.parent.type === schema.nodes.heading ? schema.nodes.paragraph : schema.nodes.heading, { level: 2 }),
                list: chainCommands(wrapInList(schema.nodes.ordered_list), liftListItem(schema.nodes.list_item))
            };
            commands[name]?.(view.state, view.dispatch, view);
            view.focus();
        }
    };
}
