// core/passgen.js — generating a repository password worth trusting.
//
// A restic repository password is UNRECOVERABLE. There is no reset, no escrow and
// no support desk: lose it and every snapshot in that repository is permanently
// unreadable. So the two jobs here are equally important — make a strong password
// easy to get, and make it obvious it has to be stored somewhere before the dialog
// closes.
//
// Two decisions worth stating, because both look like over-caution until the day
// they matter:
//
//  1. crypto.getRandomValues, never Math.random. Math.random is seeded from
//     observable state and is not a CSPRNG; a password from it is a password an
//     attacker can narrow down. If a secure source is absent this module REFUSES
//     to generate rather than quietly falling back — a weak password the user
//     believes is strong is worse than no button.
//
//  2. The default alphabet is letters and digits only, with the ambiguous glyphs
//     removed. Not because symbols are bad entropy — they are fine — but because
//     the one time you are guaranteed to type this password by hand is during a
//     bare-metal recovery, at a rescue console, on a keyboard layout you did not
//     choose. '@' and '#' move between layouts; 'l' and '1' and 'O' and '0' get
//     misread off a screen or a sticky note. Both cost real length instead.
'use strict';
(function (root) {
    const E = root.HangarErrors ||
        (typeof require === 'function' ? require('./errors.js') : null);

    // 0/O and 1/l/I removed: they are the pairs people misread and mistype.
    const SAFE = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    // Offered for anyone who will only ever paste it from a password manager.
    const FULL = SAFE + '!#$%&*+-=?@^_';

    const ALPHABETS = {
        safe: { id: 'safe', label: 'Letters and digits', chars: SAFE,
            help: 'Types cleanly on any keyboard layout, including a rescue console.' },
        full: { id: 'full', label: 'Letters, digits and symbols', chars: FULL,
            help: 'Slightly shorter for the same strength, but awkward to type by hand.' }
    };

    const DEFAULT_ALPHABET = 'safe';
    const DEFAULT_LENGTH = 24;
    const MIN_LENGTH = 12;
    const MAX_LENGTH = 128;
    const GROUP_SIZE = 4;

    function fail(message, detail) {
        if (E && typeof E.create === 'function') return E.create('GENERIC', message, detail || null);
        const e = new Error(message);
        e.name = 'HangarError';
        e.kind = 'GENERIC';
        return e;
    }

    function alphabetFor(id) {
        return Object.prototype.hasOwnProperty.call(ALPHABETS, id)
            ? ALPHABETS[id] : ALPHABETS[DEFAULT_ALPHABET];
    }

    function alphabets() {
        return Object.keys(ALPHABETS).map(function (k) { return ALPHABETS[k]; });
    }

    // ---- entropy -----------------------------------------------------------

    // log2(alphabet ^ length). The honest measure of a RANDOM password; it says
    // nothing about a password a human chose, which is why this module never
    // scores user-typed input — a meter that calls "Summer2024!" strong is worse
    // than no meter.
    function entropyBits(length, alphabetSize) {
        const n = Number(length);
        const a = Number(alphabetSize);
        if (!isFinite(n) || !isFinite(a) || n <= 0 || a <= 1) return 0;
        return Math.round(n * (Math.log(a) / Math.log(2)));
    }

    function bitsFor(opts) {
        const o = opts || {};
        const alpha = alphabetFor(o.alphabet || DEFAULT_ALPHABET);
        return entropyBits(o.length || DEFAULT_LENGTH, alpha.chars.length);
    }

    // Deliberately coarse. The thresholds are about what an offline attacker with
    // real hardware can do, not about a colour scale: below 60 bits is reachable,
    // 128 is not going to be brute-forced by anyone.
    function strengthLabel(bits) {
        const b = Number(bits) || 0;
        if (b < 60) return { id: 'weak', label: 'Weak', tone: 'danger' };
        if (b < 90) return { id: 'fair', label: 'Fair', tone: 'warning' };
        if (b < 128) return { id: 'strong', label: 'Strong', tone: 'success' };
        return { id: 'excellent', label: 'Excellent', tone: 'success' };
    }

    // ---- randomness --------------------------------------------------------

    function secureSource() {
        const c = (typeof root !== 'undefined' && root.crypto) ||
            (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
        return (c && typeof c.getRandomValues === 'function') ? c : null;
    }

    function hasSecureRandom() { return secureSource() !== null; }

    // Rejection sampling. The obvious `byte % alphabet.length` is biased whenever
    // 256 is not a multiple of the alphabet size — with 56 characters the first 32
    // would appear noticeably more often than the rest, quietly costing entropy in
    // a way nothing downstream would reveal. Discarding the short tail is cheap and
    // exact.
    // Widens automatically: an alphabet fits in a byte, but the 2048-word list does
    // not. Picking the narrowest type that covers the range keeps the rejection
    // rate low — 8 bits for a 57-character alphabet, 16 for the word list.
    function randomIndices(count, range) {
        const crypto = secureSource();
        if (!crypto) throw fail(
            'This browser has no secure random source, so hangar will not generate a password. ' +
            'Use a password manager instead.');
        const n = Math.floor(Number(range));
        if (!isFinite(n) || n < 2 || n > 65536) throw fail('Unsupported range.', { range: range });

        const wide = n > 256;
        const span = wide ? 65536 : 256;
        const limit = span - (span % n);         // largest multiple of n that fits
        const out = [];
        const size = Math.max(Math.floor(count) * 2, 32);
        const buf = wide ? new Uint16Array(size) : new Uint8Array(size);

        let guard = 0;
        while (out.length < count) {
            // Bounded so a pathological source cannot spin here forever. The
            // rejection rate is at most (span - limit)/span, which is under 2% for
            // every range this module actually uses.
            if (++guard > 1000) throw fail('Could not gather enough randomness.');
            crypto.getRandomValues(buf);
            for (let i = 0; i < buf.length && out.length < count; i++) {
                if (buf[i] < limit) out.push(buf[i] % n);
            }
        }
        return out;
    }

    // ---- generation --------------------------------------------------------

    function normalizeLength(value) {
        const n = Math.floor(Number(value));
        if (!isFinite(n)) return DEFAULT_LENGTH;
        return Math.min(Math.max(n, MIN_LENGTH), MAX_LENGTH);
    }

    // -> the raw password. Never grouped: the groups are a display aid, and a
    // password with dashes baked in would be a different, weaker password than the
    // one whose entropy was advertised.
    function generate(opts) {
        const o = opts || {};
        const alpha = alphabetFor(o.alphabet || DEFAULT_ALPHABET);
        const length = normalizeLength(o.length === undefined ? DEFAULT_LENGTH : o.length);
        const idx = randomIndices(length, alpha.chars.length);
        let out = '';
        for (let i = 0; i < idx.length; i++) out += alpha.chars.charAt(idx[i]);
        return out;
    }

    // Display only. Read back over a phone or copied off a screen, an unbroken
    // 24-character run is where transcription errors come from.
    function group(text, size) {
        const s = text === null || text === undefined ? '' : String(text);
        const n = Math.max(1, Math.floor(Number(size) || GROUP_SIZE));
        const parts = [];
        for (let i = 0; i < s.length; i += n) parts.push(s.slice(i, i + n));
        return parts.join(' ');
    }

    // What the dialog shows alongside a generated password, so the user is told
    // the strength and the consequence in the same breath.
    function describe(opts) {
        const o = opts || {};
        const alpha = alphabetFor(o.alphabet || DEFAULT_ALPHABET);
        const length = normalizeLength(o.length === undefined ? DEFAULT_LENGTH : o.length);
        const bits = entropyBits(length, alpha.chars.length);
        const strength = strengthLabel(bits);
        return {
            length: length,
            alphabet: alpha.id,
            alphabetSize: alpha.chars.length,
            bits: bits,
            strength: strength.id,
            label: strength.label,
            tone: strength.tone,
            summary: length + ' characters, about ' + bits + ' bits of entropy (' +
                strength.label.toLowerCase() + ').'
        };
    }

    // ---- memorable passphrases --------------------------------------------
    //
    // "apple-2235-kiwi-1429" — words and digit groups joined by hyphens. The point
    // is not novelty: it is that the one time you are guaranteed to type this
    // password by hand is during a bare-metal recovery, at a rescue console, and a
    // word is far easier to type correctly there than a run of random symbols.
    //
    // The cost is real and is stated rather than hidden. A word from this list is
    // 11 bits; a four-digit group is 13.3. So the shape people ask for —
    // word-digits-word-digits — is only ~49 bits, which is WEAK for something
    // protecting a backup that cannot be re-created. describe() reports that
    // honestly, and the default is long enough to be genuinely strong.

    const Wordlist = root.HangarWordlist ||
        (typeof require === 'function' ? require('./wordlist.js') : null);

    const BITS_PER_WORD = 11;                 // log2(2048); see js/core/wordlist.js
    const BITS_PER_DIGIT = Math.log(10) / Math.log(2);
    const DEFAULT_SEPARATOR = '-';
    const DEFAULT_DIGITS = 4;

    // Named shapes, with their real strength in the label so the trade-off is
    // visible at the point of choosing rather than discovered later.
    // Every label states the real strength, so the trade-off is visible at the
    // point of choosing rather than discovered from a meter afterwards.
    const PATTERNS = [
        { id: 'short', label: 'Two words, two numbers — weak', words: 2, groups: 2, digits: 4,
            example: 'apple-2235-kiwi-1429' },
        { id: 'balanced', label: 'Three words, three numbers — fair', words: 3, groups: 3, digits: 4,
            example: 'apple-2235-kiwi-1429-otter-8831' },
        { id: 'strong', label: 'Four words, four numbers — strong', words: 4, groups: 4, digits: 4,
            example: 'apple-2235-kiwi-1429-otter-8831-maple-2047' },
        { id: 'longer', label: 'Six words, six numbers — excellent', words: 6, groups: 6, digits: 4,
            example: 'apple-2235-kiwi-1429-otter-8831-maple-2047-river-5518-cedar-7390' },
        { id: 'longest', label: 'Eight words, eight numbers — excellent', words: 8, groups: 8, digits: 4,
            example: 'apple-2235-kiwi-1429-otter-8831-maple-2047-river-5518-cedar-7390-plum-6142-birch-9067' },
        // Twelve, not eight: eight words is 88 bits, which is only Fair. A
        // words-only option exists for maximum typeability, so it has to be long
        // enough to still be worth choosing.
        { id: 'words', label: 'Twelve words, no numbers — excellent', words: 12, groups: 0, digits: 4,
            example: 'apple-kiwi-otter-maple-river-cedar-plum-birch-stone-cloud-amber-flint' }
    ];

    // The default deliberately clears 128 bits — the point at which brute force
    // stops being a consideration at all. It is longer to read, but it is typed
    // once and then lives in a password manager; the day it is typed by hand is a
    // recovery, where words are exactly what you want.
    const DEFAULT_PATTERN = 'longer';

    function patternFor(id) {
        for (let i = 0; i < PATTERNS.length; i++) if (PATTERNS[i].id === id) return PATTERNS[i];
        return patternFor(DEFAULT_PATTERN) || PATTERNS[0];
    }

    function patterns() { return PATTERNS.slice(); }

    function passphraseBits(spec) {
        const s = spec || {};
        const words = Math.max(0, Math.floor(Number(s.words) || 0));
        const groups = Math.max(0, Math.floor(Number(s.groups) || 0));
        const digits = Math.max(1, Math.floor(Number(s.digits) || DEFAULT_DIGITS));
        return Math.round(words * BITS_PER_WORD + groups * digits * BITS_PER_DIGIT);
    }

    // Alternating word, number, word, number… then whatever is left over. Fixed
    // rather than shuffled: a predictable shape is easier to read back, and the
    // arrangement is not counted as entropy anyway, so randomising it would buy
    // nothing while making the password harder to dictate over a phone.
    function generatePassphrase(opts) {
        const o = opts || {};
        const spec = (o.words === undefined && o.groups === undefined)
            ? patternFor(o.pattern || DEFAULT_PATTERN) : o;
        const wordCount = Math.min(Math.max(Math.floor(Number(spec.words) || 0), 0), 16);
        const groupCount = Math.min(Math.max(Math.floor(Number(spec.groups) || 0), 0), 16);
        const digits = Math.min(Math.max(Math.floor(Number(spec.digits) || DEFAULT_DIGITS), 1), 8);
        const sep = o.separator === undefined ? DEFAULT_SEPARATOR : String(o.separator);

        if (!Wordlist || !Array.isArray(Wordlist.WORDS) || !Wordlist.WORDS.length)
            throw fail('The word list is unavailable, so hangar cannot build a memorable password.');
        if (wordCount + groupCount === 0)
            throw fail('A memorable password needs at least one word or one number group.');

        const words = [];
        if (wordCount) {
            const idx = randomIndices(wordCount, Wordlist.WORDS.length);
            for (let i = 0; i < idx.length; i++) words.push(Wordlist.WORDS[idx[i]]);
        }

        const numbers = [];
        for (let g = 0; g < groupCount; g++) {
            // Digit by digit from the same rejection-sampled source, so a group is
            // uniform across its whole range including leading zeros — "0417" has
            // to be as likely as "9417" or the advertised bits are a lie.
            const d = randomIndices(digits, 10);
            let s = '';
            for (let i = 0; i < d.length; i++) s += String(d[i]);
            numbers.push(s);
        }

        const parts = [];
        const n = Math.max(words.length, numbers.length);
        for (let i = 0; i < n; i++) {
            if (i < words.length) parts.push(words[i]);
            if (i < numbers.length) parts.push(numbers[i]);
        }
        return parts.join(sep);
    }

    function describePassphrase(opts) {
        const o = opts || {};
        const spec = (o.words === undefined && o.groups === undefined)
            ? patternFor(o.pattern || DEFAULT_PATTERN) : o;
        const bits = passphraseBits(spec);
        const strength = strengthLabel(bits);
        const words = Math.floor(Number(spec.words) || 0);
        const groups = Math.floor(Number(spec.groups) || 0);
        const bitsText = 'about ' + bits + ' bits of entropy (' + strength.label.toLowerCase() + ')';
        const shape = [
            words ? (words + (words === 1 ? ' word' : ' words')) : '',
            groups ? (groups + (groups === 1 ? ' number' : ' numbers')) : ''
        ].filter(Boolean).join(' and ');
        return {
            pattern: spec.id || 'custom',
            words: words,
            groups: groups,
            digits: Math.floor(Number(spec.digits) || DEFAULT_DIGITS),
            bits: bits,
            strength: strength.id,
            label: strength.label,
            tone: strength.tone,
            summary: shape + ', ' + bitsText + '.'
        };
    }

    const HangarPassgen = {
        ALPHABETS, DEFAULT_ALPHABET, DEFAULT_LENGTH, MIN_LENGTH, MAX_LENGTH, GROUP_SIZE,
        alphabetFor, alphabets, entropyBits, bitsFor, strengthLabel,
        hasSecureRandom, normalizeLength, generate, group, describe,
        // memorable
        PATTERNS, DEFAULT_PATTERN, BITS_PER_WORD, DEFAULT_SEPARATOR, DEFAULT_DIGITS,
        patterns, patternFor, passphraseBits, generatePassphrase, describePassphrase
    };
    root.HangarPassgen = HangarPassgen;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarPassgen;
})(typeof window !== 'undefined' ? window : globalThis);
