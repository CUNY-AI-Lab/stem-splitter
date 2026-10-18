# Locally bundled MPEG decoder

`mpg123-1.0.3.wasm` is the unmodified 99,479-byte Wasm payload extracted from
the locked `mpg123-decoder@1.0.3` npm package. SHA-256:
`f0e9e8848367320ccb757e4092f0d6809668cfe38f43139d47b447151d7dff6b`.
Reproduce it after the frozen adapter install with
`node scripts/extract-mp3-wasm.mjs` from `cloudflare/`. The script checks the
package version and binary digest and makes no network requests.

The JavaScript wrapper is Copyright 2021–2025 Ethan Halsall, published under
MIT. Its exact source is [wasm-audio-decoders 8f2428c](https://github.com/eshaz/wasm-audio-decoders/tree/8f2428c1cd96b54dab74836c8471ff75fe35cbee).
The underlying mpg123 source is [08247b3](https://github.com/madebr/mpg123/tree/08247b317163175e62035893af3ff9e71a5dfefd),
with its complete license notice in [mpg123-COPYING.txt](mpg123-COPYING.txt).
Upstream's Makefile and C wrapper provide the corresponding source and rebuild
recipe. The module is separately replaceable; the application imports it as a
Wasm module rather than modifying or embedding its binary in application code.

`audio-validator.ts` uses the pinned main-thread module entry and module
injection hook. The normal package entry also constructs browser Worker
helpers, unavailable in workerd. There is no runtime compilation, network
decoder fetch, browser-supplied validation, external service, or inference.
The fixed Wasm heap is 16,973,824 bytes and refuses heap growth. Shared
validation admits at most 24 MiB compressed input and 900.1 seconds, decodes
4 KiB chunks, checks finite PCM, and drops each PCM chunk immediately.

mpg123 intentionally conceals some damaged frames. Therefore the application
also checks Layer III side information before decoding. A demonstrated corrupt
fixture has legal frame headers but an impossible initial reservoir and
`big_values=511` (maximum 288); framing and tolerant PCM output alone accept it,
while the combined validator rejects it. This is bounded decode validation,
not proof against every possible bit corruption or a judgment of sound quality.
Legitimate silent stems remain acceptable.

## MP3 encoding

Adaptive output uses `wasm-media-encoders@0.7.0` with the unmodified native LAME
module `lame-0.7.0.wasm` (SHA-256
`85e81719250b9a667b1258143f689dda70e3e57a7e7c29ab0b4cef65c8f6eb9a`).
`node scripts/extract-encoder-wasm.mjs` reproduces the binary from the frozen
adapter install and rejects a mismatched version or digest. `mp3-encoder.ts`
passes the statically compiled module to the package's module injection API;
there is no runtime compilation, code download, or browser Worker.

The wrapper is MIT (notice: `wasm-media-encoders-LICENSE.txt`). Corresponding
source and reproducible build instructions are in
[wasm-media-encoders v0.7.0](https://github.com/arseneyr/wasm-media-encoders/tree/v0.7.0).
Its LAME submodule is [98db548](https://github.com/arseneyr/lame/tree/98db548e8e851defbba3184125ce10725355c332),
LGPL-2.0-or-later (`lame-COPYING.txt`). The binary is separately replaceable.
Both the native encoder and each decoder reserve about 16 MiB. The durable
output queue runs one stage at a time, uses a 5 MiB multipart buffer, and never
holds an entire long output beside the five-decoder remainder. Output validation
runs in its own stage. All displayed tracks use the same encoder, sample rate,
192 kbps bitrate, and global gain to preserve relative levels and encoder delay.
