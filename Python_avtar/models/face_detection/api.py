import os
import torch
import cv2
import numpy as np
from .sfd_detector import s3fd
from .box_utils import nms

class FaceDetector:
    def __init__(self, device='cpu', weights_path=None):
        self.device = device
        self.s3fd_model = None
        self.haar_cascade = None

        if weights_path and os.path.exists(weights_path):
            try:
                print(f"[FaceDetector] Loading S3FD face detector from {weights_path}...")
                model = s3fd()
                state_dict = torch.load(weights_path, map_location=device)
                model.load_state_dict(state_dict)
                model.to(device)
                model.eval()
                self.s3fd_model = model
                print("[FaceDetector] S3FD model successfully loaded.")
            except Exception as e:
                print(f"[FaceDetector] Warning: Could not load S3FD ({e}). Falling back to OpenCV Cascade.")

        if self.s3fd_model is None:
            cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
            self.haar_cascade = cv2.CascadeClassifier(cascade_path)
            print("[FaceDetector] Initialized OpenCV Haar Face Detector fallback.")

    def detect_faces(self, image_bgr, conf_threshold=0.7):
        """
        Detects faces in BGR image.
        Returns list of bounding boxes: [[x1, y1, x2, y2], ...] sorted by score/confidence.
        """
        h, w = image_bgr.shape[:2]

        if self.s3fd_model is not None:
            # S3FD inference requires RGB with mean subtraction [104, 117, 123]
            img_rgb = image_bgr[..., ::-1]
            img_sub = img_rgb.astype(np.float32) - np.array([104.0, 117.0, 123.0], dtype=np.float32)
            img_t = torch.from_numpy(img_sub.transpose((2, 0, 1))).unsqueeze(0).float().to(self.device)

            with torch.no_grad():
                olist = self.s3fd_model(img_t)

            for i in range(len(olist) // 2):
                olist[i * 2] = torch.softmax(olist[i * 2], dim=1)

            boxes = self._parse_s3fd(olist, h, w, conf_threshold)
            if len(boxes) > 0:
                return boxes

        # Default fallback: Center face crop
        cy, cx = int(h * 0.35), int(w * 0.5)
        size_w = int(w * 0.35)
        size_h = int(h * 0.45)
        return [[max(0, cx - size_w // 2), max(0, cy - size_h // 2),
                 min(w, cx + size_w // 2), min(h, cy + size_h // 2)]]

    def _decode(self, loc, priors, variances=[0.1, 0.2]):
        boxes = torch.cat((
            priors[:, :2] + loc[:, :2] * variances[0] * priors[:, 2:],
            priors[:, 2:] * torch.exp(loc[:, 2:] * variances[1])), 1)
        boxes[:, :2] -= boxes[:, 2:] / 2
        boxes[:, 2:] += boxes[:, :2]
        return boxes

    def _parse_s3fd(self, olist, h, w, thresh):
        bboxlist = []
        for i in range(len(olist) // 2):
            ocls, oreg = olist[i * 2], olist[i * 2 + 1]
            stride = 2**(i + 2)
            poss = zip(*np.where(ocls[0, 1, :, :].cpu().numpy() > thresh))
            for hindex, windex in poss:
                axc, ayc = stride / 2.0 + windex * stride, stride / 2.0 + hindex * stride
                score = ocls[0, 1, hindex, windex].item()
                loc = oreg[0, :, hindex, windex].contiguous().view(1, 4)
                priors = torch.Tensor([[axc, ayc, stride * 4.0, stride * 4.0]])
                box = self._decode(loc, priors)
                x1, y1, x2, y2 = box[0].cpu().numpy()
                x1 = max(0, min(w, x1))
                y1 = max(0, min(h, y1))
                x2 = max(0, min(w, x2))
                y2 = max(0, min(h, y2))
                bboxlist.append([x1, y1, x2, y2, score])

        if len(bboxlist) == 0:
            return []

        bboxlist = np.array(bboxlist)
        # NMS
        x1, y1, x2, y2, scores = bboxlist[:, 0], bboxlist[:, 1], bboxlist[:, 2], bboxlist[:, 3], bboxlist[:, 4]
        areas = (x2 - x1 + 1) * (y2 - y1 + 1)
        order = scores.argsort()[::-1]

        keep = []
        while order.size > 0:
            idx = order[0]
            keep.append(idx)
            xx1 = np.maximum(x1[idx], x1[order[1:]])
            yy1 = np.maximum(y1[idx], y1[order[1:]])
            xx2 = np.minimum(x2[idx], x2[order[1:]])
            yy2 = np.minimum(y2[idx], y2[order[1:]])
            w_box = np.maximum(0.0, xx2 - xx1 + 1)
            h_box = np.maximum(0.0, yy2 - yy1 + 1)
            inter = w_box * h_box
            ovr = inter / (areas[idx] + areas[order[1:]] - inter)
            inds = np.where(ovr <= 0.3)[0]
            order = order[inds + 1]

        kept_boxes = bboxlist[keep]
        # Filter detections with high confidence
        high_conf = [b for b in kept_boxes if b[4] >= thresh]
        if not high_conf:
            high_conf = kept_boxes[:1]

        # If multiple anchors on the same face (e.g. adjacent horizontal anchors with score > 0.85)
        primary_candidates = [b for b in high_conf if b[4] > 0.85]
        if len(primary_candidates) > 1:
            fx1 = min(b[0] for b in primary_candidates)
            fy1 = min(b[1] for b in primary_candidates)
            fx2 = max(b[2] for b in primary_candidates)
            fy2 = max(b[3] for b in primary_candidates)
            face_w = fx2 - fx1
            face_h = fy2 - fy1
            fx2 = min(w, fx2 + int(face_w * 0.25))
            fy2 = min(h, fy2 + int(face_h * 0.6))
            return [[int(fx1), int(fy1), int(fx2), int(fy2)]]

        # Single primary box
        b = high_conf[0]
        face_w = b[2] - b[0]
        face_h = b[3] - b[1]
        fx2 = min(w, b[2] + int(face_w * 0.25))
        fy2 = min(h, b[3] + int(face_h * 0.6))
        return [[int(b[0]), int(b[1]), int(fx2), int(fy2)]]
