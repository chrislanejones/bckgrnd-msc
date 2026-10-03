/**
 * Globals the audio thread does not have.
 *
 * `AudioWorkletGlobalScope` is a deliberately small realm: no `TextDecoder`, no
 * `TextEncoder`, no `crypto`. But wasm-bindgen's generated glue constructs a
 * `TextEncoder` and a `TextDecoder` at **module scope** (it caches them for the
 * string-marshalling paths), so a missing one throws while the module is still
 * evaluating.
 *
 * The symptom is baffling if you go looking for it: the worklet module appears to
 * load fine, `addModule` resolves, and then constructing the node fails with
 * "the node name 'bckgrnd-msc-engine' is not defined" — because the throw happened
 * before `registerProcessor` ran, and the worklet console is not visible from the
 * page. Verified against Chrome: `TextDecoder` and `TextEncoder` both throw in a
 * worklet; `FinalizationRegistry`, `Symbol.dispose` and typed arrays are present.
 *
 * This file is prepended to the worklet bundle as a raw banner (see
 * `scripts/build-worklet.mjs`), so these assignments run before any bundled code.
 * Each is guarded, so a browser that does provide the real implementation keeps it.
 *
 * The UTF-8 codec below is complete for valid input, including surrogate pairs,
 * which matters because track JSON is the payload being marshalled.
 */

/* eslint-disable no-restricted-globals */

(function installWorkletGlobals(scope) {
  if (typeof scope.TextEncoder === 'undefined') {
    /** UTF-8 encode a JS string, handling surrogate pairs. */
    function encodeUtf8(input) {
      const bytes = [];
      for (let i = 0; i < input.length; i += 1) {
        let cp = input.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < input.length) {
          const low = input.charCodeAt(i + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
            i += 1;
          }
        }
        if (cp < 0x80) {
          bytes.push(cp);
        } else if (cp < 0x800) {
          bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
          bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
          bytes.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f),
          );
        }
      }
      return bytes;
    }

    class TextEncoderPolyfill {
      get encoding() {
        return 'utf-8';
      }

      encode(input = '') {
        return new Uint8Array(encodeUtf8(String(input)));
      }

      /**
       * Encode into a caller-owned buffer, as the real API does.
       *
       * `read` counts UTF-16 code units consumed, which is what wasm-bindgen uses to
       * decide whether its buffer needs to grow.
       */
      encodeInto(source, destination) {
        const input = String(source);
        const bytes = encodeUtf8(input);
        const written = Math.min(bytes.length, destination.length);
        for (let i = 0; i < written; i += 1) {
          destination[i] = bytes[i];
        }
        return { read: input.length, written };
      }
    }

    scope.TextEncoder = TextEncoderPolyfill;
  }

  if (typeof scope.TextDecoder === 'undefined') {
    function decodeUtf8(bytes) {
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i];
        i += 1;
        let cp;
        if (b0 < 0x80) {
          cp = b0;
        } else if (b0 < 0xe0) {
          cp = ((b0 & 0x1f) << 6) | (bytes[i] & 0x3f);
          i += 1;
        } else if (b0 < 0xf0) {
          cp =
            ((b0 & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f);
          i += 2;
        } else {
          cp =
            ((b0 & 0x07) << 18) |
            ((bytes[i] & 0x3f) << 12) |
            ((bytes[i + 1] & 0x3f) << 6) |
            (bytes[i + 2] & 0x3f);
          i += 3;
        }
        if (cp > 0xffff) {
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
          out += String.fromCharCode(cp);
        }
      }
      return out;
    }

    class TextDecoderPolyfill {
      constructor(_encoding = 'utf-8') {
        if (_encoding && String(_encoding).toLowerCase().replace(/-/g, '') !== 'utf8') {
          throw new RangeError(`unsupported encoding: ${_encoding}`);
        }
      }

      get encoding() {
        return 'utf-8';
      }

      decode(input) {
        if (input == null) return '';
        return decodeUtf8(input instanceof Uint8Array ? input : new Uint8Array(input));
      }
    }

    scope.TextDecoder = TextDecoderPolyfill;
  }

  // `crypto.getRandomValues` is absent too, and wasm-bindgen's random shim reaches
  // for it when initialising. Nothing in this engine needs cryptographically strong
  // randomness — it is noise for percussion and the backspin buffer — so a
  // `Math.random`-backed fill is the right trade rather than shipping no source.
  if (typeof scope.crypto === 'undefined') {
    scope.crypto = {};
  }
  if (typeof scope.crypto.getRandomValues !== 'function') {
    scope.crypto.getRandomValues = function getRandomValues(target) {
      const view = target instanceof Uint8Array ? target : new Uint8Array(target.buffer ?? target);
      for (let i = 0; i < view.length; i += 1) {
        view[i] = Math.floor(Math.random() * 256);
      }
      return view;
    };
  }
})(globalThis);