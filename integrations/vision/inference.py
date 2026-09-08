"""Shared CPU ONNX models. No downloads, training framework, or vendor SDK here."""
import json
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort
import supervision as sv
from trackers import ByteTrackTracker
from rapidocr import RapidOCR, OCRVersion, ModelType
from setup_models import verify

ROOT = Path(__file__).resolve().parent
DETECTOR_VERSION = 'RT-DETRv2-r18vd/936f90b6'
OCR_VERSION = 'PP-OCRv5-mobile/RapidOCR-3.9.2'


class Models:
    def __init__(self, root=ROOT/'models', threads=2):
        verify(root)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.detector = ort.InferenceSession(str(root/'detector.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
        self.labels = json.loads((root/'detector-config.json').read_text())['id2label']
        self.ocr = RapidOCR(params={
            'Global.log_level': 'error', 'Global.text_score': .1,
            'Det.ocr_version': OCRVersion.PPOCRV5, 'Det.model_type': ModelType.MOBILE, 'Det.model_path': str(root/'ocr-det.onnx'),
            'Rec.ocr_version': OCRVersion.PPOCRV5, 'Rec.model_type': ModelType.MOBILE, 'Rec.model_path': str(root/'ocr-rec.onnx'),
            'Cls.model_path': str(root/'ocr-cls.onnx'),
            'EngineConfig.onnxruntime.intra_op_num_threads': threads,
            'EngineConfig.onnxruntime.inter_op_num_threads': 1,
        })

    def detect(self, frame):
        # Locked official processor: bilinear RGB 640x640, scale 1/255, no normalization/padding.
        rgb = cv2.cvtColor(cv2.resize(frame, (640, 640), interpolation=cv2.INTER_LINEAR), cv2.COLOR_BGR2RGB)
        tensor = rgb.transpose(2, 0, 1)[None].astype(np.float32)/255
        logits, boxes = self.detector.run(['logits', 'pred_boxes'], {'pixel_values': tensor})
        scores = 1/(1+np.exp(-np.clip(logits[0], -60, 60)))
        # Each query represents one object. Retain person/car/bus/truck for shared tracking.
        classes = scores.argmax(axis=1)
        confidence = scores[np.arange(len(classes)), classes]
        keep = np.isin(classes, [0, 2, 5, 7]) & (confidence >= .1)
        b = boxes[0, keep]
        xyxy = np.clip(np.concatenate((b[:, :2]-b[:, 2:]/2, b[:, :2]+b[:, 2:]/2), axis=1), 0, 1)
        h, w = frame.shape[:2]
        return sv.Detections(xyxy=xyxy*np.array([w, h, w, h]), confidence=confidence[keep], class_id=classes[keep])

    def read(self, frame, region):
        h, w = frame.shape[:2]
        polygon = np.array(region)*[w, h]
        x0, y0 = np.floor(polygon.min(axis=0)).astype(int)
        x1, y1 = np.ceil(polygon.max(axis=0)).astype(int)
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [polygon.astype(np.int32)], 255)
        image = frame.copy()
        image[mask == 0] = 255
        out = self.ocr(image[y0:max(y0+1, y1), x0:max(x0+1, x1)])
        texts = []
        if out.txts:
            for box, text, score in zip(out.boxes, out.txts, out.scores):
                a, b = np.min(box, axis=0)+[x0, y0], np.max(box, axis=0)+[x0, y0]
                texts.append(dict(text=text, score=float(score), box=np.clip([a[0]/w, a[1]/h, b[0]/w, b[1]/h], 0, 1).tolist()))
        return texts


class Tracking:
    def __init__(self):
        self.tracker = ByteTrackTracker(frame_rate=5, lost_track_buffer=90, track_activation_threshold=.5, high_conf_det_threshold=.5, minimum_consecutive_frames=2)

    def update(self, detections, frame, timestamp):
        tracked = self.tracker.update(detections, timestamp=timestamp)
        h, w = frame.shape[:2]
        result = []
        for box, score, cls, tid in zip(tracked.xyxy, tracked.confidence, tracked.class_id, tracked.tracker_id):
            result.append(dict(box=(box/[w, h, w, h]).tolist(), score=float(score), target='person' if cls == 0 else 'vehicle', label={0:'person',2:'car',5:'bus',7:'truck'}[int(cls)], id=int(tid)))
        return result


class ViewGuard:
    """Reject dark/blank views and large background motion before applying stationary rules."""
    def __init__(self):
        self.previous = None
        self.stable_since = None

    def check(self, frame, now):
        gray = cv2.cvtColor(cv2.resize(frame, (320, 180)), cv2.COLOR_BGR2GRAY)
        if gray.mean() < 15 or gray.std() < 5:
            self.previous, self.stable_since = gray, None
            return False
        moved = False
        if self.previous is not None:
            points = cv2.goodFeaturesToTrack(self.previous, 100, .02, 12)
            if points is not None and len(points) >= 10:
                dest, status, _ = cv2.calcOpticalFlowPyrLK(self.previous, gray, points, None)
                good = status.ravel() == 1
                if good.sum() >= 10:
                    transform, inliers = cv2.estimateAffinePartial2D(points[good], dest[good], method=cv2.RANSAC)
                    if transform is not None and inliers.sum() >= 8:
                        shift = np.linalg.norm(transform[:, 2])
                        scale = np.linalg.norm(transform[0, :2])
                        rotation = abs(np.arctan2(transform[1, 0], transform[0, 0]))
                        moved = shift > 2 or abs(scale-1) > .015 or rotation > .015
            if np.mean(cv2.absdiff(gray, self.previous)) > 55:
                moved = True
        self.previous = gray
        if moved:
            self.stable_since = now
        elif self.stable_since is None:
            self.stable_since = now
        return self.stable_since is not None and now-self.stable_since >= 2
