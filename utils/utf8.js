/**
 * 增量 UTF-8 解码器
 * 解决流式 chunk 边界把一个汉字（3 字节）切成两半导致的乱码问题：
 * 每次只解码完整的多字节序列，把末尾不完整字节留到下一次。
 */
function createUtf8Decoder() {
  let carry = [];

  function push(u8) {
    const bytes = carry.concat(Array.prototype.slice.call(u8));
    let text = '';
    let i = 0;

    while (i < bytes.length) {
      const b = bytes[i];
      let len = 0;
      if (b < 0x80) len = 1;
      else if ((b & 0xE0) === 0xC0) len = 2;
      else if ((b & 0xF0) === 0xE0) len = 3;
      else if ((b & 0xF8) === 0xF0) len = 4;
      else { i++; continue; } // 非法起始字节，跳过

      if (i + len > bytes.length) break; // 不完整，留给下一次

      let cp;
      let ok = true;
      if (len === 1) {
        cp = b;
      } else {
        cp = b & (0xFF >> (len + 1));
        for (let k = 1; k < len; k++) {
          const cb = bytes[i + k];
          if ((cb & 0xC0) !== 0x80) { ok = false; break; }
          cp = (cp << 6) | (cb & 0x3F);
        }
      }
      if (!ok) { i++; continue; }

      text += String.fromCodePoint(cp);
      i += len;
    }

    carry = bytes.slice(i);
    return text;
  }

  function flush() {
    carry = []; // 丢弃残留的不完整字节
    return '';
  }

  return { push, flush };
}

/** 全量解码一个 ArrayBuffer（兜底路径用） */
function decodeAll(arrayBuffer) {
  const d = createUtf8Decoder();
  const text = d.push(new Uint8Array(arrayBuffer));
  d.flush();
  return text;
}

module.exports = { createUtf8Decoder, decodeAll };
