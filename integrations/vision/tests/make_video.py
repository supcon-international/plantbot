"""Deterministic test feed: public-domain person photograph plus a synthetic display."""
import sys
from pathlib import Path
import cv2
import numpy as np
image=np.full((512,1024,3),230,np.uint8)
image[:,:512]=cv2.imread(str(Path(__file__).parent/'fixtures/astronaut.png'))
cv2.putText(image,'85.2 C',(560,260),cv2.FONT_HERSHEY_SIMPLEX,2.5,(20,20,20),4)
writer=cv2.VideoWriter(sys.argv[1],cv2.VideoWriter_fourcc(*'mp4v'),10,(1024,512))
for _ in range(1200):writer.write(image)
writer.release()
