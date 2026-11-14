# dsh-plugin-voice-local

Local full-duplex voice for **DeepSeek Harness (DSH)**: pluggable TTS + streaming ASR run inside the host process (worker threads). No extra ports, no Python sidecar; local models by default, with an optional BreezeBlue streaming TTS API. Click the 🎙 in the composer to enter a fullscreen call UI: speak, replies stream as text and audio, and you can barge in at any time.

[![release](https://img.shields.io/github/v/release/god1sdfghjkl/dsh-plugin-voice-local?label=release)](https://github.com/god1sdfghjkl/dsh-plugin-voice-local/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![Desktop dark theme](https://testingcf.jsdelivr.net/gh/god1sdfghjkl/dsh-plugin-voice-local@2a70007/docs/images/desktop-dark.png)

## Features

- Fullscreen call overlay: auto-send after ~0.9s of silence, streaming subtitles + speech, barge-in.
- 7 background themes (4 dark / 3 light) with instant switching and persistence.
- Pluggable model registry for TTS and ASR; hot-swap without restarting the host.
- In-UI model downloader with progress, resumable `.part` files and SHA256 verification.
- Local-only: loopback + Origin checks; audio/text never leave the machine.
- Responsive UI for desktop, narrow windows and mobile browsers (safe areas, 44px+ touch targets).
- **Voiceprint (optional)**: CAM++ speaker verification, up to 5 profiles, 3-prompt randomized
  enrollment, threshold slider, per-profile tone/permission metadata. Mismatched voices are not
  submitted to the session. Embeddings stay local.
- **BreezeBlue streaming TTS (optional)**: `ttsProvider: "breeze"` streams 24 kHz PCM from
  `/v1/text-to-speech/{voice_id}/stream` into the existing playback queue. Configure via the
  in-overlay “Voice API” panel or `POST /voice-local/tts/api`; missing key falls back to local TTS.
- **DSH official ASR (optional)**: `asrProvider: "dsh"` uses the host `ctx.speechToText` service
  (official local SenseVoice or a cloud provider). It is whole-utterance final-only, so live
  partial captions are lost; the default `local` keeps streaming ASR.

## External voice APIs

BreezeBlue supports real streaming:

```http
POST https://api.breeze.blue/v1/text-to-speech/{voice_id}/stream?output_format=pcm
xi-api-key: brz_...
Content-Type: application/json

{"text":"hello","model_id":"breeze-tts-2","language_code":"en"}
```

It returns 24 kHz mono signed 16-bit PCM chunks; the plugin forwards each chunk over SSE as it
arrives. Configure the key/voice id locally:

```bash
curl -X POST http://127.0.0.1:57885/voice-local/tts/api \
  -H 'Content-Type: application/json' \
  -d '{"provider":"breeze","apiKey":"brz_...","voiceId":"voc_...","language":"zh"}'
```

The key is stored in `$DSH_HOME/voice-local/tts-api.json` (mode 0600) and is never returned by
the status route. The official DSH speech input is **final-only** (no partials, no synthesis);
with `asrProvider: "dsh"` the plugin transcribes one complete VAD utterance at a time.

## Requirements

- DSH `>=0.2.0 <0.3.0-0` (tested with desktop 0.2.2-rc.1)
- Node `>=20` (provided by the host)
- At least one TTS or streaming-ASR model (see [models](docs/models.md))

## Install

Install the tarball from the DSH plugin page, or download it from the
[GitHub Releases](https://github.com/god1sdfghjkl/dsh-plugin-voice-local/releases) until the npm package is out:

```bash
dsh plugin --profile <profile> add ./dsh-plugin-voice-local-0.9.9.tgz
```

Refresh the host page after installing because the client bundle is cached.

## Models

Models are **not** shipped with the npm package. Put them under
`$DSH_HOME/voice-local/models/{tts,asr/{streaming,final}}` (one subdirectory per model),
or point the legacy config/env vars (`ttsOnnx`, `asrStreamDir`, `sensevoiceDir`,
`VOICE_TTS_ONNX`, `VOICE_ASR_STREAM_DIR`, `VOICE_SENSEVOICE_DIR`) at existing directories.
Each model directory may contain a `model.json` describing engine, files and an optional
`download` manifest; a missing manifest falls back to file-name detection.

Model weights carry their own licenses (MeloTTS MIT, SenseVoice FunASR Model License,
sherpa-onnx models Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[docs/models.md](docs/models.md) before redistributing.

## Usage

- Click 🎙 to open the call overlay; `Esc` or — minimizes it without ending the call.
- Theme picker sits to the left of the model picker; the model picker switches TTS /
  streaming ASR / final ASR and offers downloads for missing models.
- Bottom controls: mute / hang up / interrupt; speaking while it reads also interrupts.
- The **声纹 (Voiceprint)** chip left of the theme picker opens the settings panel: master switch,
  profile cards, randomized 3-clip enrollment, noise rejection, threshold slider and policy options.

## Configuration

All keys live under `config` in `cordis.patch.yml`: `basePath`, `dataRoot`,
`ttsModelsDir`, `ttsModel`, `asrModelsDir`, `asrModel`, `asrFinalModel`, thread counts,
VAD thresholds, `llmTap`, segmentation lengths and speed, plus voiceprint keys
(`voiceprintEnabled`, `voiceprintThreshold`, `voiceprintModel`, `voiceprintDataFile`).
See the Chinese README for the full table and HTTP route list.

## Mobile / dsh-go

The web client is responsive and works in a mobile browser today (HTTPS or localhost is
required for microphone access). The open-source Android client
[dsh-go](https://github.com/ccch1mneyyy/dsh-go) runs DSH in its on-device Linux engine;
starting with 0.9.8 this package also ships a native `dshGo` manifest: long-press an
assistant reply to read it aloud through the phone's local TTS engine, while the official
dsh-go voice input bundle provides on-device SenseVoice ASR. See
[docs/dshgo-native-adapter.md](docs/dshgo-native-adapter.md).

## Development

```bash
npm test                      # model-dependent suites skip when models are absent
node test/client-smoke.mjs    # UI + themes with a fake DOM
node docs/preview/preview-overlay.mjs   # http://127.0.0.1:57999
```

## License

MIT for the plugin code. Third-party components and model licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).