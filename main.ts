// csv-reader-speed-01 entry: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// The driver mirrors the house baseline's main.ts: read every case from
// /input/cases.json (MAKEFUN_INPUT_DIR outside a container), answer each with
// run(), write /output/answers.json (MAKEFUN_OUTPUT_DIR) as a JSON array in
// the cases' order. run(input) below returns exactly csv-reader 1.0.0's
// reading of input {text, header}: {columns, rows, errors} under its written
// broken-row policy — BOM dropped, LF/CRLF records, stray CRs dropped outside
// quotes, quoted fields with "" escapes and CRs read as LF, junk after a
// closing quote appended, an unterminated quote re-read as unquoted, rows
// padded (short_row) or cut (long_row) to the first record's width, errors
// {code, line, row} in the order met.
//
// Where the reference reads one character at a time and builds each field a
// character at a time, this reader scans each field's plain run in a tight
// loop and cuts it out with one slice; the slow paths (a stray CR inside a
// field, CRs inside quotes, an unterminated quote) fall back to the same
// control flow the policy describes, so the answers are the same by
// construction, not by approximation.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The house baseline runs with V8's incremental marking off; an entry may
// tune V8's flags the same way, and this one keeps the same setting.
setFlagsFromString('--no-incremental-marking');

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these two.
  let recordLine = 1;
  let recordRow = null;

  // The field readers report through these three, to keep the hot loop free
  // of per-field result objects.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). The plain run is
  // scanned without copying, then sliced once; only a stray CR (rare) makes
  // the scan resume for the rest of the field.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      let i = pos;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i++;
      }
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
        pos = i;
      }
      if (pos >= len) {
        fValue = value;
        fEnded = END;
        fAdded = added;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      // c === 13: a CR ends the field only as half of a CRLF.
      if (text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos += 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    for (;;) {
      // The plain run up to the next quote, CR or LF, sliced once.
      let i = pos;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 34 || c === 13 || c === 10) break;
        i++;
      }
      if (i > pos) {
        value += text.slice(pos, i);
        pos = i;
      }
      if (pos >= len) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (text.charCodeAt(pos + 1) === 34) {
          value += '"';
          pos += 2;
          continue;
        }
        pos += 1;
        break; // the closing quote
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        value += '\n';
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        continue;
      }
      // c === 10
      value += '\n';
      line += 1;
      pos += 1;
    }
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break (quote_junk, when anything was appended).
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const answers = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
