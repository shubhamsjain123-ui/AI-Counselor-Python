import torch
import numpy as np

def point_form(boxes):
    return torch.cat((boxes[:, :2] - boxes[:, 2:]/2,
                      boxes[:, :2] + boxes[:, 2:]/2), 1)

def center_size(boxes):
    return torch.cat((boxes[:, 2:] + boxes[:, :2])/2,
                      boxes[:, 2:] - boxes[:, :2], 1)

def intersect(box_a, box_b):
    A = box_a.size(0)
    B = box_b.size(0)
    max_xy = torch.min(box_a[:, 2:].unsqueeze(1).expand(A, B, 2),
                       box_b[:, 2:].unsqueeze(0).expand(A, B, 2))
    min_xy = torch.max(box_a[:, :2].unsqueeze(1).expand(A, B, 2),
                       box_b[:, :2].unsqueeze(0).expand(A, B, 2))
    inter = torch.clamp((max_xy - min_xy), min=0)
    return inter[:, :, 0] * inter[:, :, 1]

def jaccard(box_a, box_b):
    inter = intersect(box_a, box_b)
    area_a = ((box_a[:, 2]-box_a[:, 0]) *
              (box_a[:, 3]-box_a[:, 1])).unsqueeze(1).expand_as(inter)
    area_b = ((box_b[:, 2]-box_b[:, 0]) *
              (box_b[:, 3]-box_b[:, 1])).unsqueeze(0).expand_as(inter)
    union = area_a + area_b - inter
    return inter / union

def nms(boxes, scores, overlap=0.5, top_k=200):
    keep = torch.empty(scores.size(0), dtype=torch.long)
    if boxes.numel() == 0:
        return keep[:0]
    count = 0
    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 2]
    y2 = boxes[:, 3]
    area = torch.mul(x2 - x1, y2 - y1)
    v, idx = scores.sort(0)
    idx = idx[-top_k:]
    while idx.numel() > 0:
        i = idx[-1]
        keep[count] = i
        count += 1
        if idx.size(0) == 1:
            break
        idx = idx[:-1]
        xx1 = torch.index_select(x1, 0, idx).clamp(min=x1[i].item())
        yy1 = torch.index_select(y1, 0, idx).clamp(min=y1[i].item())
        xx2 = torch.index_select(x2, 0, idx).clamp(max=x2[i].item())
        yy2 = torch.index_select(y2, 0, idx).clamp(max=y2[i].item())
        w = torch.clamp(xx2 - xx1, min=0.0)
        h = torch.clamp(yy2 - yy1, min=0.0)
        inter = w * h
        rem_areas = torch.index_select(area, 0, idx)
        union = (rem_areas - inter) + area[i]
        IoU = inter / union
        idx = idx[IoU.le(overlap)]
    return keep[:count]
