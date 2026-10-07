import { lstat, readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { JsonValue } from "@commandharbor/protocol";
import { PDFDocument, StandardFonts } from "pdf-lib";
import PDFParser, { type Output as Pdf2JsonOutput } from "pdf2json";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type * as ExcelJSTypes from "@andreeewill/exceljs";
// @ts-expect-error The package does not publish a declaration for its self-contained browser runtime entry.
import ExcelJSRuntime from "@andreeewill/exceljs/dist/exceljs.bare.js";
const ExcelJS = ExcelJSRuntime as typeof ExcelJSTypes;

export const DOCUMENT_CAPABILITY_NAMES = [
  "read_pdf",
  "search_pdf",
  "create_pdf",
  "modify_pdf",
  "read_docx",
  "search_docx",
  "create_docx",
  "edit_docx",
  "read_xlsx_range",
  "write_xlsx_range",
  "create_xlsx_table",
  "set_xlsx_formula",
] as const;

type Args = Record<string, JsonValue>;
type Scalar = string | number | boolean | null;

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_TEXT_BYTES = 128 * 1024;
const MAX_PDF_PAGES = 200;
const MAX_PDF_READ_PAGES = 10;
const MAX_PDF_PAGE_TEXT = 16 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_DOCX_XML_BYTES = 4 * 1024 * 1024;
const MAX_DOCX_PARAGRAPHS = 2000;
const MAX_DOCX_READ_PARAGRAPHS = 100;
const MAX_PARAGRAPH_CHARS = 4096;
const MAX_XLSX_ROWS = 200;
const MAX_XLSX_COLUMNS = 50;
const MAX_XLSX_CELLS = 5000;
const MAX_CELL_TEXT = 4096;

export interface DocumentCapabilityOptions {
  validatePath(path: string, allowMissing: boolean): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key)) && actual.every((key) => allowed.has(key));
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("cancelled");
}

function requirePath(value: unknown, extension: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || !isAbsolute(value)) {
    throw new Error("invalid_arguments");
  }
  if (extname(value).toLowerCase() !== extension) throw new Error("invalid_artifact_extension");
  return value;
}

function requireString(value: unknown, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.includes("\0")) {
    throw new Error("invalid_arguments");
  }
  return value;
}

function requireInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error("invalid_arguments");
  }
  return Number(value);
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid_arguments");
  return value;
}

function requireScalar(value: unknown): Scalar {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    if (typeof value === "string" && value.length > MAX_CELL_TEXT) throw new Error("invalid_arguments");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("invalid_arguments");
    return value;
  }
  throw new Error("invalid_arguments");
}

async function requireRegularFile(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("path_not_found");
    throw error;
  }
  if (!stats.isFile()) throw new Error("not_a_file");
  if (stats.size > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
  return stats.size;
}

async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("path_already_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function fitUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: value.slice(0, low), truncated: true };
}

function compileBoundedQuery(query: string, mode: "literal" | "regex", caseSensitive: boolean) {
  if (query.length < 1 || query.length > 1024 || query.includes("\0")) throw new Error("invalid_arguments");
  if (mode === "literal") {
    const needle = caseSensitive ? query : query.toLowerCase();
    return {
      match(value: string): { index: number; length: number } | null {
        const haystack = caseSensitive ? value : value.toLowerCase();
        const index = haystack.indexOf(needle);
        return index < 0 ? null : { index, length: query.length };
      },
    };
  }
  if (query.length > 256 || /[()]/.test(query) || /\\[1-9]/.test(query)) throw new Error("invalid_arguments");
  let regex: RegExp;
  try {
    regex = new RegExp(query, caseSensitive ? "" : "i");
  } catch {
    throw new Error("invalid_arguments");
  }
  return {
    match(value: string): { index: number; length: number } | null {
      regex.lastIndex = 0;
      const match = regex.exec(value);
      if (!match) return null;
      return { index: match.index, length: Math.max(1, match[0]?.length ?? 1) };
    },
  };
}

function snippet(value: string, index: number, length: number): string {
  const start = Math.max(0, index - 180);
  const end = Math.min(value.length, index + length + 180);
  return value.slice(start, end);
}

function decodePdfText(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function extractPdfPages(path: string, signal: AbortSignal): Promise<string[]> {
  requireActive(signal);
  const bytes = await readFile(path);
  requireActive(signal);
  const parser = new PDFParser(null, false);
  try {
    const data = await new Promise<Pdf2JsonOutput>((resolve, reject) => {
      const onAbort = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      parser.once("pdfParser_dataReady", (output) => {
        signal.removeEventListener("abort", onAbort);
        resolve(output);
      });
      parser.once("pdfParser_dataError", (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : error.parserError);
      });
      parser.parseBuffer(bytes, 0);
    });
    if (data.Pages.length > MAX_PDF_PAGES) throw new Error("artifact_page_limit");
    return data.Pages.map((page) => page.Texts
      .flatMap((text) => text.R.map((run) => decodePdfText(run.T)))
      .filter(Boolean)
      .join(" "));
  } catch (error) {
    if (error instanceof Error && ["artifact_page_limit", "cancelled"].includes(error.message)) throw error;
    throw new Error("invalid_pdf");
  } finally {
    parser.destroy();
  }
}

async function readPdf(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "pageStart", "pageCount"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".pdf");
  const pageStart = requireInteger(args.pageStart, 1, MAX_PDF_PAGES);
  const pageCount = requireInteger(args.pageCount, 1, MAX_PDF_READ_PAGES);
  await options.validatePath(path, false);
  await requireRegularFile(path);
  const pages = await extractPdfPages(path, signal);
  if (pageStart > pages.length) throw new Error("page_out_of_range");
  let remainingBytes = MAX_RESULT_TEXT_BYTES;
  let truncated = false;
  const selected: Array<Record<string, JsonValue>> = [];
  for (let index = pageStart - 1; index < Math.min(pages.length, pageStart - 1 + pageCount); index += 1) {
    const fitted = fitUtf8(pages[index]!, Math.min(MAX_PDF_PAGE_TEXT, remainingBytes));
    selected.push({ pageNumber: index + 1, text: fitted.text, truncated: fitted.truncated });
    remainingBytes -= Buffer.byteLength(fitted.text, "utf8");
    truncated ||= fitted.truncated;
    if (remainingBytes <= 0) {
      truncated = true;
      break;
    }
  }
  return {
    path,
    pageCount: pages.length,
    pages: selected,
    truncated: truncated || pageStart - 1 + pageCount < pages.length,
  };
}

async function searchPdf(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "query", "queryMode", "caseSensitive", "maxResults"])) {
    throw new Error("invalid_arguments");
  }
  const path = requirePath(args.path, ".pdf");
  const query = requireString(args.query, 1, 1024);
  const queryMode = args.queryMode;
  if (queryMode !== "literal" && queryMode !== "regex") throw new Error("invalid_arguments");
  const caseSensitive = requireBoolean(args.caseSensitive);
  const maxResults = requireInteger(args.maxResults, 1, MAX_SEARCH_RESULTS);
  await options.validatePath(path, false);
  await requireRegularFile(path);
  const matcher = compileBoundedQuery(query, queryMode, caseSensitive);
  const pages = await extractPdfPages(path, signal);
  const results: Array<Record<string, JsonValue>> = [];
  for (let index = 0; index < pages.length; index += 1) {
    requireActive(signal);
    const match = matcher.match(pages[index]!);
    if (!match) continue;
    results.push({
      pageNumber: index + 1,
      text: fitUtf8(snippet(pages[index]!, match.index, match.length), 1024).text,
    });
    if (results.length >= maxResults) break;
  }
  return { path, results, truncated: results.length >= maxResults };
}

async function createPdf(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "pages"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".pdf");
  if (!Array.isArray(args.pages) || args.pages.length < 1 || args.pages.length > 25) {
    throw new Error("invalid_arguments");
  }
  const pages = args.pages.map((page) => {
    if (!isRecord(page) || !exactKeys(page, ["lines"]) || !Array.isArray(page.lines)) {
      throw new Error("invalid_arguments");
    }
    if (page.lines.length < 1 || page.lines.length > 40) throw new Error("invalid_arguments");
    return page.lines.map((line) => requireString(line, 0, 2000));
  });
  await options.validatePath(path, true);
  await requireMissing(path);
  requireActive(signal);
  try {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const lines of pages) {
      requireActive(signal);
      const page = document.addPage([612, 792]);
      let y = 738;
      for (const line of lines) {
        page.drawText(line, { x: 54, y, size: 12, font, maxWidth: 504, lineHeight: 15 });
        y -= 18;
      }
    }
    const bytes = Buffer.from(await document.save());
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
    await writeFile(path, bytes, { flag: "wx" });
    return { path, pageCount: pages.length, bytesWritten: bytes.length };
  } catch (error) {
    if (error instanceof Error && ["artifact_too_large", "cancelled", "path_already_exists"].includes(error.message)) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("path_already_exists");
    throw new Error("pdf_create_failed");
  }
}

async function modifyPdf(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "pageNumber", "text", "x", "y", "fontSize"])) {
    throw new Error("invalid_arguments");
  }
  const path = requirePath(args.path, ".pdf");
  const pageNumber = requireInteger(args.pageNumber, 1, MAX_PDF_PAGES);
  const text = requireString(args.text, 1, 16_384);
  if (typeof args.x !== "number" || !Number.isFinite(args.x) || args.x < 0 || args.x > 5000) {
    throw new Error("invalid_arguments");
  }
  if (typeof args.y !== "number" || !Number.isFinite(args.y) || args.y < 0 || args.y > 5000) {
    throw new Error("invalid_arguments");
  }
  if (typeof args.fontSize !== "number" || !Number.isFinite(args.fontSize) || args.fontSize < 6 || args.fontSize > 72) {
    throw new Error("invalid_arguments");
  }
  await options.validatePath(path, false);
  await requireRegularFile(path);
  requireActive(signal);
  try {
    const original = await readFile(path);
    const document = await PDFDocument.load(original);
    if (document.getPageCount() > MAX_PDF_PAGES) throw new Error("artifact_page_limit");
    if (pageNumber > document.getPageCount()) throw new Error("page_out_of_range");
    const page = document.getPage(pageNumber - 1);
    const { width, height } = page.getSize();
    if (args.x > width || args.y > height) throw new Error("coordinates_out_of_range");
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: args.x, y: args.y, size: args.fontSize, font, maxWidth: Math.max(1, width - args.x) });
    const bytes = Buffer.from(await document.save());
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
    requireActive(signal);
    await writeFile(path, bytes);
    return { path, pageNumber, bytesWritten: bytes.length };
  } catch (error) {
    if (
      error instanceof Error
      && ["artifact_page_limit", "page_out_of_range", "coordinates_out_of_range", "artifact_too_large", "cancelled"].includes(error.message)
    ) {
      throw error;
    }
    throw new Error("invalid_pdf");
  }
}

type DocxData = {
  zip: JSZip;
  documentXml: string;
  document: ReturnType<DOMParser["parseFromString"]>;
  paragraphs: string[];
};

function docxParagraphs(document: ReturnType<DOMParser["parseFromString"]>): string[] {
  const nodes = document.getElementsByTagName("w:p");
  const paragraphs: string[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const paragraph = nodes.item(index);
    if (!paragraph) continue;
    const texts = paragraph.getElementsByTagName("w:t");
    let value = "";
    for (let textIndex = 0; textIndex < texts.length; textIndex += 1) {
      value += texts.item(textIndex)?.textContent ?? "";
    }
    paragraphs.push(value);
    if (paragraphs.length > MAX_DOCX_PARAGRAPHS) throw new Error("artifact_paragraph_limit");
  }
  return paragraphs;
}

async function loadDocx(path: string, signal: AbortSignal): Promise<DocxData> {
  requireActive(signal);
  const bytes = await readFile(path);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    throw new Error("invalid_docx");
  }
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("invalid_docx");
  const rawData = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  if (typeof rawData?.uncompressedSize === "number" && rawData.uncompressedSize > MAX_DOCX_XML_BYTES) {
    throw new Error("artifact_too_large");
  }
  requireActive(signal);
  const documentXml = await entry.async("string");
  if (Buffer.byteLength(documentXml, "utf8") > MAX_DOCX_XML_BYTES) throw new Error("artifact_too_large");
  let parseError: string | null = null;
  const parser = new DOMParser({
    errorHandler: (level, message) => {
      if (level !== "warning") parseError = String(message);
    },
  });
  const document = parser.parseFromString(documentXml, "application/xml");
  if (parseError || !document.documentElement) throw new Error("invalid_docx");
  return { zip, documentXml, document, paragraphs: docxParagraphs(document) };
}

async function readDocx(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "paragraphStart", "paragraphCount"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".docx");
  const paragraphStart = requireInteger(args.paragraphStart, 1, MAX_DOCX_PARAGRAPHS);
  const paragraphCount = requireInteger(args.paragraphCount, 1, MAX_DOCX_READ_PARAGRAPHS);
  await options.validatePath(path, false);
  await requireRegularFile(path);
  const data = await loadDocx(path, signal);
  if (paragraphStart > Math.max(1, data.paragraphs.length)) throw new Error("paragraph_out_of_range");
  const result: Array<Record<string, JsonValue>> = [];
  let remaining = MAX_RESULT_TEXT_BYTES;
  let truncated = false;
  const end = Math.min(data.paragraphs.length, paragraphStart - 1 + paragraphCount);
  for (let index = paragraphStart - 1; index < end; index += 1) {
    const fitted = fitUtf8(data.paragraphs[index]!, Math.min(MAX_PARAGRAPH_CHARS, remaining));
    result.push({ paragraphNumber: index + 1, text: fitted.text, truncated: fitted.truncated });
    remaining -= Buffer.byteLength(fitted.text, "utf8");
    truncated ||= fitted.truncated;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
  }
  return {
    path,
    paragraphCount: data.paragraphs.length,
    paragraphs: result,
    truncated: truncated || end < data.paragraphs.length,
  };
}

async function searchDocx(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "query", "caseSensitive", "maxResults"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".docx");
  const query = requireString(args.query, 1, 1024);
  const caseSensitive = requireBoolean(args.caseSensitive);
  const maxResults = requireInteger(args.maxResults, 1, MAX_SEARCH_RESULTS);
  await options.validatePath(path, false);
  await requireRegularFile(path);
  const data = await loadDocx(path, signal);
  const needle = caseSensitive ? query : query.toLowerCase();
  const results: Array<Record<string, JsonValue>> = [];
  for (let index = 0; index < data.paragraphs.length; index += 1) {
    requireActive(signal);
    const paragraph = data.paragraphs[index]!;
    const haystack = caseSensitive ? paragraph : paragraph.toLowerCase();
    const found = haystack.indexOf(needle);
    if (found < 0) continue;
    results.push({
      paragraphNumber: index + 1,
      text: fitUtf8(snippet(paragraph, found, query.length), 1024).text,
    });
    if (results.length >= maxResults) break;
  }
  return { path, results, truncated: results.length >= maxResults };
}

async function createDocx(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "paragraphs"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".docx");
  if (!Array.isArray(args.paragraphs) || args.paragraphs.length < 1 || args.paragraphs.length > 500) {
    throw new Error("invalid_arguments");
  }
  const paragraphs = args.paragraphs.map((value) => requireString(value, 0, MAX_PARAGRAPH_CHARS));
  await options.validatePath(path, true);
  await requireMissing(path);
  requireActive(signal);
  try {
    const document = new Document({
      sections: [{ children: paragraphs.map((value) => new Paragraph({ text: value })) }],
    });
    const bytes = await Packer.toBuffer(document);
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
    await writeFile(path, bytes, { flag: "wx" });
    return { path, paragraphCount: paragraphs.length, bytesWritten: bytes.length };
  } catch (error) {
    if (error instanceof Error && ["artifact_too_large", "cancelled"].includes(error.message)) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("path_already_exists");
    throw new Error("docx_create_failed");
  }
}

async function editDocx(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "oldText", "newText", "expectedReplacements"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".docx");
  const oldText = requireString(args.oldText, 1, MAX_PARAGRAPH_CHARS);
  const newText = requireString(args.newText, 0, MAX_PARAGRAPH_CHARS);
  const expectedReplacements = requireInteger(args.expectedReplacements, 1, 100);
  await options.validatePath(path, false);
  await requireRegularFile(path);
  const data = await loadDocx(path, signal);
  const textNodes = data.document.getElementsByTagName("w:t");
  let replacements = 0;
  for (let index = 0; index < textNodes.length; index += 1) {
    requireActive(signal);
    const node = textNodes.item(index);
    if (!node) continue;
    const current = node.textContent ?? "";
    let cursor = 0;
    let next = "";
    let local = 0;
    while (true) {
      const found = current.indexOf(oldText, cursor);
      if (found < 0) break;
      next += current.slice(cursor, found) + newText;
      cursor = found + oldText.length;
      local += 1;
    }
    if (local > 0) {
      next += current.slice(cursor);
      node.textContent = next;
      replacements += local;
    }
  }
  if (replacements !== expectedReplacements) throw new Error("replacement_count_mismatch");
  const xml = new XMLSerializer().serializeToString(data.document);
  if (Buffer.byteLength(xml, "utf8") > MAX_DOCX_XML_BYTES) throw new Error("artifact_too_large");
  data.zip.file("word/document.xml", xml);
  const bytes = await data.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
  requireActive(signal);
  await writeFile(path, bytes);
  return { path, replacements, bytesWritten: bytes.length };
}

function columnNumber(label: string): number {
  let value = 0;
  for (const char of label) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function cellAddress(value: unknown): { row: number; column: number; address: string } {
  const raw = requireString(value, 2, 16).toUpperCase();
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(raw);
  if (!match) throw new Error("invalid_arguments");
  const column = columnNumber(match[1]!);
  const row = Number(match[2]!);
  if (column < 1 || column > 16_384 || row < 1 || row > 1_048_576) throw new Error("invalid_arguments");
  return { row, column, address: raw };
}

function rangeAddress(value: unknown) {
  const raw = requireString(value, 5, 40).toUpperCase();
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(raw);
  if (!match) throw new Error("invalid_arguments");
  const startColumn = columnNumber(match[1]!);
  const startRow = Number(match[2]!);
  const endColumn = columnNumber(match[3]!);
  const endRow = Number(match[4]!);
  if (endColumn < startColumn || endRow < startRow) throw new Error("invalid_arguments");
  const rows = endRow - startRow + 1;
  const columns = endColumn - startColumn + 1;
  if (rows > MAX_XLSX_ROWS || columns > MAX_XLSX_COLUMNS || rows * columns > MAX_XLSX_CELLS) {
    throw new Error("range_too_large");
  }
  return { raw, startColumn, startRow, endColumn, endRow, rows, columns, topLeft: `${match[1]}${match[2]}` };
}

function requireSheetName(value: unknown): string {
  const name = requireString(value, 1, 31);
  if (/[:\\/?*\[\]]/.test(name) || name.startsWith("'") || name.endsWith("'")) throw new Error("invalid_arguments");
  return name;
}

function toScalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, MAX_CELL_TEXT);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text.slice(0, MAX_CELL_TEXT);
    if (Array.isArray(value.richText)) {
      return value.richText.map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "").join("").slice(0, MAX_CELL_TEXT);
    }
    if (typeof value.error === "string") return value.error.slice(0, MAX_CELL_TEXT);
  }
  return String(value).slice(0, MAX_CELL_TEXT);
}

function cellPayload(cell: ExcelJSTypes.Cell): Record<string, JsonValue> {
  const raw = cell.value;
  if (isRecord(raw) && typeof raw.formula === "string") {
    return {
      address: cell.address,
      value: null,
      formula: raw.formula.slice(0, MAX_CELL_TEXT),
      result: toScalar(raw.result),
    };
  }
  return {
    address: cell.address,
    value: toScalar(raw),
    formula: null,
    result: null,
  };
}

async function loadWorkbook(path: string): Promise<ExcelJSTypes.Workbook> {
  const bytes = await readFile(path);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as never);
  } catch {
    throw new Error("invalid_xlsx");
  }
  return workbook;
}

async function saveWorkbook(path: string, workbook: ExcelJSTypes.Workbook, flag?: "wx"): Promise<number> {
  const raw = await workbook.xlsx.writeBuffer();
  const bytes = Buffer.from(raw);
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
  try {
    await writeFile(path, bytes, flag ? { flag } : undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("path_already_exists");
    throw error;
  }
  return bytes.length;
}

async function readXlsxRange(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "sheet", "range"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".xlsx");
  const sheetName = requireSheetName(args.sheet);
  const range = rangeAddress(args.range);
  await options.validatePath(path, false);
  await requireRegularFile(path);
  requireActive(signal);
  const workbook = await loadWorkbook(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error("sheet_not_found");
  const rows: Array<JsonValue[]> = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    requireActive(signal);
    const values: JsonValue[] = [];
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      values.push(cellPayload(sheet.getCell(row, column)));
    }
    rows.push(values);
  }
  return { path, sheet: sheetName, range: range.raw, rows };
}

function matrix(value: unknown): Scalar[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_XLSX_ROWS) throw new Error("invalid_arguments");
  const rows = value.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > MAX_XLSX_COLUMNS) throw new Error("invalid_arguments");
    return row.map(requireScalar);
  });
  const width = rows[0]!.length;
  if (rows.some((row) => row.length !== width) || rows.length * width > MAX_XLSX_CELLS) {
    throw new Error("invalid_arguments");
  }
  return rows;
}

async function writeXlsxRange(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "sheet", "startCell", "values", "mode"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".xlsx");
  const sheetName = requireSheetName(args.sheet);
  const start = cellAddress(args.startCell);
  const values = matrix(args.values);
  const mode = args.mode;
  if (mode !== "create" && mode !== "update") throw new Error("invalid_arguments");
  const lastRow = start.row + values.length - 1;
  const lastColumn = start.column + values[0]!.length - 1;
  if (lastRow > 1_048_576 || lastColumn > 16_384) throw new Error("range_out_of_bounds");
  await options.validatePath(path, mode === "create");
  let workbook: ExcelJSTypes.Workbook;
  let sheet: ExcelJSTypes.Worksheet;
  if (mode === "create") {
    await requireMissing(path);
    workbook = new ExcelJS.Workbook();
    sheet = workbook.addWorksheet(sheetName);
  } else {
    await requireRegularFile(path);
    workbook = await loadWorkbook(path);
    const existing = workbook.getWorksheet(sheetName);
    if (!existing) throw new Error("sheet_not_found");
    sheet = existing;
  }
  for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
    requireActive(signal);
    for (let columnOffset = 0; columnOffset < values[rowOffset]!.length; columnOffset += 1) {
      sheet.getCell(start.row + rowOffset, start.column + columnOffset).value = values[rowOffset]![columnOffset] as never;
    }
  }
  const bytesWritten = await saveWorkbook(path, workbook, mode === "create" ? "wx" : undefined);
  return {
    path,
    sheet: sheetName,
    startCell: start.address,
    rowsWritten: values.length,
    columnsWritten: values[0]!.length,
    bytesWritten,
  };
}

async function createXlsxTable(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "sheet", "name", "range"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".xlsx");
  const sheetName = requireSheetName(args.sheet);
  const name = requireString(args.name, 1, 128);
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) throw new Error("invalid_arguments");
  const range = rangeAddress(args.range);
  if (range.rows < 2) throw new Error("invalid_arguments");
  await options.validatePath(path, false);
  await requireRegularFile(path);
  const workbook = await loadWorkbook(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error("sheet_not_found");
  const headers: string[] = [];
  for (let column = range.startColumn; column <= range.endColumn; column += 1) {
    const payload = cellPayload(sheet.getCell(range.startRow, column));
    if (payload.formula !== null || typeof payload.value !== "string" || payload.value.length < 1) {
      throw new Error("invalid_table_header");
    }
    headers.push(payload.value);
  }
  if (new Set(headers.map((header) => header.toLowerCase())).size !== headers.length) {
    throw new Error("invalid_table_header");
  }
  const rows: Scalar[][] = [];
  for (let row = range.startRow + 1; row <= range.endRow; row += 1) {
    requireActive(signal);
    const values: Scalar[] = [];
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      const payload = cellPayload(sheet.getCell(row, column));
      if (payload.formula !== null) throw new Error("table_formula_not_supported");
      values.push(payload.value as Scalar);
    }
    rows.push(values);
  }
  try {
    sheet.addTable({
      name,
      ref: range.topLeft,
      headerRow: true,
      totalsRow: false,
      columns: headers.map((header) => ({ name: header })),
      rows,
    });
  } catch {
    throw new Error("xlsx_table_failed");
  }
  const bytesWritten = await saveWorkbook(path, workbook);
  return {
    path,
    sheet: sheetName,
    name,
    range: range.raw,
    rowCount: range.rows,
    columnCount: range.columns,
    bytesWritten,
  };
}

async function setXlsxFormula(args: Args, options: DocumentCapabilityOptions, signal: AbortSignal): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "sheet", "cell", "formula", "result"])) throw new Error("invalid_arguments");
  const path = requirePath(args.path, ".xlsx");
  const sheetName = requireSheetName(args.sheet);
  const cell = cellAddress(args.cell);
  const rawFormula = requireString(args.formula, 1, MAX_CELL_TEXT);
  const formula = rawFormula.startsWith("=") ? rawFormula.slice(1) : rawFormula;
  if (formula.length < 1) throw new Error("invalid_arguments");
  const result = requireScalar(args.result);
  await options.validatePath(path, false);
  await requireRegularFile(path);
  requireActive(signal);
  const workbook = await loadWorkbook(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error("sheet_not_found");
  sheet.getCell(cell.row, cell.column).value = result === null ? { formula } : { formula, result };
  workbook.calcProperties.fullCalcOnLoad = true;
  const bytesWritten = await saveWorkbook(path, workbook);
  return { path, sheet: sheetName, cell: cell.address, formula, result, bytesWritten };
}

export function createDocumentCapabilityExecutor(options: DocumentCapabilityOptions) {
  return async (name: string, args: Args, signal: AbortSignal): Promise<JsonValue> => {
    requireActive(signal);
    if (!isRecord(args)) throw new Error("invalid_arguments");
    switch (name) {
      case "read_pdf": return readPdf(args, options, signal);
      case "search_pdf": return searchPdf(args, options, signal);
      case "create_pdf": return createPdf(args, options, signal);
      case "modify_pdf": return modifyPdf(args, options, signal);
      case "read_docx": return readDocx(args, options, signal);
      case "search_docx": return searchDocx(args, options, signal);
      case "create_docx": return createDocx(args, options, signal);
      case "edit_docx": return editDocx(args, options, signal);
      case "read_xlsx_range": return readXlsxRange(args, options, signal);
      case "write_xlsx_range": return writeXlsxRange(args, options, signal);
      case "create_xlsx_table": return createXlsxTable(args, options, signal);
      case "set_xlsx_formula": return setXlsxFormula(args, options, signal);
      default: throw new Error("unsupported_capability");
    }
  };
}
