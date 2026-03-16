import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import IService from './IService';

function fetchXml(cid: number, cookieString: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'comment.bilibili.com',
        path: `/${cid}.xml`,
        headers: {
          'user-agent': 'Mozilla/5.0',
          cookie: cookieString,
          referer: 'https://www.bilibili.com/',
          // 不发送 Accept-Encoding，让服务器返回原始数据
          // 但 Bilibili 可能仍会返回压缩数据，所以我们手动处理
        },
      },
      (res) => {
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        const chunks: Buffer[] = [];

        let stream: NodeJS.ReadableStream;
        if (encoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          // Bilibili 使用 raw deflate（无 zlib 头），需用 inflateRaw
          stream = res.pipe(zlib.createInflateRaw());
        } else {
          stream = res;
        }

        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const buf = Buffer.concat(chunks);
          // 若响应头未声明编码但实际是压缩数据，按 magic bytes 兜底检测
          if (chunks.length > 0 && buf[0] === 0x1f && buf[1] === 0x8b) {
            // gzip magic bytes
            zlib.gunzip(buf, (err, result) => {
              if (err) reject(err);
              else resolve(result.toString('utf-8'));
            });
          } else {
            resolve(buf.toString('utf-8'));
          }
        });
        stream.on('error', reject);
      }
    );
    req.setTimeout(30000, () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

const PLAY_RES_X = 1920;
const PLAY_RES_Y = 1080;
const SCROLL_DURATION = 10;
const FIXED_DURATION = 5;
const LINE_HEIGHT = 55;
const MAX_ROWS = Math.floor(PLAY_RES_Y / LINE_HEIGHT);

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function decimalToAssColor(decimal: number): string {
  const r = (decimal >> 16) & 0xff;
  const g = (decimal >> 8) & 0xff;
  const b = decimal & 0xff;
  return `&H00${b.toString(16).padStart(2, '0').toUpperCase()}${g.toString(16).padStart(2, '0').toUpperCase()}${r.toString(16).padStart(2, '0').toUpperCase()}&`;
}

function hexToAssColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `&H00${b.toString(16).padStart(2, '0').toUpperCase()}${g.toString(16).padStart(2, '0').toUpperCase()}${r.toString(16).padStart(2, '0').toUpperCase()}&`;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'');
}

interface DanmakuItem {
  time: number;
  type: number;
  size: number;
  color: number;
  text: string;
}

function parseXml(xml: string): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  const regex = /<d p="([^"]+)">([^<]*)<\/d>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const params = match[1].split(',');
    const text = decodeXmlEntities(match[2]);

    if (params.length < 4) continue;

    const time = parseFloat(params[0]);
    const type = parseInt(params[1]);
    const size = parseInt(params[2]);
    const color = parseInt(params[3]);

    if (isNaN(time) || isNaN(type)) continue;

    items.push({ time, type, size, color, text });
  }

  items.sort((a, b) => a.time - b.time);
  return items;
}

function findFreeRow(
  rowEndTimes: number[],
  startTime: number,
  duration: number
): number {
  for (let i = 0; i < rowEndTimes.length; i++) {
    if (rowEndTimes[i] <= startTime) {
      rowEndTimes[i] = startTime + duration;
      return i;
    }
  }
  rowEndTimes[0] = startTime + duration;
  return 0;
}

function convertAdvancedDanmaku(item: DanmakuItem): string | null {
  try {
    const data = JSON.parse(item.text);
    if (!Array.isArray(data)) return null;

    // Format: [x, y, rotateZ, rotateY, rotateX, text, fontSize, fontColor, startTime, duration, outlineColor, fontAlpha, ...]
    // x and y can be percentage strings ("50%") or floats (ratio 0.0-1.0)
    const parsePos = (v: any, max: number): number => {
      if (typeof v === 'string' && v.endsWith('%')) {
        return (parseFloat(v) / 100) * max;
      }
      if (typeof v === 'number') {
        // If value > 1, treat as absolute pixel; otherwise treat as ratio
        return v > 1 ? v : v * max;
      }
      return max / 2;
    };

    const x = parsePos(data[0], PLAY_RES_X);
    const y = parsePos(data[1], PLAY_RES_Y);
    const rotZ = typeof data[2] === 'number' ? data[2] : 0;
    const rotY = typeof data[3] === 'number' ? data[3] : 0;
    const rotX = typeof data[4] === 'number' ? data[4] : 0;
    const text = typeof data[5] === 'string' ? data[5] : String(data[5] ?? '');
    const fontSize = typeof data[6] === 'number' ? Math.round(data[6]) : 25;
    const fontColorRaw = data[7];
    const duration = typeof data[9] === 'number' ? data[9] : FIXED_DURATION;
    // fontAlpha: 0=opaque, values >0 = more transparent (Bilibili uses 0-100 scale typically)
    const fontAlpha = typeof data[11] === 'number' ? data[11] : 0;

    if (!text) return null;

    let colorTag = '';
    if (typeof fontColorRaw === 'number') {
      colorTag = `\\c${decimalToAssColor(fontColorRaw)}`;
    } else if (
      typeof fontColorRaw === 'string' &&
      fontColorRaw.startsWith('#')
    ) {
      colorTag = `\\c${hexToAssColor(fontColorRaw)}`;
    }

    // Convert alpha: Bilibili 0-100 → ASS 0x00-0xFF (0=opaque)
    const alphaVal = Math.min(255, Math.round((fontAlpha / 100) * 255));
    const alphaTag =
      alphaVal > 0
        ? `\\alpha&H${alphaVal.toString(16).padStart(2, '0').toUpperCase()}&`
        : '';

    const rotTags = [
      rotZ !== 0 ? `\\frz${rotZ}` : '',
      rotY !== 0 ? `\\fry${rotY}` : '',
      rotX !== 0 ? `\\frx${rotX}` : '',
    ].join('');

    const startTime = formatTime(item.time);
    const endTime = formatTime(item.time + duration);
    const overrideTags = `{\\pos(${Math.round(x)},${Math.round(y)})\\fs${fontSize}${colorTag}${alphaTag}${rotTags}}`;

    return `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${overrideTags}${text}`;
  } catch {
    return null;
  }
}

function xmlToAss(xml: string): string {
  const items = parseXml(xml);

  const header = `[Script Info]
; Script generated by 鼠鼠下载器
Title: Danmaku
ScriptType: v4.00+
Collisions: Normal
PlayResX: ${PLAY_RES_X}
PlayResY: ${PLAY_RES_Y}
Timer: 100.0000

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,黑体,25,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  // Row slot trackers: rowEndTime[i] = timestamp (sec) when row i is free again
  const scrollRowsR: number[] = new Array(MAX_ROWS).fill(0); // type 1 (right→left)
  const scrollRowsL: number[] = new Array(MAX_ROWS).fill(0); // type 6 (left→right)
  const topRows: number[] = new Array(MAX_ROWS).fill(0);
  const bottomRows: number[] = new Array(MAX_ROWS).fill(0);

  const dialogues: string[] = [];

  for (const item of items) {
    const { time, type, size, color, text } = item;
    const colorTag = color !== 16777215 ? `\\c${decimalToAssColor(color)}` : '';
    const sizeTag = size !== 25 ? `\\fs${size}` : '';

    if (type === 1 || type === 6) {
      const endTime = formatTime(time + SCROLL_DURATION);
      const textWidth = size * text.length * 0.58;
      const rowSlots = type === 1 ? scrollRowsR : scrollRowsL;
      const row = findFreeRow(rowSlots, time, SCROLL_DURATION);
      const y = LINE_HEIGHT * row + size;

      let x1: number, x2: number;
      if (type === 1) {
        x1 = PLAY_RES_X + textWidth / 2;
        x2 = -textWidth / 2;
      } else {
        x1 = -textWidth / 2;
        x2 = PLAY_RES_X + textWidth / 2;
      }

      const tags = `{\\move(${Math.round(x1)},${y},${Math.round(x2)},${y})${colorTag}${sizeTag}}`;
      dialogues.push(
        `Dialogue: 0,${formatTime(time)},${endTime},Default,,0,0,0,,${tags}${text}`
      );
    } else if (type === 4) {
      const endTime = formatTime(time + FIXED_DURATION);
      const row = findFreeRow(bottomRows, time, FIXED_DURATION);
      const y = PLAY_RES_Y - LINE_HEIGHT * row - 5;
      const tags = `{\\an2\\pos(${PLAY_RES_X / 2},${y})${colorTag}${sizeTag}}`;
      dialogues.push(
        `Dialogue: 0,${formatTime(time)},${endTime},Default,,0,0,0,,${tags}${text}`
      );
    } else if (type === 5) {
      const endTime = formatTime(time + FIXED_DURATION);
      const row = findFreeRow(topRows, time, FIXED_DURATION);
      const y = LINE_HEIGHT * row + size;
      const tags = `{\\an8\\pos(${PLAY_RES_X / 2},${y})${colorTag}${sizeTag}}`;
      dialogues.push(
        `Dialogue: 0,${formatTime(time)},${endTime},Default,,0,0,0,,${tags}${text}`
      );
    } else if (type === 7) {
      const dialogue = convertAdvancedDanmaku(item);
      if (dialogue) dialogues.push(dialogue);
    }
    // type 8 (scripts) and others are skipped
  }

  return header + '\n' + dialogues.join('\n') + '\n';
}

const fns = {
  async downloadAndConvert(
    cid: number,
    dir: string,
    baseFileName: string,
    cookieString: string
  ): Promise<void> {
    const xml = await fetchXml(cid, cookieString);
    const ass = xmlToAss(xml);

    const xmlPath = path.join(dir, `${baseFileName}.xml`);
    const assPath = path.join(dir, `${baseFileName}.ass`);

    await fs.writeFile(xmlPath, xml, 'utf-8');
    await fs.writeFile(assPath, ass, 'utf-8');
  },
};

const danmakuService: IService<typeof fns> = {
  name: 'danmaku',
  fns,
};

export default danmakuService;
