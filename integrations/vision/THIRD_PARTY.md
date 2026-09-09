# Vision components and model provenance

Plantbot distributes the following unchanged runtime components and converted pretrained models. Their licenses remain with the respective authors. License texts are included in `licenses/`; Python dependency distributions retain their own license files in the image. Model hashes, immutable RT-DETR revision and versioned RapidOCR URLs are recorded in `models.lock.json`.

| Component | Version / source | License |
| --- | --- | --- |
| ONNX Runtime | 1.29.0, https://github.com/microsoft/onnxruntime | MIT |
| RT-DETRv2 R18vd | https://github.com/lyuwenyu/RT-DETR; ONNX conversion: https://huggingface.co/onnx-community/rtdetr_v2_r18vd-ONNX/tree/936f90b6a476c6da4dfe053fc521af55285976ba | Apache-2.0 |
| trackers (ByteTrack implementation) | 2.6.0, https://github.com/roboflow/trackers | Apache-2.0 |
| supervision | 0.30.2, https://github.com/roboflow/supervision | MIT |
| RapidOCR | 3.9.2, https://github.com/RapidAI/RapidOCR | Apache-2.0 |
| PP-OCRv5 mobile detector/recognizer and PP-OCRv4 orientation classifier | PaddleOCR pretrained models converted by RapidAI; https://www.modelscope.cn/models/RapidAI/RapidOCR/tree/v3.9.2/onnx | Apache-2.0 |
| OpenCV Python | 5.0.0.93, https://github.com/opencv/opencv-python | Apache-2.0 (OpenCV); MIT (Python packaging) |

These model files are not trained or fine-tuned by Plantbot. People and vehicles use COCO classes `person`, `car`, `bus`, `truck`. OCR uses Chinese/English/numeric recognition and is not a general sensor-measurement model. Site performance must be evaluated against representative footage.

Recorded demonstration inputs come from InspecSafe-V1 (TetraBOT) and MEVA (Kitware Inc. and IARPA), both under CC BY 4.0. Source files, acquisition ranges and transformations are recorded in `integrations/demo/media/manifest.json`; attribution is in `integrations/demo/THIRD_PARTY.md` (`DEMO_SOURCES.md` in the Demo release). Test fixture details are in `tests/fixtures/README.md`. Footage licensing is separate from model licensing. OCR reads the original thermal-camera display text; it does not measure temperature from image colours or establish equipment overheating.
