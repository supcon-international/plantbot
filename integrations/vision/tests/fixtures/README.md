`evidence.jpg` is an unaltered frame at 7 seconds from the bundled
`integrations/demo/media/restricted-area.mp4`. It is real MEVA security-training
footage of a person in a facility stairwell, not a factory incident or generated
scene. API tests use it only to check JPEG persistence and retrieval.

- Creator: Kitware Inc. and IARPA, Multiview Extended Video with Activities (MEVA).
- Original recording: `2018-05-18.14-30-00.14-35-00.admin.G329.r13.avi`.
- Source: https://mevadata-public-01.s3.amazonaws.com/drop-5-mevid/2018-05-18.14-30-00.14-35-00.admin.G329.r13.avi
- License: CC BY 4.0, https://mevadata.org/resources/MEVA-data-license.txt
- Changes: extracted a frame from the resized H.264 recording and encoded JPEG.

Inference tests decode the actual bundled person and IR instrument recordings;
`make_video.py OUTPUT [--source person|instrument]` copies one recording without
combining sources or drawing digits. The IR clip retains its original camera
temperature overlay; its attribution and full media provenance are recorded in
`integrations/demo/THIRD_PARTY.md` and `integrations/demo/media/manifest.json`.
