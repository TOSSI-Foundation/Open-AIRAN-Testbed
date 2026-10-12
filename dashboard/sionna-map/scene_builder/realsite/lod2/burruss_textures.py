import os
import cv2
import numpy as np

D = os.path.expanduser("~/realsite/lod2/photos/burruss")
img = cv2.imread(os.path.join(D, "front.png"))
S = img.shape[1] / 2000.0

QUADS = {
    "tower_front": ([(707, 255), (1262, 255), (1290, 1395), (703, 1395)], (512, 1024)),
    "turret": ([(757, 178), (918, 178), (918, 255), (757, 255)], (256, 128)),
    "wing_bay": ([(1428, 862), (1600, 864), (1600, 1343), (1428, 1340)], (256, 712)),
    "stone": ([(762, 190), (915, 190), (915, 250), (762, 250)], (384, 150)),
}
sheet = []
for name, (q, (w, h)) in QUADS.items():
    src = np.float32([[x * S, y * S] for x, y in q])
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    M = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(img, M, (w, h), flags=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(D, f"{name}.jpg"), out, [cv2.IMWRITE_JPEG_QUALITY, 88])
    sheet.append(cv2.resize(out, (int(w * 300 / h), 300)))
    print(name, out.shape)
cv2.imwrite(os.path.join(D, "contact.jpg"), np.hstack(sheet))
