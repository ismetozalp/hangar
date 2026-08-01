// Unit tests for js/core/wordlist.js — the vocabulary behind memorable passwords.
//
// This list decides the search space of every password generated from it, so its
// properties are a security contract, not a style preference.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../../js/core/wordlist.js');

test('the list is exactly a power of two', () => {
    // 2048 = 11 bits per word exactly. A non-power-of-two would make the advertised
    // entropy an approximation, and rejection sampling slightly wasteful.
    assert.equal(W.SIZE, W.WORDS.length);
    assert.equal(W.SIZE & (W.SIZE - 1), 0, 'size is not a power of two: ' + W.SIZE);
    assert.equal(Math.log2(W.SIZE), 11);
});

test('every word is lowercase a-z only', () => {
    // No capitals, apostrophes or accents: the password is typed at a rescue
    // console on a keyboard layout nobody chose.
    const bad = W.WORDS.filter((w) => !/^[a-z]+$/.test(w));
    assert.deepEqual(bad, [], 'non-lowercase words: ' + bad.slice(0, 10).join(', '));
});

test('every word is 4 to 6 letters', () => {
    const bad = W.WORDS.filter((w) => w.length < 4 || w.length > 6);
    assert.deepEqual(bad, [], 'wrong length: ' + bad.slice(0, 10).join(', '));
});

test('there are no duplicates', () => {
    // A duplicate silently shrinks the search space below the advertised 11 bits.
    assert.equal(new Set(W.WORDS).size, W.SIZE);
});

test('the list is sorted, so a diff of this file is readable', () => {
    const sorted = W.WORDS.slice().sort();
    assert.deepEqual(W.WORDS, sorted);
});

test('the exported array is the module\'s own, and callers cannot shrink it', () => {
    const before = W.WORDS.length;
    const copy = W.WORDS.slice();
    copy.push('injected');
    assert.equal(W.WORDS.length, before);
});
