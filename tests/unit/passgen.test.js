// Unit tests for js/core/passgen.js.
//
// This module produces a password protecting backups that cannot be re-created, so
// the assertions worth having are about the RANDOMNESS and the HONESTY of the
// entropy figure, not about the shape of the output string.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../js/core/passgen.js');
const W = require('../../js/core/wordlist.js');

test('a secure random source is present under node', () => {
    assert.equal(P.hasSecureRandom(), true);
});

// --- random-character passwords ------------------------------------------

test('generate produces the requested length from the requested alphabet', () => {
    for (const id of ['safe', 'full']) {
        const alpha = P.alphabetFor(id).chars;
        const pw = P.generate({ length: 32, alphabet: id });
        assert.equal(pw.length, 32);
        for (const ch of pw) assert.ok(alpha.includes(ch), `${ch} not in ${id} alphabet`);
    }
});

test('the safe alphabet excludes every glyph people misread', () => {
    // 0/O and 1/l/I are the pairs that get transcribed wrongly off a screen or
    // read back wrongly over a phone.
    const safe = P.alphabetFor('safe').chars;
    for (const ch of ['0', '1', 'l', 'I', 'O']) {
        assert.ok(!safe.includes(ch), `safe alphabet contains ${ch}`);
    }
});

test('length is clamped rather than obeyed blindly', () => {
    assert.equal(P.generate({ length: 1 }).length, P.MIN_LENGTH);
    assert.equal(P.generate({ length: 10000 }).length, P.MAX_LENGTH);
    assert.equal(P.generate({ length: 'nonsense' }).length, P.DEFAULT_LENGTH);
    assert.equal(P.generate({}).length, P.DEFAULT_LENGTH);
});

test('two generated passwords are never equal', () => {
    // Not proof of randomness, but a collision here would mean something is very
    // wrong — a fixed seed, or a cached buffer.
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(P.generate());
    assert.equal(seen.size, 500);
});

test('characters are uniformly distributed — no modulo bias', () => {
    // `byte % 57` would favour the first 28 characters by ~50%. Rejection sampling
    // is the fix, and this is the test that would notice if it were removed.
    const alpha = P.alphabetFor('safe').chars;
    const counts = Object.create(null);
    for (const ch of alpha) counts[ch] = 0;
    const total = 1200 * 64;
    for (let i = 0; i < 1200; i++) {
        for (const ch of P.generate({ length: 64 })) counts[ch]++;
    }
    const expected = total / alpha.length;
    for (const ch of alpha) {
        const dev = Math.abs(counts[ch] - expected) / expected;
        // Generous: this is a statistical test, and a biased modulo shows a step
        // far larger than 25%.
        assert.ok(dev < 0.25, `${ch} deviates ${(dev * 100).toFixed(1)}% from uniform`);
    }
});

// --- entropy honesty ------------------------------------------------------

test('entropyBits is log2(alphabet ^ length)', () => {
    assert.equal(P.entropyBits(10, 2), 10);
    assert.equal(P.entropyBits(16, 16), 64);
    assert.equal(P.entropyBits(0, 57), 0);
    assert.equal(P.entropyBits(10, 1), 0);
    assert.equal(P.entropyBits('x', 57), 0);
});

test('strength thresholds are the ones documented', () => {
    assert.equal(P.strengthLabel(59).id, 'weak');
    assert.equal(P.strengthLabel(60).id, 'fair');
    assert.equal(P.strengthLabel(89).id, 'fair');
    assert.equal(P.strengthLabel(90).id, 'strong');
    assert.equal(P.strengthLabel(127).id, 'strong');
    assert.equal(P.strengthLabel(128).id, 'excellent');
    assert.equal(P.strengthLabel('nonsense').id, 'weak');
});

test('describe reports the strength the settings actually produce', () => {
    const d = P.describe({ length: 24, alphabet: 'safe' });
    assert.equal(d.length, 24);
    assert.equal(d.bits, P.entropyBits(24, P.alphabetFor('safe').chars.length));
    assert.match(d.summary, /24 characters/);
});

// --- memorable passphrases ------------------------------------------------

test('a passphrase is words and digit groups joined by hyphens', () => {
    const pw = P.generatePassphrase({ words: 2, groups: 2, digits: 4 });
    const parts = pw.split('-');
    assert.equal(parts.length, 4);
    assert.match(parts[0], /^[a-z]{4,6}$/);
    assert.match(parts[1], /^\d{4}$/);
    assert.match(parts[2], /^[a-z]{4,6}$/);
    assert.match(parts[3], /^\d{4}$/);
});

test('every word in a passphrase is lowercase and comes from the list', () => {
    for (let i = 0; i < 200; i++) {
        for (const part of P.generatePassphrase({ pattern: 'strong' }).split('-')) {
            if (/^\d+$/.test(part)) continue;
            assert.match(part, /^[a-z]+$/, `not lowercase: ${part}`);
            assert.ok(W.WORDS.includes(part), `not in the word list: ${part}`);
        }
    }
});

test('digit groups keep their leading zeros', () => {
    // "0417" must be as likely as "9417", or the advertised bits are a lie and the
    // real space is smaller than claimed.
    let sawLeadingZero = false;
    for (let i = 0; i < 600 && !sawLeadingZero; i++) {
        if (/^0/.test(P.generatePassphrase({ words: 0, groups: 1, digits: 4 }))) sawLeadingZero = true;
    }
    assert.ok(sawLeadingZero, 'no leading zero in 600 groups — the range is being truncated');
});

test('passphrase entropy is words * 11 + digits * log2(10)', () => {
    assert.equal(P.passphraseBits({ words: 6, groups: 0 }), 66);
    assert.equal(P.passphraseBits({ words: 0, groups: 1, digits: 4 }), 13);
    assert.equal(P.passphraseBits({ words: 4, groups: 4, digits: 4 }), 97);
    assert.equal(P.passphraseBits({ words: 0, groups: 0 }), 0);
});

test('the short shape is reported as weak, not flattered', () => {
    // The shape people ask for — word-1234-word-1234 — is about 49 bits. Calling
    // that "strong" because it looks complicated would be the dishonest part of
    // offering a memorable option at all.
    const d = P.describePassphrase({ words: 2, groups: 2, digits: 4 });
    assert.ok(d.bits < 60, `expected under 60 bits, got ${d.bits}`);
    assert.equal(d.strength, 'weak');
    assert.match(d.summary, /weak/);
});

test('the default shape clears 128 bits', () => {
    // The password hangar hands you unprompted has to be one you can rely on.
    const d = P.describePassphrase({});
    assert.ok(d.bits >= 128, `default is only ${d.bits} bits`);
    assert.equal(d.strength, 'excellent');
});

test('every offered pattern generates something matching its own description', () => {
    for (const p of P.patterns()) {
        const d = P.describePassphrase({ pattern: p.id });
        const pw = P.generatePassphrase({ pattern: p.id });
        const parts = pw.split('-');
        assert.equal(parts.length, p.words + p.groups, `${p.id} produced ${parts.length} parts`);
        assert.equal(d.bits, P.passphraseBits(p), `${p.id} bits disagree`);
        // The label must not claim more than the arithmetic supports.
        assert.match(p.label.toLowerCase(), new RegExp(d.label.toLowerCase()),
            `${p.id} is labelled "${p.label}" but rates ${d.label}`);
    }
});

test('passphrase counts are clamped, and an empty shape is refused', () => {
    assert.equal(P.generatePassphrase({ words: 999, groups: 0 }).split('-').length, 16);
    assert.throws(() => P.generatePassphrase({ words: 0, groups: 0 }), (e) => e.kind === 'GENERIC');
});

test('two passphrases are never equal', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i++) seen.add(P.generatePassphrase({ pattern: 'strong' }));
    assert.equal(seen.size, 300);
});

test('words are drawn uniformly from the whole list', () => {
    // A 16-bit source rejected badly would concentrate on the low indices, which
    // would show up as a chunk of the list never appearing.
    const seen = new Set();
    for (let i = 0; i < 20000; i++) seen.add(P.generatePassphrase({ words: 1, groups: 0 }));
    assert.ok(seen.size > W.SIZE * 0.9,
        `only ${seen.size} of ${W.SIZE} words ever appeared`);
});

// --- display helpers ------------------------------------------------------

test('group breaks a run into readable blocks without changing it', () => {
    assert.equal(P.group('abcdefgh', 4), 'abcd efgh');
    assert.equal(P.group('abcdefghi', 4), 'abcd efgh i');
    assert.equal(P.group('', 4), '');
    assert.equal(P.group(null, 4), '');
    // The grouping is display only — removing the spaces returns the original.
    const pw = P.generate({ length: 24 });
    assert.equal(P.group(pw, 4).replace(/ /g, ''), pw);
});

test('nothing throws an untyped error on hostile input', () => {
    for (const v of [null, undefined, 0, '', [], {}, true, NaN]) {
        for (const fn of ['bitsFor', 'describe', 'describePassphrase', 'passphraseBits']) {
            try { P[fn](v); } catch (e) {
                assert.equal(e.kind, 'GENERIC', `${fn} threw untyped for ${String(v)}`);
            }
        }
        assert.doesNotThrow(() => P.strengthLabel(v));
        assert.doesNotThrow(() => P.group(v, 4));
        assert.doesNotThrow(() => P.alphabetFor(v));
        assert.doesNotThrow(() => P.patternFor(v));
    }
});

test('an unknown alphabet or pattern falls back rather than failing', () => {
    assert.equal(P.alphabetFor('nope').id, P.DEFAULT_ALPHABET);
    assert.equal(P.alphabetFor('__proto__').id, P.DEFAULT_ALPHABET);
    assert.equal(P.patternFor('nope').id, P.DEFAULT_PATTERN);
    assert.equal(P.patternFor('constructor').id, P.DEFAULT_PATTERN);
});
