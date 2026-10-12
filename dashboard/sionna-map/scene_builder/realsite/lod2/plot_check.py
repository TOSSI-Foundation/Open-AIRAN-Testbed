import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
d = np.load(sys.argv[1])
fig, ax = plt.subplots(figsize=(16, 11))
sc = ax.scatter(d["u"], d["v"], c=d["e"], s=3, cmap="coolwarm", vmin=-3, vmax=3)
plt.colorbar(sc, ax=ax, label="model - LiDAR (m); red = model too high, blue = too low")
ax.set_xticks(np.arange(-56, 52, 2)); ax.set_yticks(np.arange(-38, 38, 2)); ax.tick_params(labelsize=7)
ax.grid(alpha=0.3); ax.set_aspect("equal"); ax.set_title(sys.argv[2] if len(sys.argv) > 2 else "")
plt.tight_layout(); plt.savefig(sys.argv[1].replace(".npz", ".png"), dpi=70)
