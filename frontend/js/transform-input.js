// Deliberately parse expressions: keyboard input never becomes JavaScript.
export function numericValue(source) {
    const units = { m: 1, cm: .01, mm: .001, km: 1000, ft: .3048, in: .0254, deg: 1, rad: 180 / Math.PI };
    const functions = { abs: Math.abs, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
        asin: Math.asin, acos: Math.acos, atan: Math.atan, floor: Math.floor, ceil: Math.ceil, round: Math.round,
        min: Math.min, max: Math.max, radians: MathUtilsRadians, degrees: value => value * 180 / Math.PI };
    source = source.trim().replace(/(\d|\))\s*(cm|mm|km|ft|in|deg|rad|m)\b/g, '$1*$2');
    const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z]+|\*\*|[+*/%(),-]/gi) || [];
    if (tokens.join('') !== source.replace(/\s/g, '') || tokens.length > 128) return NaN;
    let cursor = 0;
    function expression(minimum = 0) {
        let token = tokens[cursor++], value;
        if (token === '-' || token === '+') value = (token === '-' ? -1 : 1) * expression(3);
        else if (token === '(') { value = expression(); if (tokens[cursor++] !== ')') return NaN; }
        else if (/^(?:\d|\.)/.test(token || '')) value = Number(token);
        else if (token === 'pi') value = Math.PI;
        else if (token === 'e') value = Math.E;
        else if (Object.hasOwn(units, token)) value = units[token];
        else if (Object.hasOwn(functions, token) && tokens[cursor++] === '(') {
            const values = [expression()];
            while (tokens[cursor] === ',') { cursor++; values.push(expression()); }
            if (tokens[cursor++] !== ')') return NaN;
            value = functions[token](...values);
        } else return NaN;
        const priority = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '**': 4 };
        while (Object.hasOwn(priority, tokens[cursor]) && priority[tokens[cursor]] >= minimum) {
            const operator = tokens[cursor++], level = priority[operator];
            const right = expression(level + (operator === '**' ? 0 : 1));
            value = operator === '+' ? value + right : operator === '-' ? value - right : operator === '*' ? value * right :
                operator === '/' ? value / right : operator === '%' ? value % right : value ** right;
        }
        return value;
    }
    const value = expression();
    return cursor === tokens.length && Number.isFinite(value) ? value : NaN;
}

function MathUtilsRadians(value) { return value * Math.PI / 180; }

export class TransformInput {
    constructor() { this.parts = ['', '', '']; this.inverse = [false, false, false]; this.index = 0; this.separate = false; this.advanced = false; this.used = false; this.reset = false; }

    key(event) {
        const key = event.key;
        if (key === '=' || event.code === 'NumpadMultiply') {
            this.advanced = !event.ctrlKey; this.used = true;
            if (event.code !== 'NumpadMultiply' || !this.parts[this.index]) return true;
        }
        if (key === 'Tab' && this.used) {
            this.index = (this.index + (event.ctrlKey || event.shiftKey ? 2 : 1)) % 3; this.separate = true; return true;
        }
        if (key === 'Backspace' && this.used) {
            const part = this.parts[this.index];
            if (part) this.parts[this.index] = part.slice(0, -1);
            else if (!this.reset) { this.inverse[this.index] = false; this.reset = true; }
            else { this.used = false; this.reset = false; this.parts = ['', '', '']; this.separate = false; }
            return true;
        }
        if (key === '-' && (!this.advanced || event.ctrlKey)) {
            const part = this.parts[this.index];
            this.parts[this.index] = part.startsWith('-') ? part.slice(1) : '-' + part;
        } else if (key === '/' && (!this.advanced || event.ctrlKey)) this.inverse[this.index] = !this.inverse[this.index];
        else if (/^[0-9.]$/.test(key) || this.advanced && /^[a-z+*/%(), -]$/i.test(key)) {
            if (!this.advanced && key === '.' && this.parts[this.index].includes('.')) return true;
            if (this.parts[this.index].length < 100) this.parts[this.index] += key;
        } else return false;
        this.used = true; this.reset = false; return true;
    }

    values(fallback = 0) {
        return this.parts.map((part, index) => {
            let value = part === '' ? fallback : numericValue(part);
            if (this.inverse[index]) value = 1 / value;
            return value;
        });
    }
}
