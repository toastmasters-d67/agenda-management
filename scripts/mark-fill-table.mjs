// Marks a template's agenda table {{填滿:mm}} (its alt-text title), for the
// Word template builders. When a meeting is downloaded, lib/wordFit.js shares
// that height out over the rows the meeting actually has, so the table reaches
// the bottom of the page whatever the number of speeches — as the web agenda
// does. The `docx` package cannot set a table's alt-text title, so it goes into
// the generated XML: on the innermost table containing `anchor` (text unique
// to that table, XML-escaped as it appears in document.xml).
import { createRequire } from 'node:module';

export function markFillTable(buf, anchor, mm) {
  const PizZip = createRequire(import.meta.url)('pizzip');
  const zip = new PizZip(buf);
  let xml = zip.file('word/document.xml').asText();
  const at = xml.indexOf(anchor);
  const start = at === -1 ? -1 : xml.lastIndexOf('<w:tbl>', at);
  const tblPrEnd = start === -1 ? -1 : xml.indexOf('</w:tblPr>', start);
  if (tblPrEnd === -1) throw new Error(`table with ${anchor} not found`);
  xml = `${xml.slice(0, tblPrEnd)}<w:tblCaption w:val="{{填滿:${mm}}}"/>${xml.slice(tblPrEnd)}`;
  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'nodebuffer' });
}
