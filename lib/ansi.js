// A streaming SGR decoder, not a terminal emulator. Cursor/OSC/DCS controls
// are ignored. Styles are snapshots so replay never depends on older events.
const PALETTE = ['#000000','#aa0000','#00aa00','#aa5500','#0000aa','#aa00aa','#00aaaa','#aaaaaa','#555555','#ff5555','#55ff55','#ffff55','#5555ff','#ff55ff','#55ffff','#ffffff'];
const hex = values => '#' + values.map(n => n.toString(16).padStart(2, '0')).join('');
function color(index) {
  if (index < 16) return PALETTE[index];
  if (index >= 232) return hex(Array(3).fill(8 + (index - 232) * 10));
  const n = index - 16, levels = [0,95,135,175,215,255];
  return hex([levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]]);
}
export class AnsiDecoder {
  constructor() { this.state = ''; this.parameters = ''; this.style = {}; }
  sgr(parameters) {
    if (!/^[0-9;]*$/.test(parameters)) return;
    const codes = parameters.split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) this.style = {};
      else if (code === 1) this.style.bold = true;
      else if (code === 3) this.style.italic = true;
      else if (code === 4) this.style.underline = true;
      else if (code === 7) this.style.inverse = true;
      else if (code === 22) delete this.style.bold;
      else if (code === 23) delete this.style.italic;
      else if (code === 24) delete this.style.underline;
      else if (code === 27) delete this.style.inverse;
      else if (code === 39) delete this.style.foreground;
      else if (code === 49) delete this.style.background;
      else if (code >= 30 && code <= 37) this.style.foreground = color(code - 30);
      else if (code >= 90 && code <= 97) this.style.foreground = color(code - 90 + 8);
      else if (code >= 40 && code <= 47) this.style.background = color(code - 40);
      else if (code >= 100 && code <= 107) this.style.background = color(code - 100 + 8);
      else if (code === 38 || code === 48) {
        const mode = codes[++i], count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
        if (!count) break;
        const values = codes.slice(i + 1, i + 1 + count); i += count;
        if (values.length !== count || values.some(n => !Number.isInteger(n) || n < 0 || n > 255)) continue;
        this.style[code === 38 ? 'foreground' : 'background'] = mode === 5 ? color(values[0]) : hex(values);
      }
    }
  }
  feed(text) {
    const runs = []; let pending = '';
    const flush = () => { if (pending) { runs.push({ text: pending, ...this.style }); pending = ''; } };
    for (const char of text) {
      if (this.state === 'esc') {
        if (char === '[') { this.state = 'csi'; this.parameters = ''; }
        else if (']P^_X'.includes(char)) this.state = 'string';
        else this.state = '';
      } else if (this.state === 'csi') {
        if (char >= '@' && char <= '~') { if (char === 'm') { flush(); this.sgr(this.parameters); } this.state = ''; }
        else if (this.parameters.length < 128) this.parameters += char;
        else this.state = 'discard-csi';
      } else if (this.state === 'discard-csi') { if (char >= '@' && char <= '~') this.state = ''; }
      else if (this.state === 'string') { if (char === '\x07') this.state = ''; else if (char === '\x1b') this.state = 'string-esc'; }
      else if (this.state === 'string-esc') this.state = char === '\\' ? '' : 'string';
      else if (char === '\x1b') this.state = 'esc';
      else if (char === '\n' || char === '\t' || char >= ' ' && !(char >= '\x7f' && char <= '\x9f')) pending += char;
    }
    flush();
    return { text: runs.map(run => run.text).join(''), runs };
  }
}
