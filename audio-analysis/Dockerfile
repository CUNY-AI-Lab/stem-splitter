# Build from the repository root:
#   docker build -f audio-analysis/Dockerfile .

# Multi-architecture OCI index digests were resolved for these exact tags on
# 2026-08-09. The FFmpeg tarball checksum below was captured only after its
# official ffmpeg-devel.asc signature verified with release key fingerprint
# FCF986EA15E6E293A5644F10B4322F04D67658D8.
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS ffmpeg-build

ARG FFMPEG_VERSION=8.0.3
ARG FFMPEG_SHA256=6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818
ARG MAKE_JOBS=2

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl --fail --location --proto '=https' --tlsv1.2 \
      --output ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum --check --strict \
  && tar --extract --file ffmpeg.tar.xz \
  && cd "ffmpeg-${FFMPEG_VERSION}" \
  && ./configure \
      --prefix=/opt/ffmpeg \
      --disable-autodetect \
      --disable-avdevice \
      --disable-bsfs \
      --disable-debug \
      --disable-decoders \
      --disable-demuxers \
      --disable-doc \
      --disable-encoders \
      --disable-filters \
      --disable-ffplay \
      --disable-hwaccels \
      --disable-iconv \
      --disable-indevs \
      --disable-muxers \
      --disable-network \
      --disable-outdevs \
      --disable-parsers \
      --disable-protocols \
      --disable-shared \
      --disable-swscale \
      --disable-x86asm \
      --enable-decoder=aac,adpcm_ima_wav,adpcm_ms,alac,flac,mp3,mp3float,opus,vorbis,pcm_alaw,pcm_f32be,pcm_f32le,pcm_f64be,pcm_f64le,pcm_mulaw,pcm_s8,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_s64be,pcm_s64le,pcm_u8,pcm_u16be,pcm_u16le,pcm_u24be,pcm_u24le,pcm_u32be,pcm_u32le \
      --enable-demuxer=aiff,flac,mov,mp3,ogg,wav \
      --enable-encoder=pcm_f32le \
      --enable-filter=aresample \
      --enable-muxer=pcm_f32le \
      --enable-parser=aac,flac,mpegaudio,opus,vorbis \
      --enable-protocol=file,pipe \
      --enable-small \
      --enable-static \
  && make -j"${MAKE_JOBS}" \
  && make install \
  && /opt/ffmpeg/bin/ffmpeg -version | head -1 | grep -F "ffmpeg version ${FFMPEG_VERSION}" \
  && /opt/ffmpeg/bin/ffprobe -version | head -1 | grep -F "ffprobe version ${FFMPEG_VERSION}"

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

LABEL org.opencontainers.image.title="STEM Splitter audio analysis" \
      org.opencontainers.image.description="Bounded private Auto routing analysis service" \
      org.opencontainers.image.source="https://github.com/CUNY-AI-Lab/stem-splitter"

WORKDIR /app
COPY --from=ffmpeg-build /opt/ffmpeg /opt/ffmpeg
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node audio-analysis/app.ts audio-analysis/classifier.ts audio-analysis/config.ts ./audio-analysis/
COPY --chown=node:node audio-analysis/decoder.ts audio-analysis/process.ts audio-analysis/request.ts ./audio-analysis/
COPY --chown=node:node audio-analysis/server.ts audio-analysis/source.ts ./audio-analysis/
COPY --chown=node:node public/autosplit.js ./public/autosplit.js
COPY --chown=node:node src/analysis/types.ts ./src/analysis/types.ts

ENV NODE_ENV=production \
    PATH="/opt/ffmpeg/bin:${PATH}" \
    AUDIO_ANALYSIS_EXPECTED_FFMPEG_VERSION=8.0.3

USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--max-old-space-size=256", "--import", "tsx", "audio-analysis/server.ts"]
