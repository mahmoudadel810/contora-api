import { MAX_HEADER_FOOTER_PARTS, MAX_SKIP_DEPTH, RESOLVE_BUDGET_FACTOR } from './limits.js';
import type { OfficeFormat, OfficeLimits, OfficeNoText, OfficeTextResult } from './types.js';
import { decodeXml, scanXml, type ScanStatus, type XmlHandler } from './xml-scan.js';
import type { ReadFailure, ZipArchive } from './zip-reader.js';

export const CONTENT_TYPES_PART = '[content_types].xml';
const ROOT_RELS_PART = '_rels/.rels';

export const MAIN_PART_TYPES: readonly (readonly [string, OfficeFormat])[] = [
  ['wordprocessingml.document.main', 'docx'],
  ['wordprocessingml.template.main', 'docx'],
  ['ms-word.document.macroEnabled.main', 'docx'],
  ['ms-word.template.macroEnabledTemplate.main', 'docx'],
  ['spreadsheetml.sheet.main', 'xlsx'],
  ['spreadsheetml.template.main', 'xlsx'],
  ['ms-excel.sheet.macroEnabled.main', 'xlsx'],
  ['ms-excel.template.macroEnabled.main', 'xlsx'],
  ['presentationml.presentation.main', 'pptx'],
  ['presentationml.slideshow.main', 'pptx'],
  ['presentationml.template.main', 'pptx'],
  ['ms-powerpoint.presentation.macroEnabled.main', 'pptx'],
  ['ms-powerpoint.slideshow.macroEnabled.main', 'pptx'],
  ['ms-powerpoint.template.macroEnabled.main', 'pptx'],
];

export function mainFormat(contentType: string): OfficeFormat | null {
  const lower = contentType.toLowerCase();
  for (const [needle, format] of MAIN_PART_TYPES) {
    if (lower.includes(needle.toLowerCase())) return format;
  }
  return null;
}

export interface Detected {
  format: OfficeFormat;
  main: string;
}

export interface FormatText {
  text: string;
  truncated: boolean;
}

function dirOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return slash === -1 ? '' : part.slice(0, slash);
}

function relsPartOf(source: string): string {
  const dir = dirOf(source);
  const file = source.slice(source.lastIndexOf('/') + 1);
  return `${dir === '' ? '' : `${dir}/`}_rels/${file}.rels`;
}

interface BaseDir {
  depth: number;
  joined: string;
}

function baseDirOf(dir: string): BaseDir {
  const segments = dir.split('/').filter((segment) => segment !== '');
  return { depth: segments.length, joined: segments.join('/') };
}

function resolveFrom(base: BaseDir, target: string): string | null {
  const hash = target.indexOf('#');
  const raw = hash === -1 ? target : target.slice(0, hash);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const depth = decoded.startsWith('/') ? 0 : base.depth;
  const own: string[] = [];
  let up = 0;
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (own.length > 0) own.pop();
      else if (up < depth) up++;
      else return null;
      continue;
    }
    own.push(segment);
  }
  let head = depth === 0 ? '' : base.joined;
  for (let k = 0; k < up; k++) {
    const slash = head.lastIndexOf('/');
    head = slash === -1 ? '' : head.slice(0, slash);
  }
  const tail = own.join('/');
  const path = head === '' ? tail : tail === '' ? head : `${head}/${tail}`;
  return path === '' ? null : path.toLowerCase();
}

export function resolveTarget(baseDir: string, target: string): string | null {
  return resolveFrom(baseDirOf(baseDir), target);
}

type PartRead = { ok: true; bytes: Uint8Array } | { ok: false; why: ReadFailure };

function readPart(zip: ZipArchive, name: string): PartRead {
  const bytes = zip.read(name);
  if (bytes === null) return { ok: false, why: zip.failure(name) ?? 'corrupt' };
  return { ok: true, bytes };
}

function scanBytes(bytes: Uint8Array, handler: XmlHandler, limits: OfficeLimits): ScanStatus {
  try {
    return scanXml(decodeXml(bytes), handler, limits.maxTagChars);
  } catch {
    return 'corrupt';
  }
}

class TextSink {
  private readonly parts: string[] = [];
  private size = 0;
  full: boolean;

  constructor(private readonly max: number) {
    this.full = max <= 0;
  }

  get length(): number {
    return this.size;
  }

  get remaining(): number {
    return Math.max(0, this.max - this.size);
  }

  push(value: string): void {
    if (this.full || value.length === 0) return;
    const room = this.max - this.size;
    if (value.length <= room) {
      this.parts.push(value);
      this.size += value.length;
      if (this.size === this.max) this.full = true;
      return;
    }
    let cut = Math.max(0, room);
    const last = cut > 0 ? value.charCodeAt(cut - 1) : 0;
    if (last >= 0xd800 && last <= 0xdbff) cut--;
    if (cut > 0) {
      this.parts.push(value.slice(0, cut));
      this.size += cut;
    }
    this.full = true;
  }

  markFull(): void {
    this.full = true;
  }

  text(): string {
    return this.parts.join('');
  }
}

interface Ctx {
  zip: ZipArchive;
  limits: OfficeLimits;
  sink: TextSink;
  truncated: boolean;
  visited: Set<string>;
  resolveBudget: number;
}

function newCtx(zip: ZipArchive, limits: OfficeLimits): Ctx {
  return {
    zip,
    limits,
    sink: new TextSink(limits.maxRawChars),
    truncated: false,
    visited: new Set(),
    resolveBudget: RESOLVE_BUDGET_FACTOR * limits.maxCentralDirBytes,
  };
}

type PartText = { text: string; full: boolean };
type Walker = (sink: TextSink) => XmlHandler;

function walkPart(ctx: Ctx, name: string, walker: Walker): PartText | ReadFailure | 'skipped' {
  if (ctx.visited.has(name)) return 'skipped';
  ctx.visited.add(name);
  const part = readPart(ctx.zip, name);
  if (!part.ok) return part.why;
  const local = new TextSink(ctx.sink.remaining);
  const status = scanBytes(part.bytes, walker(local), ctx.limits);
  ctx.zip.release(name);
  if (status === 'corrupt') return 'corrupt';
  return { text: local.text(), full: local.full };
}

function append(ctx: Ctx, part: PartText): void {
  ctx.sink.push(part.text);
  if (part.full) ctx.sink.markFull();
}

function emitPart(ctx: Ctx, name: string, walker: Walker, separator: string): void {
  if (ctx.sink.full) return;
  const part = walkPart(ctx, name, walker);
  if (part === 'skipped') return;
  if (typeof part === 'string') {
    ctx.truncated = true;
    return;
  }
  if (ctx.sink.length > 0 && part.text.length > 0) ctx.sink.push(separator);
  append(ctx, part);
}

function mainFailure(why: ReadFailure): OfficeNoText {
  return why === 'limit' ? 'limit' : 'corrupt';
}

function finish(ctx: Ctx): FormatText {
  return { text: ctx.sink.text(), truncated: ctx.truncated || ctx.sink.full };
}

class SkipDepth {
  depth = 0;
  corrupt = false;

  enter(): void {
    this.depth++;
    if (this.depth > MAX_SKIP_DEPTH) this.corrupt = true;
  }

  leave(): void {
    if (this.depth > 0) this.depth--;
  }

  get active(): boolean {
    return this.depth > 0;
  }
}

interface Rel {
  id: string;
  type: string;
  target: string | null;
}

interface Rels {
  byId: Map<string, Rel>;
  list: Rel[];
}

function relType(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1).toLowerCase();
}

function relIdOf(attrs: ReadonlyMap<string, string>): string | null {
  for (const [name, value] of attrs) if (name.endsWith(':id')) return value;
  return null;
}

function readRels(ctx: Ctx, source: string): Rels | ReadFailure {
  const name = relsPartOf(source);
  if (!ctx.zip.has(name)) return 'missing';
  if (ctx.resolveBudget === 0) return 'limit';
  const part = readPart(ctx.zip, name);
  if (!part.ok) return part.why;
  const base = baseDirOf(dirOf(source));
  const cap = ctx.limits.maxEntries;
  const rels: Rels = { byId: new Map(), list: [] };
  let stopped = false;
  const status = scanBytes(
    part.bytes,
    {
      open(local, attrs) {
        if (local !== 'Relationship') return;
        if (rels.list.length >= cap) {
          stopped = true;
          return;
        }
        const id = attrs.get('Id') ?? '';
        const external = (attrs.get('TargetMode') ?? '').toLowerCase() === 'external';
        let target: string | null = null;
        if (!external) {
          const raw = attrs.get('Target') ?? '';
          const cost = base.joined.length + raw.length;
          if (cost > ctx.resolveBudget) {
            ctx.resolveBudget = 0;
            stopped = true;
            return;
          }
          ctx.resolveBudget -= cost;
          target = resolveFrom(base, raw);
        }
        const rel: Rel = { id, type: relType(attrs.get('Type') ?? ''), target };
        rels.list.push(rel);
        if (!rels.byId.has(id)) rels.byId.set(id, rel);
      },
      close() {},
      text() {},
      textRoom: () => 0,
      halt: () => (stopped ? 'stop' : null),
    },
    ctx.limits,
  );
  ctx.zip.release(name);
  if (status === 'corrupt') return 'corrupt';
  if (stopped) ctx.truncated = true;
  return rels;
}

interface ContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

function readContentTypes(ctx: Ctx): ContentTypes | ReadFailure {
  const part = readPart(ctx.zip, CONTENT_TYPES_PART);
  if (!part.ok) return part.why;
  const cap = ctx.limits.maxEntries;
  const types: ContentTypes = { defaults: new Map(), overrides: new Map() };
  let capped = false;
  const keep = (map: Map<string, string>, key: string, value: string): void => {
    if (map.has(key)) return;
    if (map.size >= cap) capped = true;
    else map.set(key, value);
  };
  const status = scanBytes(
    part.bytes,
    {
      open(local, attrs) {
        const contentType = attrs.get('ContentType');
        if (contentType === undefined) return;
        if (local === 'Default') {
          keep(types.defaults, (attrs.get('Extension') ?? '').toLowerCase(), contentType);
        } else if (local === 'Override') {
          const key = resolveTarget('', attrs.get('PartName') ?? '');
          if (key !== null) keep(types.overrides, key, contentType);
        }
      },
      close() {},
      text() {},
      textRoom: () => 0,
    },
    ctx.limits,
  );
  ctx.zip.release(CONTENT_TYPES_PART);
  if (status === 'corrupt') return 'corrupt';
  if (capped) ctx.truncated = true;
  return types;
}

function contentTypeOf(types: ContentTypes, part: string): string {
  const override = types.overrides.get(part);
  if (override !== undefined) return override;
  const file = part.slice(part.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : (types.defaults.get(file.slice(dot + 1)) ?? '');
}

function detect(ctx: Ctx): Detected | OfficeNoText {
  const { zip } = ctx;
  if (!zip.has(CONTENT_TYPES_PART)) return 'not-ooxml';
  const types = readContentTypes(ctx);
  if (typeof types === 'string') return types === 'missing' ? 'not-ooxml' : mainFailure(types);
  let main: string | null = null;
  if (zip.has(ROOT_RELS_PART)) {
    const rels = readRels(ctx, '');
    if (typeof rels === 'string') return rels === 'missing' ? 'not-ooxml' : mainFailure(rels);
    const office = rels.list.find((rel) => rel.type === 'officedocument' && rel.target !== null);
    main = office?.target ?? null;
  } else {
    const mains: string[] = [];
    for (const [part, contentType] of types.overrides) {
      if (mainFormat(contentType) !== null) mains.push(part);
    }
    if (mains.length === 1) main = mains[0];
  }
  if (main === null) return 'not-ooxml';
  const format = mainFormat(contentTypeOf(types, main));
  return format === null ? 'not-ooxml' : { format, main };
}

export function detectFormat(zip: ZipArchive, limits: OfficeLimits): Detected | OfficeNoText {
  return detect(newCtx(zip, limits));
}

function numberedParts(zip: ZipArchive, dir: string, pattern: RegExp): string[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const found: [number, string][] = [];
  for (const name of zip.names()) {
    if (!name.startsWith(prefix)) continue;
    const match = pattern.exec(name.slice(prefix.length));
    if (match !== null) found.push([Number(match[1]), name]);
  }
  found.sort((a, b) => a[0] - b[0]);
  return found.map(([, name]) => name);
}

function isDocxSkip(local: string): boolean {
  return (
    local === 'Fallback' || local === 'delText' || local === 'instrText' || local === 'moveFrom'
  );
}

function docxWalker(sink: TextSink): XmlHandler {
  const skip = new SkipDepth();
  let inText = 0;
  let inRun = 0;
  return {
    open(local) {
      if (isDocxSkip(local)) return skip.enter();
      if (skip.active) return;
      switch (local) {
        case 't':
          inText++;
          break;
        case 'r':
          inRun++;
          break;
        case 'tab':
          if (inRun > 0) sink.push('\t');
          break;
        case 'br':
        case 'cr':
          if (inRun > 0) sink.push('\n');
          break;
        case 'noBreakHyphen':
          if (inRun > 0) sink.push('-');
          break;
      }
    },
    close(local) {
      if (isDocxSkip(local)) return skip.leave();
      if (skip.active) return;
      switch (local) {
        case 't':
          if (inText > 0) inText--;
          break;
        case 'r':
          if (inRun > 0) inRun--;
          break;
        case 'p':
          sink.push('\n');
          break;
        case 'tc':
          sink.push('\t');
          break;
      }
    },
    text(value) {
      if (!skip.active && inText > 0) sink.push(value);
    },
    textRoom: () => (!skip.active && inText > 0 ? sink.remaining : 0),
    halt: () => (skip.corrupt ? 'corrupt' : sink.full ? 'stop' : null),
  };
}

export function docxText(
  zip: ZipArchive,
  main: string,
  limits: OfficeLimits,
): FormatText | OfficeNoText {
  return docxFrom(newCtx(zip, limits), main);
}

function docxFrom(ctx: Ctx, main: string): FormatText | OfficeNoText {
  const body = walkPart(ctx, main, docxWalker);
  if (body === 'skipped') return 'corrupt';
  if (typeof body === 'string') return mainFailure(body);
  append(ctx, body);
  if (ctx.sink.full) return finish(ctx);

  const rels = readRels(ctx, main);
  if (typeof rels === 'string') {
    if (rels !== 'missing') ctx.truncated = true;
    return finish(ctx);
  }
  const targets = (type: string): string[] => {
    const out: string[] = [];
    for (const rel of rels.list) {
      if (rel.type === type && rel.target !== null) out.push(rel.target);
    }
    return out;
  };
  for (const name of [...targets('footnotes'), ...targets('endnotes')]) {
    emitPart(ctx, name, docxWalker, '\n');
  }

  const marginals = [...new Set([...targets('header'), ...targets('footer')])];
  if (marginals.length > MAX_HEADER_FOOTER_PARTS) ctx.truncated = true;
  const seen = new Set<string>();
  for (const name of marginals.slice(0, MAX_HEADER_FOOTER_PARTS)) {
    if (ctx.sink.full) break;
    const part = walkPart(ctx, name, docxWalker);
    if (part === 'skipped') continue;
    if (typeof part === 'string') {
      ctx.truncated = true;
      continue;
    }
    const key = part.text.trim();
    if (key !== '' && !seen.has(key)) {
      seen.add(key);
      if (ctx.sink.length > 0) ctx.sink.push('\n');
      ctx.sink.push(part.text);
    }
    if (part.full) ctx.sink.markFull();
  }
  return finish(ctx);
}

interface SharedStrings {
  strings: string[];
  incomplete: boolean;
}

function readSharedStrings(ctx: Ctx, name: string | null, named: boolean): SharedStrings {
  const shared: SharedStrings = { strings: [], incomplete: false };
  if (name === null) return shared;
  if (!ctx.zip.has(name)) {
    if (named) {
      shared.incomplete = true;
      ctx.truncated = true;
    }
    return shared;
  }
  ctx.visited.add(name);
  const part = readPart(ctx.zip, name);
  if (!part.ok) {
    shared.incomplete = true;
    ctx.truncated = true;
    return shared;
  }
  const max = ctx.limits.maxSharedStrings;
  const skip = new SkipDepth();
  let inItem = false;
  let inText = 0;
  let current: string[] = [];
  const status = scanBytes(
    part.bytes,
    {
      open(local) {
        if (local === 'rPh') return skip.enter();
        if (skip.active) return;
        if (local === 'si') {
          if (shared.strings.length >= max) {
            shared.incomplete = true;
            return;
          }
          inItem = true;
          inText = 0;
          current = [];
        } else if (local === 't' && inItem) {
          inText++;
        }
      },
      close(local) {
        if (local === 'rPh') return skip.leave();
        if (skip.active) return;
        if (local === 't') {
          if (inText > 0) inText--;
        } else if (local === 'si' && inItem) {
          shared.strings.push(current.join(''));
          inItem = false;
        }
      },
      text(value) {
        if (!skip.active && inItem && inText > 0) current.push(value);
      },
      textRoom: () => (!skip.active && inItem && inText > 0 ? Number.POSITIVE_INFINITY : 0),
      halt: () => (skip.corrupt ? 'corrupt' : shared.incomplete ? 'stop' : null),
    },
    ctx.limits,
  );
  ctx.zip.release(name);
  if (status === 'corrupt') {
    shared.strings = [];
    shared.incomplete = true;
    ctx.truncated = true;
  } else if (shared.incomplete) {
    ctx.truncated = true;
  }
  return shared;
}

function parseIndex(value: string): number | null {
  const s = value.trim();
  if (s.length === 0 || s.length > 10) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return null;
    n = n * 10 + (c - 48);
  }
  return n;
}

function sheetWalker(shared: SharedStrings): Walker {
  return (sink) => {
    const skip = new SkipDepth();
    let inCell = false;
    let cellType = 'n';
    let inValue = 0;
    let inInline = 0;
    let inText = 0;
    let parts: string[] = [];
    const cellText = (): string => {
      const raw = parts.join('');
      switch (cellType) {
        case 's': {
          const index = parseIndex(raw);
          if (index === null || index >= shared.strings.length) return '';
          return shared.strings[index];
        }
        case 'b':
        case 'e':
          return '';
        default:
          return raw;
      }
    };
    return {
      open(local, attrs) {
        if (local === 'rPh') return skip.enter();
        if (skip.active) return;
        switch (local) {
          case 'c':
            inCell = true;
            cellType = attrs.get('t') ?? 'n';
            inValue = 0;
            inInline = 0;
            inText = 0;
            parts = [];
            break;
          case 'v':
            if (inCell) inValue++;
            break;
          case 'is':
            if (inCell) inInline++;
            break;
          case 't':
            if (inInline > 0) inText++;
            break;
        }
      },
      close(local) {
        if (local === 'rPh') return skip.leave();
        if (skip.active) return;
        switch (local) {
          case 'v':
            if (inValue > 0) inValue--;
            break;
          case 'is':
            if (inInline > 0) inInline--;
            break;
          case 't':
            if (inText > 0) inText--;
            break;
          case 'c':
            if (inCell) {
              sink.push(cellText());
              sink.push('\t');
              inCell = false;
              parts = [];
            }
            break;
          case 'row':
            sink.push('\n');
            break;
        }
      },
      text(value) {
        if (skip.active || !inCell) return;
        if (cellType === 'inlineStr' ? inText > 0 : inValue > 0) parts.push(value);
      },
      textRoom: () => {
        if (skip.active || !inCell) return 0;
        if (!(cellType === 'inlineStr' ? inText > 0 : inValue > 0)) return 0;
        if (cellType === 'b' || cellType === 'e') return 0;
        return cellType === 's' ? Number.POSITIVE_INFINITY : sink.remaining;
      },
      halt: () => (skip.corrupt ? 'corrupt' : sink.full ? 'stop' : null),
    };
  };
}

interface ListedPart {
  name: string;
  rid: string | null;
}

function readList(
  ctx: Ctx,
  main: string,
  container: string,
  item: string,
): { items: ListedPart[]; status: ScanStatus } | ReadFailure {
  ctx.visited.add(main);
  const part = readPart(ctx.zip, main);
  if (!part.ok) return part.why;
  const listed = scanList(ctx, part.bytes, container, item);
  ctx.zip.release(main);
  return listed;
}

function scanList(
  ctx: Ctx,
  bytes: Uint8Array,
  container: string,
  item: string,
): { items: ListedPart[]; status: ScanStatus } {
  const items: ListedPart[] = [];
  const cap = ctx.limits.maxParts;
  let depth = 0;
  let capped = false;
  const status = scanBytes(
    bytes,
    {
      open(local, attrs) {
        if (local === container) {
          depth++;
        } else if (local === item && depth > 0) {
          if (items.length >= cap) capped = true;
          else items.push({ name: attrs.get('name') ?? '', rid: relIdOf(attrs) });
        }
      },
      close(local) {
        if (local === container && depth > 0) depth--;
      },
      text() {},
      textRoom: () => 0,
      halt: () => (capped ? 'stop' : null),
    },
    ctx.limits,
  );
  if (capped) ctx.truncated = true;
  return { items, status };
}

const SHEET_FILE = /^sheet(\d{1,9})\.xml$/;
const SLIDE_FILE = /^slide(\d{1,9})\.xml$/;

export function xlsxText(
  zip: ZipArchive,
  main: string,
  limits: OfficeLimits,
): FormatText | OfficeNoText {
  return xlsxFrom(newCtx(zip, limits), main);
}

function xlsxFrom(ctx: Ctx, main: string): FormatText | OfficeNoText {
  const { zip } = ctx;
  const listed = readList(ctx, main, 'sheets', 'sheet');
  if (typeof listed === 'string') return mainFailure(listed);
  if (listed.status === 'corrupt') return 'corrupt';

  const rels = readRels(ctx, main);
  const prefix = dirOf(main) === '' ? '' : `${dirOf(main)}/`;
  const sheets: { name: string | null; target: string | null }[] = [];
  let sharedName: string | null = null;
  let sharedNamed = false;
  if (typeof rels === 'string') {
    if (rels !== 'missing') ctx.truncated = true;
    for (const sheet of listed.items) sheets.push({ name: sheet.name, target: null });
    for (const target of numberedParts(zip, `${prefix}worksheets`, SHEET_FILE)) {
      sheets.push({ name: null, target });
    }
    sharedName = `${prefix}sharedstrings.xml`;
  } else {
    for (const sheet of listed.items) {
      const rel = sheet.rid === null ? undefined : rels.byId.get(sheet.rid);
      if (rel !== undefined && rel.type !== 'worksheet') continue;
      if (rel === undefined || rel.target === null) {
        ctx.truncated = true;
        sheets.push({ name: sheet.name, target: null });
        continue;
      }
      sheets.push({ name: sheet.name, target: rel.target });
    }
    const sharedRel = rels.list.find((rel) => rel.type === 'sharedstrings');
    if (sharedRel !== undefined && sharedRel.target === null) ctx.truncated = true;
    sharedName = sharedRel?.target ?? null;
    sharedNamed = true;
  }

  const walker = sheetWalker(readSharedStrings(ctx, sharedName, sharedNamed));
  for (const sheet of sheets) {
    if (ctx.sink.full) break;
    if (sheet.name !== null) {
      if (ctx.sink.length > 0) ctx.sink.push('\n');
      ctx.sink.push(sheet.name);
      ctx.sink.push('\n');
    }
    if (sheet.target !== null) {
      emitPart(ctx, sheet.target, walker, sheet.name === null ? '\n' : '');
    }
  }
  return finish(ctx);
}

function pptxWalker(sink: TextSink): XmlHandler {
  const skip = new SkipDepth();
  let inText = 0;
  return {
    open(local) {
      if (local === 'Fallback') return skip.enter();
      if (skip.active) return;
      if (local === 't') inText++;
      else if (local === 'br') sink.push('\n');
    },
    close(local) {
      if (local === 'Fallback') return skip.leave();
      if (skip.active) return;
      if (local === 't') {
        if (inText > 0) inText--;
      } else if (local === 'p') {
        sink.push('\n');
      } else if (local === 'tc') {
        sink.push('\t');
      }
    },
    text(value) {
      if (!skip.active && inText > 0) sink.push(value);
    },
    textRoom: () => (!skip.active && inText > 0 ? sink.remaining : 0),
    halt: () => (skip.corrupt ? 'corrupt' : sink.full ? 'stop' : null),
  };
}

export function pptxText(
  zip: ZipArchive,
  main: string,
  limits: OfficeLimits,
): FormatText | OfficeNoText {
  return pptxFrom(newCtx(zip, limits), main);
}

function pptxFrom(ctx: Ctx, main: string): FormatText | OfficeNoText {
  const { zip } = ctx;
  const listed = readList(ctx, main, 'sldIdLst', 'sldId');
  if (typeof listed === 'string') return mainFailure(listed);
  if (listed.status === 'corrupt') return 'corrupt';

  const rels = readRels(ctx, main);
  const slides: string[] = [];
  if (typeof rels === 'string') {
    if (rels !== 'missing') ctx.truncated = true;
    const dir = dirOf(main);
    slides.push(...numberedParts(zip, `${dir === '' ? '' : `${dir}/`}slides`, SLIDE_FILE));
  } else {
    for (const item of listed.items) {
      const rel = item.rid === null ? undefined : rels.byId.get(item.rid);
      if (rel === undefined || rel.type !== 'slide' || rel.target === null) {
        ctx.truncated = true;
        continue;
      }
      slides.push(rel.target);
    }
  }

  const unique = [...new Set(slides)];
  for (const slide of unique) emitPart(ctx, slide, pptxWalker, '\n\n');
  for (const slide of unique) {
    if (ctx.sink.full) break;
    const slideRels = readRels(ctx, slide);
    if (typeof slideRels === 'string') {
      if (slideRels !== 'missing') ctx.truncated = true;
      continue;
    }
    const notes = slideRels.list.find((rel) => rel.type === 'notesslide' && rel.target !== null);
    if (notes?.target) emitPart(ctx, notes.target, pptxWalker, '\n\n');
  }
  return finish(ctx);
}

export function extractFromArchive(zip: ZipArchive, limits: OfficeLimits): OfficeTextResult {
  const ctx = newCtx(zip, limits);
  const detected = detect(ctx);
  if (typeof detected === 'string') return { ok: false, reason: detected };
  const walk =
    detected.format === 'docx' ? docxFrom : detected.format === 'xlsx' ? xlsxFrom : pptxFrom;
  const result = walk(ctx, detected.main);
  if (typeof result === 'string') return { ok: false, reason: result };
  if (result.text.trim().length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, format: detected.format, text: result.text, truncated: result.truncated };
}
