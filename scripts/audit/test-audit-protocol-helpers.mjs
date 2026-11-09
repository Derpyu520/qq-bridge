import assert from 'node:assert/strict';
import { findSticker, mergeStickerLibrary } from '../../src/qq/sticker-lib.js';
import { splitForQQ } from '../../src/text/md-to-plain.js';
import { formatForwardResponse } from '../../src/qq/forward.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`); }
}
test('a short ref cannot select an unrelated sticker URL before an exact id', () => {
  const entries = [{ id: 'other', url: 'https://example.invalid/a.png' }, { id: 'a', url: 'https://example.invalid/b.png' }];
  assert.equal(findSticker(entries, 'a')?.id, 'a');
  assert.equal(findSticker(entries, 'png'), null);
});
test('sticker URL equality ignores renewed query tokens without substring matching', () => {
  const entries = [{ id: 'a', url: 'https://example.invalid/a.png?token=old' }];
  assert.equal(findSticker(entries, 'https://example.invalid/a.png?token=new')?.id, 'a');
  assert.equal(findSticker(entries, 'https://evil.invalid/https://example.invalid/a.png?token=old'), null);
});
test('partial sticker refresh preserves learned records outside the fetched page', () => {
  const entries = [{ id: 'a', source: 'qq' }, { id: 'b', source: 'qq', localNote: 'learned', useCount: 7 }];
  const result = mergeStickerLibrary(entries, [{ id: 'a', desc: 'new' }], { complete: false });
  assert.equal(result.length, 2);
  assert.equal(result.find((entry) => entry.id === 'b').localNote, 'learned');
  assert.equal(mergeStickerLibrary(entries, [{ id: 'a' }]).length, 1);
});
test('QQ newline splitting respects the stated per-message limit', () => {
  const text = 'abc\ndef\nghi';
  const parts = splitForQQ(text, 3);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => part.length <= 3));
});
test('single-segment forwarded messages retain media and nested forward metadata', () => {
  const result = formatForwardResponse({ messages: [
    { message: { type: 'image', data: { url: 'https://example.invalid/image.png' } } },
    { content: { type: 'forward', data: { id: 'nested-id' } } },
  ] });
  assert.equal(result.messages[0].media.length, 1);
  assert.deepEqual(result.messages[1].nestedForwardIds, ['nested-id']);
});
process.exitCode = failed ? 1 : 0;
