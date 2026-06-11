"""
test_concurrent_save.py — proves Part 2 (the _data_lock fix) closes the
lost-update race in monitor.py.

It points parse_analysis at a throwaway temp dir, seeds a project with N scenes
all `pending`, then has N threads each flip a DISTINCT scene to `done` at the
same time:

  * NAIVE (no lock, the pre-fix behaviour) — load->modify->save with a widened
    window. Concurrent writers clobber each other -> some flags are LOST.
  * LOCKED — the real monitor.update_scene(), now guarded by _data_lock.
    Every flag must survive.

Stdlib only. Run:  py tests/test_concurrent_save.py
"""

import json
import sys
import tempfile
import threading
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

import parse_analysis as pa

N = 30  # scenes / concurrent writers


def _seed(tmp: Path):
    """Redirect parse_analysis to tmp and write a fresh project with N pending scenes."""
    pa.DATA_DIR = tmp
    pa.CONTENTS_FILE = tmp / "contents.json"
    pa.BACKUP_FILE = tmp / "contents.json.bak"
    pa.LOCK_FILE = tmp / "contents.json.lock"
    project = {
        "id": "reel_9999",
        "page": "test-page",
        "scenes": [{"scene_num": i, "image_status": "pending"} for i in range(1, N + 1)],
    }
    pa.save_contents([project])


def _count_done(field="image_status"):
    data = pa.load_contents()
    return sum(1 for s in data[0]["scenes"] if s.get(field) == "done")


def _run(update_fn):
    barrier = threading.Barrier(N)

    def worker(scene_num):
        barrier.wait()  # release all threads at once -> maximise contention
        update_fn("reel_9999", scene_num, image_status="done")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(1, N + 1)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return _count_done()


def _naive_update_scene(pid, scene_num, **kwargs):
    """Pre-fix logic: load->modify->save with NO lock. Widened window so the race
    is reliably visible for the demonstration."""
    try:
        contents = pa.load_contents()
        for p in contents:
            if p["id"] == pid:
                for s in p["scenes"]:
                    if s["scene_num"] == scene_num:
                        s.update(kwargs)
                break
        time.sleep(0.003)  # widen the read-modify-write window
        pa.save_contents(contents)
    except Exception:
        pass  # a crashed save is just another lost update — the point of the demo


def main():
    import monitor  # imported after sys.path set; uses pa.load/save internally

    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)

        # ── Part A: demonstrate the bug (no lock) ──────────────────────────────
        _seed(tmp)
        naive_done = _run(_naive_update_scene)
        naive_lost = N - naive_done
        print(f"NAIVE (no lock):  {naive_done}/{N} flags persisted  "
              f"-> {naive_lost} LOST update(s)")

        # ── Part B: the fix — real monitor.update_scene (RLock-guarded) ────────
        _seed(tmp)
        locked_done = _run(monitor.update_scene)
        print(f"LOCKED (fix):     {locked_done}/{N} flags persisted  "
              f"-> {N - locked_done} lost")

        print("-" * 56)
        ok = True
        if locked_done != N:
            print(f"FAIL: locked path lost {N - locked_done} update(s) — race NOT fixed")
            ok = False
        else:
            print("PASS: locked path preserved every concurrent update.")
        if naive_lost == 0:
            print("NOTE: naive path happened to lose none this run (timing); "
                  "the locked guarantee above is what matters.")
        else:
            print(f"Confirmed: without the lock, {naive_lost} update(s) were silently lost.")

        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
