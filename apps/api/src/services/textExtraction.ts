import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";

// Collapses ligatures/hyphenation artifacts and repeated whitespace that PDF
// extraction tends to leave behind, without altering the actual wording.
function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractText(filePath: string): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".txt") {
    const raw = await readFile(filePath, "utf-8");
    return cleanText(raw);
  }

  if (extension === ".pdf") {
    const buffer = await readFile(filePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return cleanText(result.text);
    } finally {
      await parser.destroy();
    }
  }

  throw new Error(`Unsupported file type: ${extension} (only .pdf and .txt are supported)`);
}
