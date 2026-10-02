// Encode legacy game input and escape literal IAC bytes as required by Telnet.
export function encodeCommand(command, encoding = 'utf-8') {
  let bytes;
  if (encoding === 'windows-1252') {
    const decoder = new TextDecoder('windows-1252');
    const mapping = new Map(Array.from({length:256}, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte]));
    bytes = Array.from(command, char => { if (!mapping.has(char)) throw new Error('O servidor não aceita esse caractere.'); return mapping.get(char); });
  } else bytes = [...Buffer.from(command, 'utf8')];
  return Buffer.from([...bytes.flatMap(byte => byte === 255 ? [255,255] : [byte]), 13,10]);
}

// Incremental Telnet decoding: negotiation bytes may cross TCP packet boundaries.
export class TelnetDecoder {
  constructor(reply, onEcho, encoding = 'utf-8') {
    this.reply = reply;
    this.onEcho = onEcho;
    this.decoder = new TextDecoder(encoding);
    this.state = 'text';
    this.command = 0;
    this.escape = '';
  }

  feed(bytes) {
    const output = [];
    for (const byte of bytes) {
      if (this.state === 'text') {
        if (byte === 255) this.state = 'iac'; else output.push(byte);
      } else if (this.state === 'iac') {
        if (byte === 255) { output.push(byte); this.state = 'text'; }
        else if ([251, 252, 253, 254].includes(byte)) { this.command = byte; this.state = 'option'; }
        else if (byte === 250) this.state = 'sub';
        else this.state = 'text';
      } else if (this.state === 'option') {
        // Accept server-side echo; refuse unsupported options once per offer.
        if (this.command === 251) { this.reply(Buffer.from([255, byte === 1 ? 253 : 254, byte])); if (byte === 1) this.onEcho(true); }
        else if (this.command === 252 && byte === 1) this.onEcho(false);
        else if (this.command === 253) this.reply(Buffer.from([255, 252, byte]));
        this.state = 'text';
      } else if (this.state === 'sub') {
        if (byte === 255) this.state = 'sub-iac';
      } else if (this.state === 'sub-iac') this.state = byte === 240 ? 'text' : 'sub';
    }
    let clean = '';
    for (const char of this.decoder.decode(Uint8Array.from(output), { stream: true })) {
      if (this.escape === 'esc') {
        this.escape = char === '[' ? 'csi' : char === ']' ? 'osc' : '';
      } else if (this.escape === 'csi') {
        if (char >= '@' && char <= '~') this.escape = '';
      } else if (this.escape === 'osc') {
        if (char === '\x07') this.escape = ''; else if (char === '\x1b') this.escape = 'osc-esc';
      } else if (this.escape === 'osc-esc') this.escape = char === '\\' ? '' : 'osc';
      else if (char === '\x1b') this.escape = 'esc';
      else if (char === '\n' || char === '\t' || char >= ' ' && char !== '\x7f') clean += char;
    }
    return clean;
  }
}
