# Recorded demo footage: source and attribution

The bundled MP4 files are camera recordings distributed under their authors' licences. They are marked as recorded demonstration sources in Plantbot. They are not live site feeds, evidence of actual wrongdoing, or model-generated footage. The authoritative `media/manifest.json` records source identifiers, acquisition ranges, input hashes, exact transformations and output SHA-256 values.

## InspecSafe-V1

Author/licensor: **TetraBOT**. Dataset: [InspecSafe-V1](https://huggingface.co/datasets/Tetrabot2026/InspecSafe-V1), licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/), as declared in the [dataset card](https://huggingface.co/datasets/Tetrabot2026/InspecSafe-V1/blob/main/README.md).

The package pins dataset revision `f3cb7d3e7827c1afc1c5bfd0524257984bba46ab`. The [original test archive](https://huggingface.co/datasets/Tetrabot2026/InspecSafe-V1/resolve/f3cb7d3e7827c1afc1c5bfd0524257984bba46ab/test.tar.gz) was downloaded in full and has SHA-256 `818086e696f970e036bf6a76758e4fb851fa26f771fe4eac56f8dc073b44358d`.

| Bundled file | Original member basename, under `DATA_PATH/test/Other_modalities/<point>/` |
| --- | --- |
| `switchgear-inspection.mp4` | `power-Level04-Wheeled-000386-visible.mp4` |
| `substation-inspection.mp4` | `power-Level04-Wheeled-000419-visible.mp4` |
| `conveyor-inspection.mp4` | `coal_conveyor-Level04-SuspendedRail-000013-visible.mp4` |
| `process-pipework.mp4` | `oil_chemical-Level04-Wheeled-000312-visible.mp4` |
| `equipment-valve.mp4` | `metallurgy-Level04-Wheeled-000252-visible.mp4` |
| `substation-thermal.mp4` | `power-Level04-Wheeled-000419-infrared.mp4` |
| `conveyor-thermal.mp4` | `coal_conveyor-Level04-SuspendedRail-000013-infrared.mp4` |
| `valve-thermal.mp4` | `metallurgy-Level04-Wheeled-000252-infrared.mp4` |
| `instrument.mp4` | `coal_conveyor-Level04-SuspendedRail-000020-infrared.mp4` |

Attribution: **InspecSafe-V1, TetraBOT, CC BY 4.0. Source: the fixed dataset revision linked above.** Changes: eight display clips retain the complete continuous recording, resized to 1280 pixels wide, resampled to 15 fps, converted to H.264 Main without B frames and stripped of audio. `instrument.mp4` is an unchanged copy of the original 13.28-second IR MP4. Its input and output SHA-256 are `c42d70a1ebf97dc5964b87cb0d269492ae05bb2cad2798c3c2f156f67d6468d1`. No digits, thermal palette, objects or events were drawn into these recordings.

The IR videos originate from the dataset's infrared modality; they are not recoloured RGB. OCR reads the original camera's maximum-temperature overlay, not radiometric pixel values or a particular device's measured temperature. The selected OCR scene includes a warm person. A 33℃ example limit does not establish equipment overheating or a site safety threshold. These files are not optical gas imaging (OGI).

## MEVA

Author/licensor: **Kitware Inc. and the Intelligence Advanced Research Projects Activity (IARPA)**. Dataset: [Multiview Extended Video with Activities (MEVA)](https://mevadata.org/). The [original MEVA licence](https://mevadata.org/resources/MEVA-data-license.txt) specifies [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

| Bundled file | Original source and selected interval |
| --- | --- |
| `restricted-area.mp4` | [2018-05-18.14-30-00.14-35-00.admin.G329.r13.avi](https://mevadata-public-01.s3.amazonaws.com/drop-5-mevid/2018-05-18.14-30-00.14-35-00.admin.G329.r13.avi), 0–30 seconds |
| `campus-security.mp4` | [2018-03-13.17-10-03.17-15-03.school.G424.r13.avi](https://mevadata-public-01.s3.amazonaws.com/drops-123-r13/2018-03-13/17/2018-03-13.17-10-03.17-15-03.school.G424.r13.avi), 0–37 seconds |

Attribution: **MEVA, Kitware Inc. and IARPA, CC BY 4.0. Source: https://mevadata.org/.** Changes: continuous opening segments selected, resized to 1280 pixels wide, resampled to 15 fps, converted to H.264 Main without B frames, and stripped of audio. No rearranged actions, stabilisation, generated frames or fabricated detections. Exact encoder parameters and final hashes are in `media/manifest.json`.

Acquisition used bytes `0–16777215` of each official S3 AVI. The selected intervals decoded completely; the partial AVI files are not shipped. The manifest's `inputSha256` hashes those downloaded byte ranges, **not the complete original five-minute files**, which were not downloaded in full.

The recordings show actor activity at Muscatatuck Urban Training Center: a facility stairwell and a campus parking area. They are real camera footage from a security-training setting, not production-factory incidents. Demonstration regions and duration thresholds do not imply actual trespass or unlawful parking. No endorsement by the authors or participants is implied.

## Models and robot simulation

Actual RT-DETRv2/ByteTrack and PP-OCRv5/RapidOCR process the files. The manifest contains input descriptions and sample observations, not results injected into the platform. Model provenance and licences are separate: `integrations/vision/THIRD_PARTY.md`, `licenses/` and `models.lock.json` in source; `THIRD_PARTY.md`, `licenses/` and `models.lock.json` in the release. Missing or corrupt weights fail startup.

Native protocol simulation remains in the separate [plantbotsimulator repository](https://github.com/supcon-international/plantbotsimulator), fixed by `integrations/demo/pack.json` in source and `demo.pack.json` in the release. No robot movement simulation is added to Plantbot Server or its production vendor drivers. Retain these attributions, licence links and modification descriptions when redistributing the recordings.
