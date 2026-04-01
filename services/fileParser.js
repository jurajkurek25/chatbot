'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse uploaded file and return its text content.
 * Supports: PDF, TXT, MD, CSV
 */
async function parseFile(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    return parsePdf(filePath);
  }

  if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf-8').slice(0, 100000);
  }

  throw new Error(`Nepodporovaný typ súboru: ${ext}`);
}

async function parsePdf(filePath) {
  try {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text.slice(0, 100000);
  } catch (err) {
    throw new Error(`Chyba pri čítaní PDF: ${err.message}`);
  }
}

/**
 * Clean up uploaded file after processing.
 */
function cleanupFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

module.exports = { parseFile, cleanupFile };
