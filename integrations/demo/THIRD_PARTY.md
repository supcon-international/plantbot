# Demo input provenance

The source photo is NASA's portrait of Eileen Collins, retrieved unchanged from
[scikit-image v0.25.2](https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/astronaut.png).
[The scikit-image documentation](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut)
identifies the NASA source and public-domain status. The repository stores that
original at `integrations/vision/tests/fixtures/astronaut.png`.

`make-media.py` creates the instrument graphics, textured background and captions.
Every frame explicitly says **DEMO INPUT**. The resulting two H.264 videos and
their source/asset SHA-256 values are committed in `media/`. Instrument values
are drawn inputs, never measured temperatures. The person is a photograph;
appearance/disappearance is a deterministic cut, not a person walking through
a real factory. No person endorsement is implied.

Real RT-DETRv2/ByteTrack and PP-OCRv5/RapidOCR process those files. Model licence
notices and exact weights are shipped separately in `THIRD_PARTY.md`, `licenses/`
and `models.lock.json` in the release. Missing or corrupt weights fail startup.
The media manifest describes expected inputs, not precomputed detections.

Native robot protocol simulation comes from the separate
[plantbotsimulator repository](https://github.com/supcon-international/plantbotsimulator),
fixed at `49ba9419ca245f5e060a597bb75bb9d12be9d919` in `pack.json`.
No robot simulation is added to Plantbot Server or its production vendor adapters.
