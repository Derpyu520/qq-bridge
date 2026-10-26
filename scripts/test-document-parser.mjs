// 文档解析回归：txt/md、PDF 文字层、DOCX、XLSX。
// 不依赖外部服务；PDF/DOCX 用最小合法文件构造。
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function makePdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function makeDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function makeXlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['姓名', '分数'], ['张三', 88]]), '成绩');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const h = await bridgeHarness();
let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`✅ ${name}`);
  else { failures += 1; console.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
try {
  h.setMode('reserved3');

  const txt = await h.parseDocumentBufferV2(Buffer.from('第一行\n第二行'), 'note.txt');
  check('txt 解析', txt.kind === 'txt' && txt.text.includes('第二行'), JSON.stringify(txt));

  const md = await h.parseDocumentBufferV2(Buffer.from('# 标题\n\n正文'), 'note.md');
  check('md 解析', md.kind === 'md' && md.text.includes('正文'));

  const pdf = await h.parseDocumentBufferV2(makePdf('Hello PDF document'), 'sample.pdf');
  check('PDF 文字层解析', pdf.kind === 'pdf' && /Hello PDF document/.test(pdf.text) && pdf.pages >= 1, JSON.stringify(pdf));

  const docx = await h.parseDocumentBufferV2(await makeDocx('DOCX 文档内容'), 'sample.docx');
  check('DOCX 解析', docx.kind === 'docx' && docx.text.includes('DOCX 文档内容'), JSON.stringify(docx));

  const xlsx = await h.parseDocumentBufferV2(makeXlsx(), 'sample.xlsx');
  check('XLSX 解析', xlsx.kind === 'xlsx' && xlsx.text.includes('成绩') && xlsx.text.includes('张三'), JSON.stringify(xlsx));

  const temp = path.join(h.tempDir, 'document-fixture.txt');
  fs.writeFileSync(temp, 'chat file content');
  let disabled = false;
  try { await h.readDocumentFromMessageV2('group:456', '123'); } catch (error) { disabled = /未开启/.test(String(error.message)); }
  check('文档阅读默认关闭', disabled);

  h.cfg.socialV2.document.enabled = true;
  h.cfg.socialV2.document.allowHistory = false;
  let historyDenied = false;
  try { await h.readDocumentFromMessageV2('group:456', '123'); } catch (error) { historyDenied = /历史/.test(String(error.message)); }
  check('未授权历史文件被拒', historyDenied);
} finally {
  await h.close();
}
if (failures) { console.error(`\n${failures} 项失败`); process.exitCode = 1; } else console.log('\n全部通过');
