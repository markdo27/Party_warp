"""Builds a Y4M clip for Chrome's fake camera from a still synthetic face (no real person).

Timeline (30 fps, 10 s, loops in Chrome):
  0-2 s  still face
  2-5 s  roll +/-15 deg, slide and zoom (tests that patches follow the face)
  5-7 s  face gone, plain wall (tests holding -> lost)
  7-10 s face back (tests re-acquire with the same seed)
Usage: python scripts/fake-camera.py e2e/fixtures/synthetic-face.jpg test-results/fake-camera.y4m
"""
import math
import sys

import cv2
import numpy as np

W, H, FPS, SECONDS = 640, 480, 30, 10


def frame_at(face, wall, t):
    if 5.0 <= t < 7.0:
        return wall
    if 2.0 <= t < 5.0:
        k = (t - 2.0) / 3.0
        angle = 15.0 * math.sin(k * 2 * math.pi)
        scale = 1.0 + 0.15 * math.sin(k * math.pi)
        dx = 40.0 * math.sin(k * 2 * math.pi)
        m = cv2.getRotationMatrix2D((W / 2, H / 2), angle, scale)
        m[0, 2] += dx
        return cv2.warpAffine(face, m, (W, H), borderMode=cv2.BORDER_REPLICATE)
    return face


def main(src, dst):
    face = cv2.resize(cv2.imread(src), (W, H), interpolation=cv2.INTER_AREA)
    wall = np.full_like(face, face[10:40, 10:40].reshape(-1, 3).mean(axis=0).astype(np.uint8))
    with open(dst, "wb") as out:
        out.write(f"YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n".encode())
        for i in range(FPS * SECONDS):
            yuv = cv2.cvtColor(frame_at(face, wall, i / FPS), cv2.COLOR_BGR2YUV_I420)
            out.write(b"FRAME\n")
            out.write(yuv.tobytes())


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
