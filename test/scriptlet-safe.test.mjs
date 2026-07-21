import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptletLooksObfuscated } from '../scripts/lib/scriptlet-safe.mjs';

test('should allow normal set-constant scriptlet', () => {
  assert.equal(
    scriptletLooksObfuscated({ name: 'set-constant', args: ['canRunAds', 'true'] }),
    false,
  );
});

test('should flag scriptlet args that call atob (CWS Red Titanium offender)', () => {
  // zefoy.com rpnt payload from ubo-filters — rejection email cited this exact pattern.
  const args = [
    'script',
    '({});',
    '({}); function imgOnError(){$(".ua-check").html(window.atob("PGRpdiBjbGFzcz0idGV4dC1kYW5nZXIgZm9udC13ZWlnaHQtYm9sZCBoNSBtdC0xIj5DYXB0Y2hhIGltYWdlIGZhaWxlZCB0byBsb2FkLjxicj48YSBvbmNsaWNrPSJsb2NhdGlvbi5yZWxvYWQoKSIgc3R5bGU9ImNvbG9yOiM2MjcwZGE7Y3Vyc29yOnBvaW50ZXIiIGNsYXNzPSJ0ZXh0LWRlY29yYXRpb25lLW5vbmUiPlBsZWFzZSByZWZyZXNoIHRoZSBwYWdlLiA8aSBjbGFzcz0iZmEgZmEtcmVmcmVzaCI+PC9pPjwvYT48L2Rpdj4="))}',
  ];
  assert.equal(scriptletLooksObfuscated({ name: 'rpnt', args }), true);
});

test('should flag acs scriptlets that target atob / new Function(atob', () => {
  assert.equal(
    scriptletLooksObfuscated({ name: 'acs', args: ['atob', 'new Function(atob('] }),
    true,
  );
});

test('should flag long base64 blobs even without atob(', () => {
  const b64 = 'A'.repeat(80) + '==';
  assert.equal(scriptletLooksObfuscated({ name: 'rpnt', args: ['script', b64] }), true);
});
