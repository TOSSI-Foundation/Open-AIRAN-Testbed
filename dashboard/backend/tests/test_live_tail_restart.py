import tempfile
import threading
import time
import unittest
from pathlib import Path

from app.sionna_bridge import LiveChannel

LINE = "[live] t=1792170659.574  seq={}  pos=(-47,86)  gain=  -80.0dB  applied=- 0.0dB  paths= 7  trace= 4288ms\n"


class TailRestart(unittest.TestCase):
    def test_truncated_file_is_read_from_the_start(self):
        out = Path(tempfile.mkdtemp()) / "channel.out"
        out.write_text("".join(LINE.format(i) for i in range(900, 941)))
        lc = LiveChannel()
        lc.OUT_FILE, lc.remote = out, {"target": "x"}
        stop = threading.Event()
        threading.Thread(target=lc._tail, args=(stop, True), daemon=True).start()
        try:
            for _ in range(50):
                if lc.seq == 940:
                    break
                time.sleep(0.05)
            self.assertEqual(lc.seq, 940)
            out.write_text(LINE.format(0) + LINE.format(1))
            for _ in range(50):
                if lc.seq == 1:
                    break
                time.sleep(0.05)
            self.assertEqual((lc.seq, len(lc.samples)), (1, 2))
        finally:
            stop.set()


if __name__ == "__main__":
    unittest.main()
