/**
 * Minimal RFC 4180 CSV reader.
 *
 * Handles quoted fields, escaped quotes (`""`), embedded commas and newlines,
 * and both LF and CRLF line endings. It is deliberately dependency free and
 * only ever runs against the stock sheet we ship with the app.
 */

export function parseCsv(input: string): string[][] {
  // Strip a UTF-8 BOM so the first header cell isn't polluted.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };

  const endRow = () => {
    endField();
    // Skip blank lines (a single empty field and nothing else).
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\n") {
      endRow();
    } else if (char === "\r") {
      // Consume CRLF as one line break; a lone CR is treated the same way.
      if (text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  // Flush whatever is left when the file does not end with a newline.
  if (field !== "" || row.length > 0) endRow();

  return rows;
}
